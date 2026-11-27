# Live Data After Convex

Status: **implemented in Phase 4** ([task 14](../tasks/14_Backend_Migration.md#phase-4-results-2026-11-25)) on the new backend and the web app; the Worker client still talks to Convex until Phase 5, so the Worker side of inboxes and ACP appends is exercised only by server tests. Part of the [backend migration](../Backend_Migration.md). This guide supersedes the Convex-based relay designs in [Live sessions](../Radium_Chatroom/Live_Sessions.md) (proposed, never built) and the transport parts of [ACP transport](../ACP/Transport.md) and [Worker Convex transport](../Worker/Convex_Transport.md). Their product behavior is kept: warm/cold sessions, epochs, snapshots, history pages, first answer wins, commands that run once.

## Where Data Lives

Rule: **Postgres** is the record, **Valkey** holds what may expire or be rebuilt, **Durable Streams** carries what someone watches or waits on. A table that only existed to move bytes between processes doesn't survive the migration.

| Data (current tables)                                                                                                                                                                                                                                                                                                                                                                | New home                                   | Why                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Workspaces, members, settings, projects, preferences, MCP servers, providers, models, credentials metadata, API keys, ACP agent definitions, ACP agent session catalog, Worker agents and gateway access, Worker identity, E2EE keys/grants/rosters/chat keys, chats, messages, chat members, files, completions, usage, telemetry, notifications, push subscriptions, secrets, auth | Postgres                                   | The record                                                                                                                   |
| `acp_sessions` (lifecycle, epoch, `cooled_epoch`, config, usage)                                                                                                                                                                                                                                                                                                                     | Postgres                                   | Durable lifecycle and the epoch fence; `warm` moves to Valkey                                                                |
| `acp_commands`, `acp_interactions`, `worker_tasks`, `worker_chat_calls`                                                                                                                                                                                                                                                                                                              | Postgres, with a doorbell on a stream      | They hold durable decisions: claimed once, first answer wins, fenced completion. Delivery no longer depends on subscriptions |
| `chat_frames`, `acp_streams`                                                                                                                                                                                                                                                                                                                                                         | Durable Streams (one stream per ACP epoch) | Bulk ephemeral content; sequence and dedupe come from the protocol                                                           |
| Built-in reply chunks (today only in the sender's HTTP response)                                                                                                                                                                                                                                                                                                                     | Durable Streams (one stream per run)       | Every Tab and device sees in-flight replies; reload resumes                                                                  |
| `chat_viewers`, `acp_sessions.warm`                                                                                                                                                                                                                                                                                                                                                  | Valkey sorted sets                         | Presence with expiry                                                                                                         |
| `worker_presence`                                                                                                                                                                                                                                                                                                                                                                    | Valkey key with TTL                        | Presence with expiry                                                                                                         |
| `codemode_interactions`                                                                                                                                                                                                                                                                                                                                                              | Valkey hash with TTL, answer by `SET NX`   | 180-second lifetime; losing one fails the prompt, as a timeout would                                                         |
| `worker_auth_challenges`, `e2ee_device_recovery`                                                                                                                                                                                                                                                                                                                                     | Valkey with TTL, consumed by `GETDEL`      | Single use, short lived                                                                                                      |
| `routing_cursors`, `routing_cooldowns`, `routing_sessions`, `subscription_state` rate-limit buckets                                                                                                                                                                                                                                                                                  | Valkey                                     | Hot counters and affinity; losing them resets routing fairness and nothing else                                              |
| `subscription_state` sessions                                                                                                                                                                                                                                                                                                                                                        | Postgres                                   | A lost ChatGPT subscription session forces re-login                                                                          |
| Rate-limiter and Better Auth rate-limit tables                                                                                                                                                                                                                                                                                                                                       | Valkey                                     | Counters                                                                                                                     |
| Legacy bridge tables and E2EE migration bookkeeping                                                                                                                                                                                                                                                                                                                                  | Not imported                               | [Narrow first](Convex_Import.md#preconditions)                                                                               |

## Durable Streams

The stream server (`durable-streams-server`, the Caddy plugin build, or Electric Cloud) is internal. Only the backend holds `STREAMS_TOKEN`, and browsers and Workers reach streams through the backend's authorizing proxy. Streams use JSON mode (`application/json`), so every append is one message and reads return message arrays. The backend writes through `IdempotentProducer` from `@durable-streams/client` (batching with `lingerMs: 300`, producer id per writer and run or epoch), so retries never duplicate.

**Expiry is not deletion.** The Caddy plugin hides a stream once its TTL or `Stream-Expires-At` passes, but leaves its bytes in `data_dir` until the path is deleted or created again, and it implements no retention ([Phase 0](../tasks/14_Backend_Migration.md#phase-0-results-2026-11-21)). Expiry can only be set when a stream is created. So the backend `DELETE`s every stream it creates once it is no longer needed; TTLs are only a backstop for streams the backend loses track of.

| Stream path                  | Writer                             | Readers                       | Lifetime                                                                                                     |
| ---------------------------- | ---------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `u/<user>/events/<gen>`      | backend                            | that user's Tabs and devices  | rotated daily; old generation closed with a `rotate` message, deleted a day later                            |
| `w/<workspace>/events/<gen>` | backend                            | workspace owner and members   | rotated daily, as above                                                                                      |
| `c/<chat>/runs/<run>`        | backend (`/api/chat`)              | anyone who can read the chat  | `Stream-TTL: 600`; closed at run end; deleted with its `chat_runs` row by retention 10–15 min after run end, or with the chat |
| `c/<chat>/acp/<epoch>`       | the chat's Worker, via the backend | anyone who can read the chat  | `Stream-TTL: 300` (sliding); first message is the epoch capsule; deleted when the session cools, 60 s after the epoch is superseded, with the chat, or on Worker revocation |
| `c/<chat>/signals/<gen>`     | backend                            | backend request handlers only | rotated, as above                                                                                            |
| `k/<worker>/inbox/<gen>`     | backend                            | that Worker only              | rotated daily, as above                                                                                      |

`<gen>` exists because the protocol says a deleted stream path should not be reused. The current generation of each rotating stream is kept in Valkey (`streams:gen:<scope>`, with `streams:live`/`streams:retired` sorted sets for the hourly `streams:rotate` task) and returned by a tRPC query (`events.streams()` for browsers, `worker.inbox()` for Workers); the first reader creates it, so a scope nobody reads has no stream and writers skip it. A reader that hits a closed stream, `404` or `410` asks again.

### Stream Proxy

`GET /api/streams/<path>` resolves the actor (session or Worker JWT), maps the path to a single authorization check, and only then forwards the request:

- `u/<user>`: the session's own user;
- `w/<workspace>`: owner or direct member (the same check as `workspaceProcedure`);
- `c/<chat>/runs|acp`: the chatroom access function used by `chats.get`, including personal-chat privacy;
- `k/<worker>`: the Worker JWT's own id, with identity epoch and revocation checked.

Only protocol parameters (`offset`, `live`, `cursor`) are forwarded. Refusals answer like a missing stream (`404`; `401` without any session or token), and backend-only streams (`c/<chat>/signals`) are never readable. Long-poll and SSE responses are piped through unchanged, minus `content-encoding` and `content-length` (`fetch` has already decompressed the body) and the stream server's permissive CORS headers, with `cache-control: no-store`. Live SSE connections are recycled by the server (`sse_reconnect_interval`), and every reconnect passes the proxy again, so access revocation takes effect within one interval.

The stream server sends no SSE keepalives, so a quiet stream looks idle to every hop:

- Stream routes turn off the runtime's idle timeout per request (on Bun, `server.timeout(req, 0)`; Bun's default 10 s cut every quiet SSE read in Phase 0). The web origin's `/api/*` forwarder must do the same.
- `@durable-streams/client` doesn't reconnect after a mid-stream network error (`ECONNRESET` ended the reader). Browser and Worker readers wrap it in resume-from-last-offset with backoff.

`POST /api/streams/c/<chat>/acp/<epoch>` is the only append path open to a client, and only to the chat's bound Worker (`src/acp/live.ts`). It checks, in order: a Worker token (`401`), the chat's bound Worker (`404` otherwise), the epoch fence (current, warm, above `cooled_epoch`; Valkey-cached for 10 s and dropped on `startEpoch`, cooling and chat deletion; `409 ACP_STALE_EPOCH`), a JSON body bounded before parsing, idempotent-producer headers with `Producer-Id` exactly `<worker>:<epoch>` (`ACP_PRODUCER_REQUIRED`), and each frame (at most `ACP_FRAMES_PER_APPEND`, integer `seqFrom ≤ seqTo`, sealed base64url payload within `ACP_SEALED_FRAME_BYTES`; anything else is `ACP_PLAINTEXT_REFUSED`). Frames are re-serialized before forwarding; only the producer headers and `Stream-Closed` go upstream. The protocol deduplicates retries and orders appends, which replaces `acp_streams.nextSeq` and the `ACP_FRAME_GAP` bookkeeping. Browsers never append; their writes are tRPC mutations.

## Invalidation Events

When data that other Tabs, devices or Workers display changes, the backend appends a small event after the change succeeds (`src/streams/events.ts`):

```json
{ "topic": "chats", "ids": ["…"] }
```

- Events carry topic names and ids, never content. A workspace stream never names a personal chat. Changes to personal chats go to the creator's user stream only, changes to shared chats go to the creator's and each member's user stream, and only `workspace`-scoped chats go to the workspace stream. A scope or membership change also tells the audience the chat had before.
- **Browser mutations publish generically.** The `sessionProcedure` middleware publishes after every successful mutation: the topic is the router name (`chats`, `providers`, …), the chat's audience gets `ids: [chat]`, Project and workspace changes go to the workspace stream for member-visible routers (`workspaces`, `projects`, `providers`, `models`, `tools`, `chatroom`, `e2ee`) and to the owner's user stream for owner-only ones, and anything else goes to the caller's own stream (their other Tabs). `logging`, `chatFiles` and the `acp.watch` heartbeat publish nothing. Membership changes also tell the added or removed account. Non-browser writers publish explicitly: Worker ACP mutations (the chat's `acp` viewers), a Worker coming online (`workers`, to the owner), run start and end (`chats`), notifications (`notifications`, from the seal job).
- Browsers map a topic to the tRPC router's query keys (narrowed to queries naming one of `ids`) and call `invalidateQueries`; TanStack Query refetches only what is mounted (`apps/web/src/lib/live-events.ts`). Each stream starts at offset `now`; on `rotate`, close, `404` or `410` the reader fetches the new generation and invalidates everything once.
- Publishing is best effort after commit: a lost event means a stale view until the next refetch on focus or reconnect, never lost data, and a failed publish never fails the change. Events that drive correctness (Worker commands, tasks, answers) are doorbells for rows that the reader always re-reads, so a lost doorbell is recovered by the reader's periodic resync (Workers resync every topic on reconnect and every 60 s).

**One live reader per browser.** Browsers allow 6 HTTP/1.1 connections per origin, shared by every Tab, and each live read holds one (Phase 4 browser check: one Tab with Electric held 7 and a second Tab could not load). So the Tabs of one user elect a leader with Web Locks (`radium-live:<user>`); only the leader reads the event streams (in a Web Worker, so a hidden leader keeps reading) and syncs Electric shapes, and it relays events, collection snapshots and changes to the other Tabs over `BroadcastChannel` (`apps/web/src/lib/live-relay.ts`). Tabs announce which workspaces and shapes they show; the leader reads the union and drops a Tab whose own lock is gone. A new leader invalidates everything once, since it may have missed events. A browser therefore holds one user stream plus one stream per shown workspace, however many Tabs are open; per-Tab reads remain only for an open ACP Session and an in-flight reply. Without Web Locks every Tab reads for itself.

## Electric Collections (Optional)

When `ELECTRIC_URL` is configured and the page was served over HTTP/2 or HTTP/3, selected row-shaped data syncs into TanStack DB collections through Electric (each shape is a held long-poll, which HTTP/1.1 cannot afford; the web app checks `nextHopProtocol`). Otherwise the same collections are TanStack Query collections filled by tRPC and refreshed by invalidation events. Each collection is defined once in `apps/web/src/lib/collections/`; the factory picks the leader-relayed Electric source or `queryCollectionOptions`, so the components using `useLiveQuery` stay the same.

- **Shapes are server-defined.** `GET /api/shapes/:collection` sets `table`, `columns` and a parameterized `where` from the session (Electric's [proxy auth pattern](https://electric.ax/docs/sync/guides/auth)), passing through only Electric protocol parameters. Each live request passes the proxy, so revoked access stops at the next poll.
- **Writes stay tRPC mutations; collections are read-only views.** Phase 4 keeps the existing mutations and adds no optimistic state, so no `txid` reconciliation is needed: with Electric the committed row syncs in, with the query source the mutation's invalidation event refetches. If optimistic collection writes are added later, the mutation returns `pg_current_xact_id()::xid::text` and the handler awaits `collection.utils.awaitTxId(txid)` (Electric) or awaits `collection.utils.refetch()` and returns `{ refetch: false }` (query source; leaving the refetch to run after the handler drops the optimistic state first and the row flickers back, Phase 0).
- **Eligible collections** have a filter that is a plain predicate on the row itself:

| Collection          | Shape                                                                                          |
| ------------------- | ---------------------------------------------------------------------------------------------- |
| `notifications`     | `user_id = $me`                                                                                |
| `userPreferences`   | `user_id = $me`                                                                                |
| `projects`          | `workspace = $ws` (after the workspace check)                                                  |
| `projectFolders`    | `workspace = $ws`, owners only (`project_folders.workspace` exists for this predicate)          |
| `workspaceSettings` | `workspace = $ws`; telemetry, routing and limit columns excluded for members                   |
| `acpSession`        | `chat = $chat` (after the chat access check and only for ACP chats); overlays `acp.getSession` |

The client sends only Electric protocol parameters and the shape's selector (`workspace` or `chat`); the on-demand `subset__*` parameters are not forwarded, since a client-written predicate could probe excluded columns. Responses are `cache-control: private, no-store`. Values the tRPC read derives per caller are derived client-side from the rows: notification text and paths from `contracts`, a Project's `canManage` (creator or owner), and the default and title models, which are dropped when the workspace no longer offers them.

Not eligible for now: the chat list, whose visibility depends on scope and `chat_members`; telemetry and usage (owner-only aggregates); anything with secrets. These stay on tRPC + invalidation. Electric needs `wal_level=logical` and a role with `REPLICATION`; the reference compose file enables both.

**Migrations must not drop and recreate an Electric-synced table.** In Phase 0 a recreated table silently left `electric_publication_default` while Electric kept serving its shape: no live changes, and `awaitTxId` timed out. Change synced tables with `ALTER`, and if one must be replaced, the migration's release notes include an Electric shape reset.

## Built-in Chat Runs

This replaces the [Live sessions](../Radium_Chatroom/Live_Sessions.md) proposal with the same behavior and none of the frame tables.

```mermaid
sequenceDiagram
    autonumber
    participant T1 as Tab 1 (sender)
    participant API as /api/chat
    participant PG as Postgres
    participant DS as Durable Streams
    participant T2 as Tab 2 / phone

    T1->>API: POST {chat, messages, recipientKey}
    API->>PG: admit run (409 if active), save user message, chat_runs row
    API->>DS: create c/<chat>/runs/<run>
    API-->>T1: 201 {streamUrl} + Location
    API->>DS: (after the response) chat event
    DS-->>T2: invalidation → chats.get shows the active run
    T1->>DS: read from offset -1 (via proxy)
    T2->>DS: read from offset -1 (via proxy)
    loop generation
        API->>DS: append UI chunk batches
    end
    T2->>API: chats.stop (tRPC) → Valkey stop flag
    API->>PG: onEnd: save messages, finish run
    API->>DS: close
    API->>PG: retention (run end + 10 min): delete run stream, then the row
```

- **Admission**: `chat_runs` has a partial unique index (one active run per chat). A second sender gets `409` and re-seeds, as Live Sessions planned.
- **Everyone is a viewer.** `/api/chat` returns `201` with the stream location (`Location` and `{streamUrl}`) instead of the stream body. The sender reads the same stream as every other Tab through `ChatRunTransport` (`apps/web/src/lib/chat-run-transport.ts`, an AI SDK `HttpChatTransport`), so there's one code path. A reloaded Tab, or another Tab or device that sees `activeStream` on `chats.get`, asks `GET /api/chat/<chat>/stream` (`200` with the location, `204` when idle) and replays from offset `-1` (`resumeStreamIsReplay`). `@durable-streams/aisdk-transport` was not used: it has no resume of a run another Tab started.
- **The prompt rides along.** The turn is saved only when the run ends, so the stream's first chunk is a transient `data-radium-prompt` part carrying the user message; a Tab that attaches late inserts it before the reply. It is plaintext like the reply and deleted with the stream.
- **Stop from any Tab**: `chats.stop` (the sender or a chat manager) sets `chat:stop:<run>` in Valkey; the generator checks it every 500 ms. No database write. Closing the sender's Tab does not stop the run. Deleting the chat stops its run the same way.
- **Detached runs** work on long-lived presets: generation is driven by the server (`runtime.defer`), not the sender's connection. On serverless presets the run stays bound to the request ([presets](Runtime.md#long-lived-vs-serverless-presets)).
- **Lost runs**: `chat_runs.lease_at` renewed every 15 s; the retention job fails active runs with a stale lease and closes their streams with an error chunk, so readers end. A chat is replying exactly while it has an `active` run; `chats.get().activeStream` reports that.
- Approvals, questions and Code Mode prompts end or pause the stream exactly as today; answers are tRPC mutations.

## ACP Sessions

- **Viewers**: `acp.watch({chat, tab})` (every 60 s while a Session Tab is visible) runs one Valkey script: `ZADD acp:viewers:<chat> <now> <tab>` and, when the chat is cold, the warm admission (`ZCARD` against the 64-session cap, `ZADD acp:warm:<worker> <now> <chat>`). On a cold → warm transition the backend rings the Worker's inbox (`warm`) and publishes an `acp` event. A prompt also warms (or refreshes) the chat.
- **Epochs**: the Worker creates `c/<chat>/acp/<epoch>` through the backend: `worker.acp.startEpoch` advances `acp_sessions.epoch` under the session row lock and creates the stream with `Stream-TTL: 300`, writing the Worker-signed epoch capsule as its first message (`{type: "capsule", chatEpoch, capsule, signature}`, one producer-deduplicated append). An exact retry is compared against that message; other capsule bytes are `ACP_FRAME_CONFLICT`. The superseded epoch's stream is deleted by an outbox job 60 s later. Then the Worker appends the snapshot, live ops and history pages. Frame payloads keep today's format (`{seqFrom, seqTo, kind, payload}`, sealed bytes base64url) because the AAD binds `epoch:seqFrom`; stream offsets are only the read cursor. `acp.getSession` returns the open epoch's `stream`, which the Session Tab reads over SSE and decrypts with the capsule.
- **Cooling**: the `acp:cool` task (every minute, leased) walks `acp:warm-workers` with `SSCAN` (cursor kept between runs), takes chats warmed and last viewed more than 5 minutes ago out of `acp:warm:<worker>`, sets `cooled_epoch` in Postgres, queues the epoch stream's deletion, rings the Worker (`warm`) and publishes `acp`. At most 256 chats per run. Even if a stream is missed, its sliding TTL hides it once nobody reads or writes.
- **Rollover** at 1 MiB, **history pages**, **snapshot sizes** and **fragments** are unchanged ([ACP transport](../ACP/Transport.md)).
- **Commands and interactions** stay Postgres rows with the same claim and answer rules. Browser mutations ring the bound Worker (`commands`, `answers`, `warm`; the table is `WORKER_DOORBELLS` in `src/streams/events.ts`); Worker mutations publish `acp` to the chat's viewers.

## Workers

```mermaid
sequenceDiagram
    participant B as Backend
    participant DS as k/<worker>/inbox
    participant W as Worker
    W->>B: worker.inbox() (tRPC, JWT)
    B-->>W: {stream}
    W->>DS: GET live=sse (via proxy)
    B->>B: user sends ACP prompt → acp_commands row
    B->>DS: append {topic: "commands"}
    DS-->>W: doorbell
    W->>B: worker.acp.assignedCommands() → claimCommand(id)
```

Topics replace the 9–10 Convex subscriptions one for one: `identity` (`workers.current`; revocation), `trust` (`e2ee.workerTrustState`; any `e2ee` mutation of the workspace), `tasks` (`worker.tasks.assigned`; a new dispatched task), `gateway` (Gateway access and providers), `definitions`, `commands`, `warm`, `answers`. On every (re)connect and every 60 s the Worker refetches all topics, so a missed doorbell costs at most a minute. Presence is `worker.reportPresence` every 20 s, which stamps `presence:<worker>`; a Worker coming back online publishes `workers` to its owner. The online/offline rule (`isWorkerOnline`) is unchanged.

### Worker Tasks And Code Mode Waits

The chat handler no longer polls the database every 500 ms (Worker tasks) or every second (Code Mode). It long-polls `c/<chat>/signals/<gen>` from the offset taken before its first check (`waitForSignal` in `src/streams/signals.ts`), so a signal between the check and the wait is not missed. Completing a Worker task (a fenced Postgres update, also an identical repeat), failing it on revocation, or answering a Code Mode prompt (Valkey `SET NX`) appends `{topic: "task" | "codeMode", ids: [id]}`, and the handler re-reads the row or key. Timeouts (45 s for tasks, 180 s for Code Mode, waited in 30 s steps) are unchanged; `chats.stop` ends a wait at once.

## Notifications

`notifications` rows stay in Postgres (7-day retention). The `notifications.seal` job is queued for every notification; it seals the detail when the recipient has an identity and then rings `u/<user>/events` (`notifications`), so open Tabs read the row once its box is there. Tabs refetch, or receive the row through the Electric collection, and claim it with the conditional update. The push fallback is an outbox job delayed 10 s that sends Web Push only if `seen_at` is still null. Sealing to recipient identity keys is unchanged.

## E2EE On Streams

- ACP epochs carry the same sealed frames and capsule as today. The Worker seals them and the backend never had their plaintext, so they must stay sealed.
- **Built-in runs are plaintext.** The backend already handles this content in plaintext to call the model, by design. The run stream is part of that same transient processing window. It is not persistent storage: retention deletes it 10–15 minutes after the run ends (chat deletion sooner), and the sealed `chat_messages` write at the end of the turn remains the only stored copy. Expiry alone would not do this, because the Caddy store keeps an expired stream's bytes on disk until the path is deleted (Phase 0). Until the deletion, the stream server's data directory holds that content, so it is classified with backend memory: it is excluded from backups and never exported. If it is ever retained longer, sealing runs with the chat key (the ACP capsule pattern) is the fix.
- Invalidation and doorbell events carry no content.
- Updating [E2EE data classification](../E2EE/Data.md) for streams and Valkey is part of the migration.

## Load Profile

Measured in Phase 0 by driving the planned write pattern for one minute against real Postgres, Valkey and Durable Streams: one watched ACP session and a 45 s built-in run (about 25 tokens/s), each with two Tabs. The new backend doesn't exist yet, so the "After" numbers count the operations this design issues, not the overhead of an implementation. The Convex column comes from code (`packages/worker/src/acp/relay.ts` `textFlushMs: 300`, `ACP_VIEWER_HEARTBEAT_MS`, `WORKER_HEARTBEAT_INTERVAL_MS`), not from a measurement.

| Per minute                                  | Convex today                                                                                               | After (measured)                                                                                                                                              |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Watched ACP session, 2 Tabs, streaming text | 200 relay mutations (index read, up to 8 inserts, 1 patch each); `LiveFrames` re-run per viewer: about 400 | 200 stream appends through the proxy; 0 Postgres writes; each Tab read 600 frames over its SSE connection                                                     |
| Each open ACP Tab                           | 1 heartbeat write + `acp_sessions` warm patch                                                              | 1 Valkey `EVAL` (`ZSCORE`/`ZCARD`/`ZADD` inside)                                                                                                              |
| Worker online                               | 3 presence writes; 9–10 live queries                                                                       | 3 Valkey `SET EX`; 1 SSE connection                                                                                                                           |
| Built-in reply, 2 Tabs watching             | not possible (proposed frames: 3–4 inserts/s)                                                              | 141 stream appends (`IdempotentProducer`, `lingerMs: 300`) for 1,117 chunks; 139 Valkey `EXISTS` (stop flag)                                                  |
| Built-in reply, Postgres                    | n/a                                                                                                        | 5 inserts + 4 updates: admission (user message, run, outbox row), outbox row done, 2 lease renewals, end (assistant message, run finished, delete-stream job) |
| Chat handler waiting for a Worker task      | query every 500 ms for up to 45 s                                                                          | one long-poll per 30 s on the chat's signal stream; the tool resolved in milliseconds after the completion in the Phase 4 tests                            |

The stream server's RSS grew by about 0.2 MB over the minute.
