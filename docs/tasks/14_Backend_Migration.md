# 14 Backend Migration (Convex → Bun, Hono, Postgres)

Status: **Phase 0 spikes done (2026-11-21); Phase 1 not started.** Design: [Backend migration](../Backend_Migration.md), with [runtime and layout](../Backend_Migration/Runtime.md), [live data](../Backend_Migration/Live_Data.md) and [Convex import](../Backend_Migration/Convex_Import.md). Branch: `refactor/abandon-convex`.

This is several sessions of work, not one. Each phase ends with the docs updated and its verification recorded here. The Convex backend on `dev` stays the product until the cutover release. The new backend is built beside it and exercised against imported copies of a local deployment, never production data.

Interacts with:

- [11 E2EE](11_E2EE.md): phase 9 cutover must be complete, and custody ended with `endCustody`, on a deployment before it can be imported. The local deployment has cutover done and 2,157 custodial rows left; ending custody there is a Stage 1 step.
- [12 Local models](12_Local_Models.md): its transport is designed in the next PR, which should target Durable Streams rather than the Convex chunk relay it currently describes.
- [09 Workspace operations](09_Workspace_Operations.md): container and compose docs are rewritten in Phase 7 here.
- [Live sessions](../Radium_Chatroom/Live_Sessions.md): superseded by Phase 4.

## Phase 0: Spikes And Last Convex Version

Findings recorded in this file. Every spike runs against real services, not mocks.

1. **Convex export.** On the local deployment: `convex export --include-file-storage`. Record whether component tables (`betterAuth`, `workerIdentity`, `secretStore`), `bytes` values and `_storage.sha256` are present, and the ZIP/JSONL layout. Decide primary vs fallback export ([export](../Backend_Migration/Convex_Import.md#export)).
2. **Durable Streams.** Caddy-plugin server in compose; JSON mode; idempotent producer retry; `Stream-TTL` expiry with and without readers; SSE through a Hono proxy for 10 minutes; whether the server implements retention (decides the `<gen>` rotation details); `@durable-streams/aisdk-transport` resume across Tabs.
3. **Electric.** Shape proxy with server-set `where`, `txid` reconciliation with a TanStack DB electric collection, the same collection switched to a query source.
4. **Bun preset under Nitro.** Hono app as Nitro server entry built with the `bun` preset; `drizzle-orm/bun-sql` transactions and `for update skip locked`; `Bun.RedisClient` scripts and `GETDEL`; `Bun.S3Client` presign against MinIO or Garage; Nitro `scheduledTasks`; build-time driver alias keeping `bun` out of other presets' bundles.
5. **Load.** One watched ACP session and one built-in run across two Tabs: Postgres writes, Valkey ops and stream appends per minute, compared with the Convex function-call counts. Fill in the [load profile](../Backend_Migration/Live_Data.md#load-profile).
6. **Last Convex version**: `migrationStatus` query and maintenance mode, as specified in [two stages](../Backend_Migration/Convex_Import.md#two-stages). Implemented on `dev` before Phase 6.

Acceptance: each spike has a recorded result; designs updated where a result disagrees.

### Phase 0 Results (2026-11-21)

All spikes ran on this workstation against real services. Postgres 18.7, Valkey 9.2 and Electric 1.8.1 ran in Docker. Durable Streams `durable-streams-server` v0.3.0 (the Caddy plugin release binary, checksum verified) and Garage v2.5.0 ran as host binaries. Bun 1.4.4, Node 22. Spike code was throwaway and is not in the repo; the decisions it led to are in the design docs.

**1. Convex export: the primary path works, so the fallback is not needed.** It ran against a copy of `.convex/local/default`, served by the cached `convex-local-backend` on other ports; the real local deployment was not touched. `convex export --include-file-storage` produced a 23 MB ZIP with 7,388 documents and 4 blobs in under 1 s.

- Layout:
  - `<table>/documents.jsonl` plus `generated_schema.jsonl`, which is always `"uniform"`.
  - `_tables/documents.jsonl` maps table names to numeric ids.
  - Components live under `_components/<name>/<table>/`. Nested components are nested further (`_components/rateLimiter/_components/batchWorker/…`), and every component has an empty `_storage/`.
  - Files: `_storage/documents.jsonl` holds `{_id, _creationTime, sha256, size, contentType, internalId}`, and each blob is `_storage/<_id>.bin`.
- Component tables are present: `betterAuth` (user 4, account 4, session 5, verification 15, jwks 1), `workerIdentity` (workers 4, keys 4, enrollments 6) and `secretStore` (secrets 4, secretEvents 13).
- Encodings:
  - `v.bytes()` is `{"$bytes": "<standard base64>"}` (3,272 values).
  - No `$integer` or `$float` values occur.
  - `sha256` is standard base64. All 4 blobs matched their hash and size.
- Two components that are no longer mounted still hold data: `resumableStream` (1 stream, 438 chunks) and `persistentTextStreaming` (6 streams, 818 chunks). The importer works from a table allowlist with an explicit drop list, and stops on any table it doesn't know.
- `_creationTime` is a float in milliseconds with up to 4 decimals. Rounding it to microseconds never reorders rows but does create ties: 13 tables have them, for example `chat_messages` (91 of 146 rows) and `acp_agent_sessions` (672 of 936), because rows written by one mutation differ by less than 1 µs. Ordering by `created_at` therefore needs `id` as a tiebreaker. Order that matters inside one mutation needs an explicit column, as `chat_messages.position` already provides. Docs corrected.
- System tables are not exported, so scheduled functions still pending at export time would be lost. `migrationStatus` gets a scheduler gate.
- Stage 1 is **not** done on the local deployment:
  - Only `chatMessagesToTable` and `chatsToWorkspaces` are recorded in `@convex-dev/migrations`.
  - The legacy tables still have rows: `balances`, `keys`, `chatroom_settings`, `telemetry_traces/spans/payloads`.
  - E2EE: `cutoverComplete` is true, but custody is `active` (2,157 custody writes, 269 `e2ee_legacy_custody` rows) and one `release` job is still `running`.

**2. Durable Streams.**

- JSON mode works as specified: a POST of an array is flattened one level; `[]` and invalid JSON get `400`.
- Idempotent producer:
  - an exact retry returns `204` and writes nothing;
  - a sequence gap returns `409` with the expected and received sequence;
  - a new epoch returns `200`;
  - a stale epoch returns `403` with the current epoch.
  - Reads showed each message exactly once.
- Expiry:
  - With `Stream-TTL: 3`, an unread stream returns `404` after 5.5 s.
  - An open SSE reader or a long-poll loop keeps the stream alive.
  - `Stream-Expires-At` works. Sending both TTL headers returns `400`.
  - Expiry can only be set when the stream is created.
- **Expiry doesn't delete data.** The Caddy plugin never turns on the file store's cleanup loop (`CleanupInterval` is unset in `module.go`). An expired stream's bytes stay in `data_dir`: a plaintext marker was still in `data.seg` after expiry. They go away only when the same path is created again or the stream is `DELETE`d. The server has no retention either. So every stream we create is deleted explicitly, and TTL is only a visibility backstop.
- `DELETE` followed by `PUT` on the same path returns a fresh, empty stream (`201`). The protocol says paths SHOULD NOT be reused, so `<gen>` stays.
- Close: append-and-close is atomic, a later append gets `409` with `Stream-Closed`, and SSE on a closed stream sends the data, then `streamClosed`, then ends.
- SSE through a Hono proxy on Bun for 10 minutes, with the idle timeout turned off per request: 477 of 477 messages, no duplicates, no gaps, and 12 upstream connections because the server recycles every 60 s.
- With Bun's default 10 s `idleTimeout`, the proxy cut the quiet connection. `@durable-streams/client`'s `jsonStream()` then threw `ECONNRESET` instead of reconnecting, so the reader died after 2 messages. The server sends no SSE keepalives. Two rules follow:
  - stream routes turn off the idle timeout;
  - clients wrap reads in resume-from-last-offset.
- The proxy has to drop `content-encoding` and `content-length`, because `fetch` already decompressed the body.
- AI SDK resume (`@durable-streams/aisdk-transport` 0.0.8, `ai` 7.0.179):
  - A second Tab attaching mid-reply and the first Tab after a reload both got all 44 chunks, identical, replayed from the start.
  - `toDurableStreamResponse` sends one POST per chunk (44), with no producer headers and no TTL. An `IdempotentProducer` with `lingerMs: 300` sent the same reply in 8 POSTs.
  - Decision: keep the client transport and its `201` + `Location` contract, and write runs through our own producer.
  - `IdempotentProducer.append` only accepts strings or bytes, although the README says objects work.
- Packaging:
  - There is no official container image, so Phase 1 adds a small image built from the release binary with its checksum verified.
  - `:4437` binds every interface, so compose must keep it on the internal network.
  - The binary writes `~/.config/caddy/autosave.json`.
- Activity: the last server release was 2026-06-02 (v0.3.0) and the last commit 2026-09-10. Risk row updated.

**3. Electric** (Electric 1.8.1; `@tanstack/db` and `@tanstack/electric-db-collection` 1.0.0-rc.1.5; `@tanstack/query-db-collection` 1.5.2).

- The shape proxy sets `table`, `columns`, `where`, `params` and the secret itself. It forwards only `ELECTRIC_PROTOCOL_QUERY_PARAMS`, which include the `subset__*` on-demand parameters.
- Authorization held:
  - client-injected `table` and `where` were dropped;
  - a request without a session got `401`;
  - each user saw only their own rows;
  - the excluded column was absent.
- txid reconciliation: the mutation returns `pg_current_xact_id()::xid::text`, `awaitTxId` resolved, and the optimistic state handed over to the synced row without flicker.
- The same live query over a query-sourced collection worked only when `onUpdate` awaits `collection.utils.refetch()` and returns `{ refetch: false }`. With the default refetch after the handler, the optimistic state was dropped before the refetch arrived and the row flickered back.
- **Dropping and recreating a synced table silently removed it from `electric_publication_default`.** Electric kept serving the shape, but no live changes arrived and `awaitTxId` timed out. Migrations must not drop and recreate Electric-synced tables (rule added to Live data).
- In TanStack DB, `eq(col, null)` never matches; use `isNull`.

**4. Nitro `bun` preset** (Nitro 3.0.261103-rc with rolldown, `drizzle-orm` 0.45.4).

- The Hono app works as the server entry on both `bun` and `node_server`.
- The build-time `#drivers` alias works in both directions: the Bun bundle contains no postgres.js, node-redis or `aws4fetch`, and the Node bundle never imports `bun`. Rolldown logs "Could not resolve 'bun'" and treats it as external; mark `bun` external to silence it.
- `drizzle-orm/bun-sql`: two concurrent `for update skip locked` claimers got disjoint rows, and rollback worked. postgres.js behaves the same.
- `Bun.RedisClient.send` handles `SET NX PX`, `GETDEL`, `EVAL` and `SCRIPT LOAD`/`EVALSHA`. The warm-cap script returned `[1,1,0,1]` for a cap of 2. node-redis matches.
- `Bun.S3Client` presigned PUT and GET against Garage round-tripped, and a GET after delete returned `404`. `aws4fetch` query signing matches.
- `scheduledTasks` (croner; 6-field cron with seconds works) with `experimental.tasks` and `serverDir`: one Bun and one Node replica behind a Valkey lease ran exactly 6 times in 30 s at a 5 s cadence.
  - The lease must be a fixed key with a TTL shorter than the interval.
  - Keying it by `floor(now / interval)` double-ran when the replicas straddled a slot boundary (12 runs).
- Bun's 10 s `idleTimeout` killed a quiet streaming response (0 bytes, cut at about 12 s). Calling `c.req.raw.runtime.bun.server.timeout(c.req.raw, 0)` (exposed by srvx under Nitro) on that request fixed it.
- Portable driver notes:
  - Use `@redis/client`, not the `redis` meta-package, which bundles about 1.3 MB of module clients.
  - Set postgres.js `onnotice`.
  - Node's `crypto.getRandomValues` caps at 64 KiB.
- Drizzle 1.0 is at `rc.6` while `latest` is 0.45.4. Choose in Phase 1.

**5. Load profile**: [filled in](../Backend_Migration/Live_Data.md#load-profile). It is measured from the planned write pattern (one minute, a watched ACP session plus a 45 s built-in run, two Tabs each) driven against real Postgres, Valkey and Durable Streams. The Convex column comes from code constants, not a measurement, because no new backend exists to put real traffic through.

**6. Last Convex version: implemented on this branch.** Operator procedure: [deployment → last Convex version](../deployment.md#last-convex-version-migration-status-and-maintenance-mode).

- **Maintenance mode** is the deployment env var `RADIUM_MAINTENANCE`, read through `process.env`, so it costs no database reads. `src/maintenance.ts` owns it.
  - `drain` closes browser and API writes but leaves Worker writes open, so claimed work can finish and queues can drain.
  - `1` also closes Worker writes.
  - What is closed:
    - every public `mutation`/`action`, through guarded builders that `workspaceMutation` and `ownedWorkspaceMutation` build on;
    - `workerMutation`, but only in `1`;
    - non-safe HTTP methods on the Hono router, which get `503` with `Retry-After`;
    - every Better Auth POST.
  - What stays open:
    - internal functions, crons and the scheduler;
    - GET paths that write as a side effect: Better Auth session refresh, and `GET /models` legacy-balance backfill.
  - Cron writes after the export are discarded.
- **`migrationStatus`** (`bunx convex run migration_status:migrationStatus '{}'`) is a read-only internal action. It returns `ready` and `failing` across these gates:
  - maintenance on;
  - every `@convex-dev/migrations` migration;
  - all 16 verifiers, exhausted page by page;
  - E2EE (`e2ee_migration:status`, custody rows, the custody seed, running jobs);
  - unfinished relay queues;
  - pending `_scheduled_functions`.
- **Checks:**
  - Focused tests and the full backend suite passed (71 files, 650 tests), and `tsc` over `convex/` and `src/` was clean.
  - On a pushed copy of the local deployment, `migrationStatus` took about 2 s and returned `ready: false`. Failing gates:
    - maintenance;
    - 12 migrations;
    - 7 verifiers, for example `completion_workspace_missing: 143`;
    - `e2ee:verify`, `e2ee:custody`, `e2ee:jobs`.
  - Queues and the scheduler were clean.
  - With `1` set, a public mutation was refused with `MAINTENANCE`, an internal mutation still ran, and the Gateway POST and Better Auth sign-in got `503` while GETs stayed open. With `drain` set, Worker auth passed the gate. After `env remove`, everything was open again.
- **Not covered:** the ESLint import guard was skipped because the root ESLint config can't load (`eslint` isn't installed at the root). The web client shows `MAINTENANCE` as a generic error.
- **Stage 1 on the local deployment** is not part of Phase 0. It must be done, with separate approval, before Phase 6, because the importer fixture and the rehearsal need a narrowed export: run the remaining ownership and data migrations until the verifiers are clean, then end custody.

## Phase 1: Foundation

- `packages/contracts` created; runtime-neutral modules moved out of `backend/src` (ACP contract types and fold, presence, Worker task contract, chat tool names, model slugs, workspace colors/icons/names), with Convex `v` validators rewritten as zod.
- Backend skeleton: Nitro project (`nitro.config.ts`, `server.ts`), `createApp()`, Bun drivers, env parsing, `/api/trpc` with the four base procedures, `bin/migrate.ts`, outbox `jobs` table and dispatcher, scheduled Nitro tasks with Valkey leases. Pick Drizzle 0.45 or 1.0 (at `rc.6` in Phase 0) before the first schema lands.
- Better Auth on Drizzle + Valkey `secondaryStorage` + OPAQUE plugin and hooks; generated auth schema; ratelimit helper.
- `docker-compose.yml` with Postgres (`wal_level=logical`), Valkey, Durable Streams (no upstream image: a small image from the checksum-verified release binary, reachable only on the internal network), optional Electric; `test` profile; Vitest setup with template databases.
- Web: `/api/*` forwarder replacing `/api/auth/$` and `/api/backend/$`; tRPC client with `@trpc/tanstack-react-query`.

Verification: sign-up and OPAQUE sign-in against the new backend; session survives restart (Valkey + Postgres); `db:migrate` on empty DB; CI checks from the [migration policy](../Backend_Migration/Runtime.md#schema-migrations) running.

## Phase 2: Schema

Drizzle schema for every retained table, per domain, following the [conventions](../Backend_Migration/Runtime.md#database-conventions): text ids, `created_at`, real foreign keys with explicit delete policy, constraints for every [invariant](../Backend_Migration/Runtime.md#transactions-and-invariants), `secrets` with the Secret Store envelope. Until the cutover release, migrations on the branch may be regenerated freely.

Verification: schema review against the [data placement table](../Backend_Migration/Live_Data.md#where-data-lives); every invariant has a failing-then-passing concurrency test once its service exists.

## Phase 3: Domains

One slice per session, each a tRPC router + services + tests, ported from `packages/backend/src/<domain>` behavior and existing tests (rewritten against real Postgres, not `convex-test`). Order follows dependencies:

1. `workspaces` (members, projects, preferences), `auth` user info
2. `gateway`: providers, models, credentials, secrets, API keys, routing (Valkey state), limits, ChatGPT subscription routes; `/api/openai/v1/*` on the new backend
3. `chatroom`: chats, messages, members, files and object store, titles, tools, Code Mode, `/api/chat` without live streaming yet
4. `e2ee`: identities, bundles, trust stores, workspace epochs/grants/rosters, invites, phrases, chat keys, device recovery
5. `notifications` (+ Web Push), `usage`, `telemetry` (capture, ingest, retention, export), `logging`
6. `worker`: identity, enrollment, machine auth, presence, tasks, gateway access; `acp`: definitions, sessions, commands, interactions, catalog, usage

Acceptance per slice: authorization boundary tests (owner, member, outsider, personal-chat privacy, revoked Worker) pass; the slice's web screens work against the new backend on an imported local copy.

## Phase 4: Live Layer

Stream proxy, user and workspace invalidation streams, chat signal streams, Worker inboxes; built-in chat runs on streams (admission, Stop, lease, detached runs on Bun); ACP epochs on streams with Valkey viewers, warm cap and `acp.cool`; Worker task and Code Mode waits; notification doorbells; optional Electric collections.

Verification: two browsers and a phone-sized viewport on one keyed chat and one ACP session: live reply in both, reload resumes, Stop from the non-sender, approval answered once, session cools after 5 minutes without viewers and re-warms with a new epoch; ACP streams hold only ciphertext for paired sessions; run streams are gone 10 minutes after the run ends.

## Phase 5: Client Cutover

- Web: every Convex call replaced by tRPC or a collection (about 90 files import generated Convex bindings; list them with `rg -l "convex/_generated|convex/react" apps/web/src`); `Id<>`/`FunctionReturnType` replaced by `contracts` ids and `inferRouterOutputs`; Convex providers, `@convex-dev/react-query`, `convex-helpers` cache removed; uploads through presigned URLs; `lib/crypto` transport switched from `cryptoClient()` to tRPC with base64url bytes.
- Worker: tRPC client, inbox SSE reader, ACP relay appends through the proxy, `relocate` command; Convex client removed.

Verification: `vite:build`; web typecheck against `AppRouter`; Worker unit, native and typecheck suites; Worker edit/Bash tools and an ACP session end to end with a paired Worker.

## Phase 6: Convex Import

`bin/import-convex.ts` per [Convex import](../Backend_Migration/Convex_Import.md): gates, frozen baseline schema and mappings in `src/import-convex/`, blob copy, verification report, hand-off to `db:migrate`. At the cutover release the branch's migrations are squashed into `0000_baseline` and the importer's frozen schema is generated from it; from then on that file never changes. Fixture export from the local deployment checked into tests; CI runs fixture → baseline → head.

Verification: full rehearsal on a restored copy of the local deployment, all seven verification steps, timings recorded here.

## Phase 7: Serverless Presets And Deployment

Portable drivers (Postgres.js, node-redis, `aws4fetch`), then the [serverless spikes](../Backend_Migration/Runtime.md#serverless-spikes) on Cloudflare first; a preset is documented as supported only once its spikes pass. `docs/deployment.md`, `README.md`, `docs/architecture.md`, `docs/api.md`, Worker README and container files rewritten for the new stack; compose quickstart (`bun` preset) verified from a clean checkout.

## Phase 8: Removal

Delete `packages/backend/convex/`, `packages/worker-component/`, `scripts/convex-ready.ts` and every Convex dependency; rewrite `AGENTS.md` sections that describe Convex (wiring, verification, generated files, deployment); archive Convex-specific docs (`Worker/Convex_Transport.md`, `research/Convex_Reuse.md`, `Backend_Pre_Rewrite_Report.md`) or mark them historical; update [E2EE data classification](../E2EE/Data.md) for streams and Valkey.

Acceptance: `rg -i convex` finds only historical docs and the importer.
