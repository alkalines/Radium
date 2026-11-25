# 14 Backend Migration (Convex → Bun, Hono, Postgres)

Status: **Phase 0 spikes done (2026-11-21); Phase 1 foundation done (2026-11-22); Phase 2 schema done (2026-11-22); Phase 3 domains done (2026-11-25): all six slices on the server and in the web app, the Worker client not yet (Phase 5); Phase 4 not started.** Design: [Backend migration](../Backend_Migration.md), with [runtime and layout](../Backend_Migration/Runtime.md), [live data](../Backend_Migration/Live_Data.md) and [Convex import](../Backend_Migration/Convex_Import.md). Branch: `refactor/abandon-convex`.

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

### Phase 1 Results (2026-11-22)

Decisions taken with the user before starting:

- **The new backend is `packages/server`**, not a folder inside `packages/backend`. That package stays the Convex product until the cutover and is deleted whole in Phase 8 ([layout](../Backend_Migration/Runtime.md#packages)).
- **Drizzle `1.0.0-rc.6`**, pinned exactly (with `drizzle-kit` `1.0.0-rc.6`), not 0.45. 1.0 changes the migration folder format and the relational query API; starting on it avoids converting both later. Better Auth uses its adapter's `relations-v2` entry for it.
- **The web forwarder replaced both proxy routes now.** On this branch the web app signs in against the new backend, so screens still on Convex run without a Convex token until their slice moves. `dev` is unaffected.
- **Zod is the one source of shared shapes**; the still-running Convex backend derives its `v` validators from it.
- `dev` takes no Convex feature work during the migration, only Stage 1 fixes.

What was built:

- **`packages/contracts`.** Every runtime-neutral module that web or the Worker imported from `backend/src` moved or was split there, with validators rewritten as zod; no web or Worker source imports `backend/src` anymore. The one exception is the test `packages/worker/src/tasks.sealed.test.ts`, which imports `buildWorkerChatTools` (that function needs the Convex action context). Ids and bytes, which zod has no type for, go through `contracts/wire` (`idOf`, `bytes`). `packages/backend/src/zod-validators.ts` converts the zod schemas back to Convex validators. `convex-helpers`' `zodToConvex` couldn't be used: it maps any id that isn't its own `zid()`, and any custom schema, to `v.any()`. Checked before and after against a snapshot of the Convex surface: all 410 registered functions' `exportArgs`/`exportReturns`, the 3 schema exports and all 84 moved validators are byte-identical. The web typecheck also found a real bug the build had missed: `tab-state.ts` read `.members` of a Convex validator at runtime; it now uses the zod `.options`.
- **Server skeleton:**
  - Nitro `bun` preset with the Hono app as server entry. A runtime plugin starts and checks the runtime before traffic and closes connections on shutdown.
  - `#drivers` alias, with `Bun.SQL` and `Bun.RedisClient`.
  - zod env parsing.
  - `/api/trpc` with the four base procedures.
  - `/api/health`.
- **Database:** column conventions and UUIDv7 ids. The migration runner (`db:migrate`) works as follows:
  - one advisory lock per run, and one transaction per migration;
  - backfills and the narrowing gate, plus `--to` for the importer;
  - it refuses edited or unknown migrations;
  - it records into Drizzle's own table.

  `SCHEMA_VERSION` is generated after `drizzle-kit generate`, and startup refuses a database that is behind it. Drizzle's own `migrate()` was rejected: it runs everything in one transaction and has nowhere to put backfills.

- **Outbox and tasks:**
  - The `jobs` table supports `enqueueJob` in the caller's transaction, after-commit `dispatchJobs`, and a one-minute `jobs:sweep` Nitro task.
  - Claims use `skip locked` with a lapsing claim, retries back off, and a job is parked after 8 attempts.
  - Debounce uses `dedupe_key`.
  - The Valkey lease is a fixed key per task.
- **Auth:**
  - Better Auth on Drizzle, with Postgres as the session record (`storeSessionInDatabase`). Valkey `secondaryStorage` holds the session cache, rate-limit windows and verification values, so there is no `verification` or `rateLimit` table.
  - The OPAQUE plugin with hooks ported to Postgres (`src/e2ee/keys.ts`). Each write is one transaction under a per-user advisory lock. Unique indexes cover the key id and `(user, credential version)`, and a partial unique index allows one active identity per user.
  - The ingress policy (origin check, body bound, proxy-secret client address) is ported unchanged.
  - The OPAQUE per-account budget runs on a Valkey token bucket.
  - `workspaces`, `workspace_members`, `workers` and `worker_keys` tables exist with only the columns the base procedures need; Phase 2 widens them.
- **Compose:**
  - `docker-compose.yml` runs Postgres 18.7 (`wal_level=logical`), Valkey 9.2 (AOF) and Durable Streams, with Electric under `--profile electric`. Every port binds to `127.0.0.1`, and secrets come from `.env`.
  - The Durable Streams image is built from release v0.3.0. Its `checksums.txt` was verified for amd64 and arm64, and the image runs on distroless with `persist_config off`. Every request needs `Authorization: Bearer $STREAMS_TOKEN`; the gate is a Caddy matcher in front of the plugin.
  - Tests use a separate `docker-compose.test.yml` (in-memory, fixed test credentials, ports 55432 and 56379), because the main file refuses to run without real secrets.
- **Web:**
  - `/api/$` forwards to `API_INTERNAL_URL`, streaming. It strips hop-by-hop and client-sent proxy headers, adds the proxy secret and client IP, passes redirects back, and drops the stale encoding headers.
  - `apps/web/src/lib/auth-server.ts` is gone, and the root route no longer fetches a Convex token.
  - tRPC uses `@trpc/tanstack-react-query`: one options proxy per router in `context.trpc`, same-origin in the browser, and direct to the backend with the incoming cookie during SSR.
- **CI:** `.github/workflows/server.yml` runs typecheck, `drizzle-kit check`, regenerate-without-diff, `db:migrate` twice on an empty database, tests, and the Nitro build.

Checks (this workstation, Bun 1.4.5, the compose services above):

- `bun run --cwd packages/server test`: 5 files, 29 tests, all pass, in about 8 s against real Postgres and Valkey:
  - **OPAQUE through the HTTP surface:** the plugin's own client signs up with a key bundle and signs in; a wrong password is refused; a foreign `Origin` gets 403; the session survives a backend restart and a Valkey `FLUSHDB`.
  - **Base procedure boundaries:** owner, member, outsider, archived and unknown workspace. For Workers: a valid token, another workspace, a stale epoch, an expired token, and revocation while the token is still valid.
  - **Key-bundle invariants under concurrency:** idempotent commit, key ids that can't be adopted, one active identity when two switches race, and retire-and-delete on rotation.
  - **Outbox:** 30 jobs, with two sweeps and a dispatch racing, run exactly once. Also rollback, dedupe, `runAt`, backoff and parking; a lease is held by exactly one of 5.
  - **Migration runner:** order, `--to`, idempotence, two concurrent runs, rollback of a failing migration, refusal of edited or unknown migrations, and the backfill gate.
- `typecheck` is clean; `db:check` passes; `db:generate` reports no changes.
- `db:migrate` on the empty dev database applied `20261122142511_foundation`, and a second run applied nothing.
- The built server (`.output/server/index.mjs`) started against an unmigrated database exits with "The database is behind this build … run db:migrate first".
- **In the browser, against the built server through the web forwarder:**
  - Sign-up with a recovery key created one user, one `opaque` account with its registration record, one active identity, one key bundle and one session in Postgres.
  - After a backend restart, `auth.me` and `get-session` still returned the user.
  - After sign-out, `auth.me` returned 401; OPAQUE sign-in from the form returned the user again.
  - Valkey held only `auth:`-prefixed keys, the `ratelimit:password-attempt:<hmac>` bucket and the sweep lease; Postgres has no `verification` or `rateLimit` table.
- The Durable Streams container answered 401 without the token, then 201 and 204 with it.
- `vite:build` passes, and the web bundle contains no server code (no `drizzle-orm`, `RedisClient` or `pg_advisory` strings).
- The web `tsc` errors are unchanged by this work: 103, all in Better Auth UI organization, passkey and OAuth components or in backend files reached through `backend/src`. None are in the files touched here.
- The contracts move kept every existing suite green:
  - the root `bun run test` (contracts: 18 files, 72 tests; backend: 62 files, 614 tests, down by exactly the 9 test files that moved);
  - the Worker typecheck (only its 2 pre-existing `preconnect` errors) and the full Worker suite (vitest 181, edit 28, bash 8).

Not done or not covered:

- **`signIn.revealClassicCredential` is off on the new backend**, which only means classic (pre-encryption) accounts get a fake OPAQUE login instead of `CLASSIC_CREDENTIAL`. The published `@alkalines/better-auth-opaque@0.2.0` does not contain that option; the build the workspace had used was an unpublished local one. `bun install` for this phase resolved the published build, so `packages/backend/convex/auth.ts` now fails typecheck on that option, and at runtime Convex would ignore it. Release 0.2.1 with the feature is open as [alkalines/better-auth-opaque#9](https://github.com/alkalines/better-auth-opaque/pull/9). After it is merged, tagged and the staged npm version approved, bump all three pins to 0.2.1 and turn the option back on in `src/auth/auth.ts`.
- The CI workflow has not run on GitHub yet. Its steps were each run locally.
- The custody release Convex's activation requested is not ported (custody ends in Stage 1).
- Portable drivers, the object store driver and Durable Streams/Electric clients are not part of this phase.
- The web auth client still loads `convexClient()` and the app still mounts `ConvexBetterAuthProvider`, because the Convex screens are typed against them. The provider asks `/api/auth/convex/token`, the new backend answers 404, and those screens stay signed out. Both go in Phase 5 with the Convex client.
- `docker compose up --build` of the Durable Streams image was run by the user. The image itself was not inspected beyond the auth check above.

## Phase 2: Schema

Drizzle schema for every retained table, per domain, following the [conventions](../Backend_Migration/Runtime.md#database-conventions): text ids, `created_at`, real foreign keys with explicit delete policy, constraints for every [invariant](../Backend_Migration/Runtime.md#transactions-and-invariants), `secrets` with the Secret Store envelope. Until the cutover release, migrations on the branch may be regenerated freely.

Verification: schema review against the [data placement table](../Backend_Migration/Live_Data.md#where-data-lives); every invariant has a failing-then-passing concurrency test once its service exists.

### Phase 2 Results (2026-11-22)

Decisions taken with the user before starting:

- **Nested objects with bytes**: small fixed structs become prefixed columns with real `bytea`; unions, arrays of objects and open shapes are `jsonb` with base64url bytes inside ([conventions](../Backend_Migration/Runtime.md#database-conventions)).
- **Operational log events go to a structured stdout sink.** There is no `log_events` table; the Convex `logging` component is not imported.
- **Three tables are renamed**: `aisdk_chats` → `chats`, `workspace_configurations` → `workspace_providers`, `subscription_state` → `subscription_sessions` (session namespace only). Every other table keeps its Convex name.

What was built (`packages/server/src/<domain>/schema.ts`, migration `drizzle/20261122153248_domains`):

- **59 new tables** over nine domain files, plus the Phase 1 tables widened (`workspaces.key_epoch`, `legacy_content`; a `(id, workspace)` unique on `workers`):
  - `workspaces`: `workspace_settings`, `workspace_mcp_servers`, `projects`, `project_folders`, `user_preferences`;
  - `gateway`: `workspace_providers`, `workspace_credentials`, `api_keys`, `credential_limits`, `limit_events`, `subscription_sessions`, `secrets`, `secret_events`, `models`, `providers`, `authors`, `ai_apps`;
  - `chatroom`: `chats`, `chat_messages`, `chat_members`, `chat_files`, `chat_runs` (new), `mcp_servers`, `chat_mcp_servers`;
  - `acp`: `acp_agents`, `acp_agent_sessions`, `acp_sessions`, `acp_commands`, `acp_interactions`;
  - `worker`: `worker_enrollments` (the component's enrollments merged into the app receipt, keeping the app id that setup codes and Worker state carry), `worker_agents`, `worker_tasks`, `worker_chat_calls`, `worker_gateway`;
  - `e2ee`: trust stores, workspace epochs, grants, rosters, Worker keys and pairings, invites, phrases, join requests, chat keys, wraps, capsules;
  - `usage`: `chat_completions`, `local_usage`, `local_usage_syncs`, `acp_usage`, `acp_model_prices`;
  - `telemetry`: blobs, toolset tools, nodes, sessions, requests, destinations;
  - `notifications`: `notifications`, `push_subscriptions`.
- **Not modeled**, per the [placement table](../Backend_Migration/Live_Data.md#where-data-lives): `chat_frames`, `acp_streams`, `chat_viewers`, `acp_deferred_cleanups`, `worker_presence`, `worker_auth_challenges`, `codemode_interactions`, `e2ee_device_recovery`, `routing_*`, `storage_sweeps`, the E2EE migration and custody tables, and the legacy bridge. `telemetry_gc` becomes `telemetry.gc` outbox jobs.
- **Shape changes worth knowing in Phase 3:**
  - The ACP agent binding (Worker, agent, version, profile, folder, session id) lives only on `acp_sessions`; `chats` has no `agent` column. A chat is an ACP chat when it has a session row.
  - `chats` has no `activeStream`: a chat is replying while it has an `active` `chat_runs` row.
  - The `mcpServers` lists of workspace settings and chat tool overrides are child tables that cascade from the server; Project folders are `project_folders` rows with an `is_default` flag (at most one per Project).
  - `notifications` drops `title`/`body` (always the generic text of `kind`) and `sealingPending` (sealing is an outbox job; a row without a box shows the generic text).
  - Worker-owned tables drop their copied `workspace` where it is the Worker's; tables that keep one (`acp_*`, `chat_members`, `chat_files`, `local_usage`, `acp_usage`, `e2ee_chat_key_wraps`, `workspace_mcp_servers`, `chat_mcp_servers`) reference the chat, Worker or MCP server through `(id, workspace)`, so a row cannot cross workspaces.
- **Invariants** from the [table](../Backend_Migration/Runtime.md#transactions-and-invariants) backed by the schema: `acp_sessions` unique `chat` plus the status admission update; `chat_runs` partial unique active run; `acp_commands` unique `(worker, client_id)` (Convex dedupes per Worker and refuses another issuer, so `issuer` is not in the key) and a check that a pending command holds exactly one payload form and any other status holds none; `acp_sessions` `cooled_epoch <= epoch`; `acp_interactions` checks that pending rows hold no answer and answered rows exactly one; `worker_tasks` unique `(worker, request_id)` with `status`/`claim_id`/`revision` for the fenced updates; `worker_enrollments` unique token hash and completion columns set exactly when `completed`; `notifications` `seen_at` and `delivery_at` exclusive. Every Convex `.unique()` read and "one per X" rule became a unique index.
- `src/db/columns.ts` gained `json<T>()` (`jsonb` typed as the stored form of a contracts shape), `literals()` (enum values from a contracts zod union) and `checkIn()`.

Checks (this workstation, the test compose services):

- `typecheck` clean; `drizzle-kit check` passes; regenerating reports no changes; the Nitro build passes (2.44 MB).
- `bun run --cwd packages/server test`: 5 files, 29 tests pass; the global setup applies both migrations to the template database with the real runner.
- A throwaway probe (not kept) inserted one row into nearly every table as one connected graph, then deleted a Project, an MCP server, a credential and a chat, then a whole workspace. It found one bug, fixed before this record: `acp_sessions` → `workers` was `no action`, which blocked a workspace delete because the cascade to `workers` ran before the one through `chats`; it is `cascade` now (Workers are revoked, never deleted). After the fix, every chat child was gone, telemetry and completion rows kept with `chat` and `credential` set null, and the limit notification survived the credential.

Not done or open:

- Concurrency tests for each invariant come with the service that relies on it (Phase 3), as planned.
- `Meter`, `AlertState` and `LimitSettings` are typed in `gateway/schema.ts` because `backend/src/limits/meters.ts` has only Convex validators; the gateway slice moves them to `contracts`.
- Import risks to check on the Stage 1 data before Phase 6: Worker ids in ACP and chat rows that name a missing Worker (Convex never checked them), duplicate `chats.e2ee_id`, more than one unrevoked API key per Worker, more than one credential per `(workspace, provider, account)`, credentials for a provider without a `workspace_providers` row (so `workspace_credentials.provider` is not a foreign key).
- `telemetry_requests` has 14 indexes; seven exist only so garbage collection and the blob `no action` check can find referrers. Reference counting would remove them at the cost of another invariant; revisit if capture write cost shows up.
- `e2ee_capsules.chat_epoch` and `chat_messages.sealed_capsule_id` have no foreign key to the chat key or capsule; the services keep checking them as today.

## Phase 3: Domains

One slice per session, each a tRPC router + services + tests, ported from `packages/backend/src/<domain>` behavior and existing tests (rewritten against real Postgres, not `convex-test`). Order follows dependencies:

1. `workspaces` (members, projects, preferences), `auth` user info
2. `gateway`: providers, models, credentials, secrets, API keys, routing (Valkey state), limits, ChatGPT subscription routes; `/api/openai/v1/*` on the new backend
3. `chatroom`: chats, messages, members, files and object store, titles, tools, Code Mode, `/api/chat` without live streaming yet
4. `e2ee`: identities, bundles, trust stores, workspace epochs/grants/rosters, invites, phrases, chat keys, device recovery
5. `notifications` (+ Web Push), `usage`, `telemetry` (capture, ingest, retention, export), `logging`
6. `worker`: identity, enrollment, machine auth, presence, tasks, gateway access; `acp`: definitions, sessions, commands, interactions, catalog, usage

Acceptance per slice: authorization boundary tests (owner, member, outsider, personal-chat privacy, revoked Worker) pass; the slice's web screens work against the new backend on an imported local copy.

### Slice 1 Results: Workspaces (2026-11-22)

Decisions taken with the user before starting:

- One slice this session.
- Cross-slice pieces that member removal needs are ported now as exported services of their own domain, not deferred: `chatroom/chats.ts` (`detachWorkspaceMember`, `workspaceHasChats`) and `e2ee/workspace-keys.ts` (epochs, grants, rosters, `clearWorkspaceJoins`, key availability). Slices 3 and 4 build on them.
- The slice's web callers move to tRPC now and are checked in the browser on fresh accounts, because the importer (Phase 6) does not exist yet.
- The legacy bridge is not ported (`balances` mapping in `ensurePersonalWorkspace`, `ensureForLegacyBalance`, `assertLegacy*` gates).

What was built (`packages/server/src/workspaces/`, routers `workspaces`, `projects`, `preferences`):

- **Workspaces**: `list`, `listArchived`, `ensurePersonal`, `create`, `setColor`, `archive`, `restore`. Members: `listMembers`, `addMember`, `removeMember`. Sealed names: `workspaces.sealedName`/`setName`, `projects.sealedName`/`setName` (Convex `e2ee_legacy.getName`/`setName`).
- **Projects**: `list`, `create`, `update`, `remove`. Folders are `project_folders` rows rewritten in one transaction; deleting a Project detaches chats through the `set null` foreign key instead of batched continuations.
- **Preferences**: `get`, `setModelPinned`, `setModelHidden`. `auth.me` (Phase 1) replaces `auth.userInfo`.
- **Errors**: services throw `AppError`; the base procedure maps it, and internal errors reach the client as a generic message ([tRPC conventions](../Backend_Migration/Runtime.md#trpc-conventions)).
- **Bytes on the wire**: `base64urlBytes(max)` in `contracts/wire` (used by the rotation and sealed-name inputs).
- **Web**: workspace provider and management, Project dialog, menus and lists, model preferences and the `auth.me` loaders/panels use tRPC. Signed-in state comes from the Better Auth session (there is no Convex token on this branch). `lib/trpc-client.ts` is the browser's imperative client for `lib/crypto`; it is separate from `lib/trpc.ts` because the notification service worker bundles `lib/crypto`. On an account switch the whole query cache is dropped, since tRPC keys carry no user. Workspace and Project summaries use `id`, not `_id`.

Behavior changes from Convex:

- The server never accepts a plaintext workspace or Project name or icon. `workspaces.create` and `projects.create` take no name, and there is no `rename`/`setIcon`. After cutover Convex refused them anyway.
- `addMember` refuses a 201st member (`Member limit reached.`). Convex accepted it, after which every roster and grant check of the workspace failed.
- Member removal is one transaction: no `continueMemberRemoval` batches.

Checks (this workstation, test compose services, then the dev compose services):

- `bun run --cwd packages/server test`: 6 files, 45 tests pass. `workspaces.test.ts` covers owner, member, outsider and archived boundaries for every procedure family, member removal with rotation (refused without one, refused for a keyless workspace or a forged roster, and two concurrent removals with the same next epoch: exactly one lands, chat members and joins are cleared, the right chats are flagged `rekey`), sealed-name compare-and-swap and key checks, Project folder rules (revoked, foreign and unknown Workers; unchanged folders on a revoked Worker stay editable), and chat detachment.
- Concurrency tests checked failing-then-passing: removing the owner advisory lock or the preferences row lock made `ensurePersonal` (5 parallel calls), the archive race and 10 parallel pins fail; restored, they pass.
- Server `typecheck` clean; contracts tests (72) pass; web `tsc` has the same 103 pre-existing errors and no new ones; `vite:build` passes.
- In the browser, against the built server through the web forwarder, with two fresh OPAQUE accounts:
  - the first sign-in provisioned one personal workspace;
  - `listMembers` showed the owner; adding the second account by upper-case email listed it as a member;
  - setting the color saved `teal`;
  - with a second workspace, archiving moved it to the archived list and restoring brought it back;
  - creating a Project stored color `green` with the placeholder name and no plaintext, and Home listed it;
  - pin and hide calls sent from the page kept the lists exclusive. They were not sent from a model picker, because model lists are still on Convex.
  - The server logged no internal error.

Not done or not covered:

- **Sealed names and keyed member removal were not exercised in the browser.** The key manager still unlocks and reads workspace keys through Convex, so on this branch it stays locked ("Encryption keys are locked on this device"). Project and workspace name and icon edits and `createKeyedWorkspace` stop there until slice 4 moves the E2EE reads; the server side of both is covered by tests. A Project created from the dialog keeps the placeholder name until then.
- The Project and member limit locks have no concurrency test (200 rows each).
- A replaced sealed name whose old box lived in Convex storage (`storageId`) leaves that object unreferenced; names are under 16 KiB, so none is expected. The `files.orphans` job (chatroom slice) covers it.
- `nitro dev` cannot load the `bun` drivers (it runs Node workers), so browser checks use the built server (`bun .output/server/index.mjs`).
- The web screens were not checked on an imported copy; that needs the importer (Phase 6).

### Slice 2 Results: Gateway (2026-11-22)

Server side, commit `55fd62e` (`packages/server/src/gateway/`, routers `providers`, `models`, `keys`, `routing`, `limits`):

- **Secrets** (`gateway/secrets.ts`): the `convex-secret-store` envelope byte for byte. A test decrypts a row encrypted by the original component code (null namespace included), and the reverse. `SECRET_STORE_KEYS` is now required at start.
- **Providers, credentials, models**: credentials are always pooled rows. The legacy fallbacks are not ported: the no-row provider credential, the `provider:` secret namespace and the catalogue fallback. `keys.deleteLegacyKey` is gone with the legacy `keys` table.
- **API keys**: `rad-sk-` SHA-512 lookup. The resolution is cached in Valkey for 60 s; a rename, revoke, telemetry change or workspace archive writes a tombstone, so the change applies at once.
- **Routing**: cursors, cooldowns and affinity are Valkey hashes with TTLs, changed by a compare-and-set script. A cooldown is kept one day after it ends, the old prune window.
- **Limits**: meters and adapters (OpenRouter, ChatGPT), `limits.poll` as a Nitro task claiming with `for update skip locked`, budget recompute as a deduped outbox job, and `retention` as a Nitro task. `Meter`/`AlertState`/`LimitSettings` moved to `contracts/limits/meters`. Changes from Convex:
  - a new limit key is polled on the next 5-minute run, not immediately;
  - a manual refresh within one minute of the last is `CONFLICT`;
  - the budget is a SQL sum.
- **HTTP**: `/api/openai/v1/chat/completions` and `/models` keep their paths, statuses and error bodies, with the idle timeout turned off per request. Only routing configuration errors expose their message on a 500; Convex exposed every error message. `/api/subscription/chatgpt-subscription/*` needs a session and an owned workspace, has no CORS (same origin through the forwarder), and answers 503 without `LWC_SECRET`.
- **Write paths in their own domains**: completion recording (`usage/completions.ts`), telemetry capture and ingest (`telemetry/`, on only with `TELEMETRY_HASH_SECRET`), and notification rows (`notifications/notify.ts`). Notification rows carry no text.
- **Migration** `20261122203235_gateway_routing`: a nullable `workspace_settings.routing` (Phase 2 had no column for the workspace routing settings).
- **Checks**: 22 files and 235 tests pass, with a stubbed upstream `fetch`; typecheck, build and `db:check` pass. These concurrency tests were each seen failing with their guard removed:
  - the routing cursor compare-and-set (round-robin and weighted);
  - the provider row lock (pool cap, OAuth bind);
  - the key-cache tombstone;
  - the poll `skip locked`, the refresh conditional update and the budget dedupe key;
  - the meter snapshot lock;
  - the telemetry blob and node guards.

  The Secret Store single-writer test and the pool-cap test were not seen failing.
- **Build size**: the Nitro build grew from 2.44 MB to 4.7 MB (AI SDK providers, Login with ChatGPT).
- **Left for later slices**:
  - telemetry export to destinations and object-store envelopes;
  - notification sealing and the Web Push fallback;
  - limit event delivery channels;
  - the Chatroom access check before a chat completion is recorded (until then only "chat in workspace");
  - issuing Worker keys (Worker-issued keys already resolve);
  - other domains' retention entries.

Web side, commit `7cf8ed3`:

- **Moved to tRPC**:
  - every Gateway screen (providers, credentials, models, keys, routing, limits);
  - the read-only `models.availableModels` consumers (model pickers, preferences panels).
- **ChatGPT device flow**: calls `/api/subscription/chatgpt-subscription` on the same origin with `?workspace=` and the session cookie.
- **Removed with their backend paths**: the legacy key UI and the legacy/no-row credential branches.
- **The `rad-sk-` key** returned by `keys.create` lives only in the dialog state; the mutation has `gcTime: 0`.
- **Checks**: web `tsc` still has the 103 baseline errors and `vite:build` passes. Browser check is pending, together with slice 3.
- **Known gap until slice 5**: `telemetry-destinations.tsx` still saves destinations through Convex, but its key checklist now lists Postgres key ids. Those ids are cast to Convex ids, so a destination saved on this branch names keys the Convex side does not know.

### Slice 3 Results: Chatroom (2026-11-22)

Server side, commit `8cc7564` (`packages/server/src/chatroom/`, routers `chats`, `chatroom`, `tools`, `chatFiles`; `POST /api/chat`; `/api/files/*`):

- **One access function** (`chatroom/access.ts`, `chatAccess`), one query:
  - `personal`: the creator only (not the workspace owner);
  - `shared`: the creator plus `chat_members`;
  - `workspace`: every workspace user;
  - management: the creator, or the owner for workspace chats.

  tRPC, `/api/chat`, files, Code Mode answers, chat-key checks and completion/telemetry attribution all use it. Slice 2's interim "chat in workspace" check is gone.
- **Sealed writes** keep every Convex check:
  - capsules, boxes and envelopes (`chatroom/sealing.ts`);
  - epoch signatures and bindings, wrap coverage, current sealing key, who may rotate (`e2ee/chat-keys.ts`);
  - scope changes bound to the next audience: widening rewraps history, narrowing deletes workspace wraps (`e2ee/chat-scope.ts`).

  There is no plaintext chat creation, title, queue or upload.
- **Object store**: `Bun.S3Client` or a local-disk adapter (exactly one of `S3_BUCKET`/`FILES_DIR` is required), presigned PUT/GET, `/api/files/{upload/:id, :id, resolve}`, and an hourly `files:orphans` task. The S3 adapter is typechecked but has not been run against a real S3 server.
- **`/api/chat`** streams the reply straight to the requester.
  - Admission goes through the `chat_runs` partial unique index; a second sender gets 409, where Convex let the last save win.
  - Messages are saved sealed, and the run ends `finished`/`failed`.
  - Retention fails active runs whose lease is older than 60 s and deletes ended runs after 10 min.
  - Titles are generated inside the turn and by `chats.regenerateTitle`, with no outbox job, so the first prompt is never stored in plaintext.
- **Code Mode prompts** live in Valkey with a TTL; the first answer wins (`SET NX`).
- **MCP servers** are capped at 200 per workspace at creation (Convex listed 200 but created without bound).
- **Checks**: 27 files and 320 tests pass; typecheck, build and `db:check` pass; no migration. Personal-chat privacy is tested on every read path, `/api/chat` included (404 before any model call). The success test decrypts the stored reply with the chat key under the Convex AAD.
- **Concurrency tests**: these were each seen failing with their guard removed:
  - one active run per chat;
  - the first Code Mode answer;
  - concurrent message saves.

  Concurrent rotation to one epoch is tested but not seen failing, because the unique `(chat, epoch)` index also catches it.
- **Build**: 6.74 MB (`@ai-sdk/mcp`, `@exalabs/ai-sdk` added).
- **Left for later**:
  - Phase 4: `Watch`/`LiveFrames`, detached and resumable runs, `chats.stop`, stream waits in place of the 1 s Code Mode poll;
  - slice 6: Worker chat tools in `/api/chat`, the Worker temp-directory fallback, deleting ACP chats and changing their scope;
  - slice 4: the remaining chat-key routers;
  - slice 5: notification sealing and Web Push. Run-end notification rows are already written.
- **Untested**: refusing a completion for a chat the actor cannot see. `tools.listMcpServers` decrypts each bearer secret to report `hasSecret`, which is a cost worth revisiting.

Web side, commit `cda8cff`:

- **Moved to tRPC or `POST /api/chat`**: Home (`useInfiniteQuery` over the keyset pages, `chats.listPinned`), Session screens, settings and tools panels, MCP dialog, uploads (`chatFiles.createUpload` → PUT → `register`) and Code Mode answers. `/api/chat` is same-origin with the cookie; the Convex site URL and bearer helper are gone. A custom fetch surfaces the server's message for 409s.
- **Wire format**: sealed boxes, envelopes and capsules cross the wire as base64url. The sealed content and the AAD are unchanged. `chat-keys.ts` has one conversion point to the tRPC shapes, because the chat-key reads and writes stay on Convex until slice 4.
- **Refresh**: `lib/trpc-error.ts` separates refusals from transient errors, so a network blip no longer closes a Session Tab. Lists refresh after own mutations, after a stream ends and on focus, with no polling. A run started in another tab appears on the next refetch until Phase 4.
- **Behavior changes**:
  - create, fork, rename, regenerate and attachments need chat keys;
  - the Exa key field is owner-only;
  - a queued first prompt that exists only in a legacy sidecar is not restored, because the server cannot tell "consumed" from "unset".
- **Still on Convex**:
  - chat-key reads and writes (slice 4);
  - `Watch`/`LiveFrames` (Phase 4);
  - `acp.*`, `workers.list`, `agent_usage.GetChatCost` (slices 5–6);
  - `e2ee_legacy.storageUrl`.
- **ACP gaps for slice 6**: the visibility menu of a keyed ACP Session throws, because `chats.setScope` takes no re-signed binding. Deleting an ACP chat is refused, and the "also delete in the agent" step and its signed command were removed from the menu.
- **Checks**: web `tsc` has 101 errors (two baseline ones fixed, none new) and `vite:build` passes. The changed crypto and session tests pass: 71 tests. When the whole `lib/crypto` folder runs in one process, 2 `workspace-keys.test.ts` cases fail (6 at the previous commit) because Convex module mocks leak between files. The file passes alone (7/7).

### Slice 4 Results: E2EE (2026-11-22)

Server side, commit `5bff229` (`packages/server/src/e2ee/`, router `e2ee`):

- **Coverage**: every `api.e2ee.*` procedure the web calls. That is account status and the recovery wrapper, device recovery, trust store, identity directory, workspace key state and archived epochs, bootstrap/rotate/grants/roster, invites, phrases, join requests, chat keys (`chatKeys`, `setupChatKeys`, `rotateChatKey`, `addChatKeyWraps`, `signChatKey`, `staleWorkspaceWraps`, `replaceWorkspaceWraps`) and Worker pairing from the browser. No schema change.
- **Locking**:
  - every workspace key write takes the workspace row lock and re-checks access under it;
  - an access link is claimed by one conditional `delete … where expires_at > now() returning`;
  - the trust store is compare-and-swap (insert `on conflict do nothing`, then `update … where version = expected`);
  - the recovery wrapper changes only while the stored wrapper is still the one the signature covers;
  - device recovery offers are Valkey keys with a 15-minute TTL, written by a script that will not overwrite another user's slot, and taken with `GETDEL`.
- **Behavior changes**:
  - `revokeInvite`, `dismissJoinRequest` and `removePhrase` take `workspace`;
  - `myKeyStatus` needs a session;
  - `staleWorkspaceWraps` pages by a keyset;
  - `getInvite` is `null` once access is lost;
  - a replacement wrap with the stale wrap's recipient key is refused;
  - setup-code pairing requires the enrollment to be completed by that Worker with its current proof key;
  - certification also requires an active Worker;
  - rate limits hash the client address, which the web forwarder passes with the proxy secret for every `/api/*` request.
- **Not ported**: custody, legacy, migration and freeze gates, and `pruneDeviceRecovery` (Valkey TTL replaces it). Retention now covers expired invites and pairings past 7 days.
- **Checks**: 30 files and 353 tests pass, with 38 E2EE tests ported from the Convex suites and boundary cases for every procedure. Typecheck, build and `db:check` pass. Concurrency tests were each seen failing with their guard removed: the roster version race, invite accept race, trust store compare-and-swap and recovery take race.
- **For slice 6**:
  - Worker machine procedures over the exported services (`publishWorkerKeys`, `workerTrustState`, `workerIdentities`);
  - dispatch gating (`requireDispatchableWorker`);
  - `deleteWorkerKeys` in the revoke transaction.

Web side, commit `a7ecc86`:

- **Moved to `trpc.e2ee`**: every `api.e2ee.*` caller (key manager, trust store, chat keys, workspace keys, invites, phrases, device recovery, Worker pairing UI), with base64url bytes. The slice 3 dual-format conversion in `chat-keys.ts` is gone. `useServerKeyStatus` skips signed-out users.
- **Deleted**: the custody cutover gate (`encryption-cutover-gate.tsx`).
- **Still on `cryptoClient()` (Convex)**: only `acp.*` (`acp-crypto.ts`, with `chatKeysToConvex` for the three ACP calls that still take `ArrayBuffer`), `workers.createEnrollment/list`, `e2ee_legacy.storageUrl` and `e2ee_legacy_relay.*`.
- **Freshness**: key state refetches after mutations, on focus and after the sync writes (which now report whether they wrote).
- **Checks**:
  - web `tsc` 101 (none new); `vite:build` passes;
  - `bun test src/lib/crypto` passes in one process (70 tests); the mock leak was `legacy-relay.test.ts`'s `mock.module`.
- **Known gaps**:
  - ACP chats exist only in Convex until slice 6, so their chat-key paths fail on this branch.
  - The device-recovery poll treats the new rate-limit refusal as transient.

Browser check of slices 1–4 (built server through the forwarder, existing dev accounts):

- **Sign-in and keys**: OPAQUE sign-in unlocked the keys through tRPC. Both owned workspaces were bootstrapped to key epoch 1 by the workspace sync.
- **Sealed rename**: renaming a workspace to "Ann Labs" stored only a `workspace_member` box (epoch 1); the row keeps the placeholder name, and the UI shows the decrypted name.
- **Gateway**:
  - the API keys page created a key and showed it once;
  - with a key from `keys.create`, `GET /api/openai/v1/models` answered 200 (`[]`, no providers configured) and a chat completion answered 500 `Unknown model`;
  - an invalid key answered 401.
- **Not exercised in the browser**: a chat turn. It needs a configured upstream provider; the server suite covers it with a stubbed upstream.

### Slice 5 Results: Notifications, Usage, Telemetry, Logging (2026-11-25)

Server side, commit `589f9c7` (routers `notifications`, `logging`, `usage`, `telemetry`, `telemetryExport`):

- **Notifications**:
  - `recent`/`claim`/preferences/devices go through tRPC;
  - sealing to the recipient's active identity is the `notifications.seal` outbox job;
  - the Web Push fallback is `notifications.fallback`, due 10 s after creation;
  - pushes carry the sealed box plus generic text, never title or body text;
  - VAPID push uses `@block65/webcrypto-web-push`;
  - a 404/410 response deletes a subscription unless its keys were re-registered since;
  - jobs are queued only when they can act (an identity to seal to, a push device), so a device registered inside the 10 s grace misses that one push;
  - outbox jobs due within 30 s now run from an in-process timer, with the sweep as the backstop.
- **Usage**:
  - activity, generations, usage and chat cost reads; privacy uses the one chat access rule, so a shared chat the owner is not a member of is hidden from the owner too;
  - `usage:prices` runs every minute, so a model's first models.dev lookup waits for it;
  - services for slice 6: `recordAcpTurn` (idempotent per chat and command), `localUsageCursor`, `reportLocalUsage`, `finishLocalUsageSync`.
- **Telemetry**:
  - owner-only reads filtered by chat privacy, with keyset paging;
  - export destinations: secret headers in the Secret Store, a cap of 20, the key filters checked against Postgres `api_keys` (closes the slice 2 gap);
  - export delivery as an outbox job, at most once per request and destination;
  - retention as the hourly `telemetry:retention` task, and GC as `telemetry.gc` jobs;
  - large envelopes are stored in the object store and returned as a presigned `storageUrl`.
- **Logging**: `logging.ingest` (60 events per user per minute) writes to the structured stdout sink; there is no table.
- **Limits**: `exportLimitEvent` is ported but nothing calls it yet.
- **Not ported**: the freeze/resume sealing machinery, legacy sidecar cleanup, and the `telemetry_gc` table (the job payload replaces it).
- **New env**: `WEB_PUSH_VAPID_PUBLIC_KEY`/`WEB_PUSH_VAPID_PRIVATE_KEY` (both or neither) and `WEB_PUSH_SUBJECT` (defaults to `SITE_URL`), with the same values as Convex. Notifications older than 7 days are deleted by `retention`.
- **Checks**:
  - 39 files and 464 tests pass; typecheck, build (6.99 MB) and `db:check` pass; no migration;
  - push was tested against a local HTTPS push endpoint that decrypts the payload as a browser would and checks the VAPID signature;
  - these concurrency tests were each seen failing with their guard removed: claim and fallback `seen_at is null`, the device cap lock, the endpoint upsert, the preference merge, `recordAcpTurn` dedupe, the local-usage lock, the export claim, the destination cap, and the GC lock and capture retry.
- **Not tested**: the S3 presign path for envelopes, retention paging past 200 workspaces, the 1 s content export cap, and a real push service.

Web side, commit `556472d`:

- **Moved to tRPC**: the notification center, toasts and push subscription; the service worker decode (same payload shape, `id` and a base64url box); logging; activity, logs, Project usage and chat cost; every telemetry screen (keyset paging through `useInfiniteQuery`) and destinations (Postgres key ids, no Convex cast).
- **Telemetry decrypt**: fetches `storageUrl` when the envelope is not inline. Sealed and legacy detection checks `!= null`, since the server sends `null` where Convex omitted a field.
- **Freshness until Phase 4**:
  - `notifications.recent` refetches on focus and every 30 s while a tab is visible. A tab can therefore see a notification up to 30 s late, and the 10 s push may arrive first.
  - Chat cost refetches when a turn ends; telemetry and activity refetch on focus and mount.
- **Checks**: web `tsc` 101 (none new); `vite:build` passes and the service worker bundle contains no server runtime; `bun test src/lib/crypto` 70/70.
- **Gap closed by `ea4a786`**: historical `legacy_content` boxes stored outside the row (`storageId`, imported to `files/<storageId>`) are served by `e2ee.legacyStorageUrl({ table, record })`, a presigned GET or the same-origin `/api/files/legacy` route on the local-disk store.
  - It uses the Convex authorization per source table, including personal-chat privacy, and the table name is an allowlist.
  - The `storageId` is read from the row itself. Authorization runs before the "no envelope" answer, so existence cannot be probed.
  - Object release now spares any `files/` key a `legacy_content` box still names; the tables are listed once in `e2ee/legacy-tables.ts`.
  - 44 files and 563 tests pass.

### Slice 6 Results: Worker and ACP (2026-11-25)

Server side, commit `07b5c07` (`packages/server/src/{worker,acp}/`, routers `workers`, `acp`, and the machine router `worker.*` on `workerProcedure`):

- **Machine auth**:
  - `POST /api/worker/auth/{challenge,complete}` keeps the Convex contract;
  - challenges are 60 s Valkey keys taken with `GETDEL` before the proof is checked;
  - enrollment completion is one conditional update;
  - tokens are ES256 signed with `WORKER_AUTH_PRIVATE_JWK` (new, optional; same value as Convex, and it must match a key in `WORKER_AUTH_JWKS`);
  - rate limits are 10 setup codes and 120 challenges per minute per workspace.
- **Revocation** is one transaction under the Worker row lock: the identity epoch is bumped, the Worker's E2EE keys are deleted, its Gateway key is revoked, and its open tasks, ACP commands, interactions and busy sessions are failed (`ACP_ABANDONED`). Presence and warm sessions are cleared after commit.
- **Worker state**:
  - presence is a Valkey hash (7-day TTL);
  - sealed tasks have dispatch dedupe, claim-once and fenced completion;
  - Gateway state, models and key minting;
  - local usage sync over the slice 5 services;
  - the temp-directory fallback for chats without a Project folder.
- **ACP**: only the signed and sealed path is ported. Every chat-scoped call goes through `requireChatAccess`.
  - Workers report error codes, never free text; `setConfig`/`setMode` keep no draft.
  - `createSession` refuses uncertified Workers (`WORKER_NOT_PAIRED`) and keyless workspaces (`ACP_E2EE_REQUIRED`).
  - A session's index paging is a keyset; when Project folders overlap, the oldest Project owns the session.
- **Slice 3 gaps closed**:
  - `chats.setScope` takes the re-signed `acpBinding` for the new audience;
  - `chats.delete` queues the signed `close`/`delete` command for the Worker before the chat is deleted.
- **Retention**:
  - finished commands after 5 min and resolved interactions after 10 min;
  - unclaimed commands after 7 days, which also fails a session stuck in `starting`;
  - terminal Worker tasks after 5 min;
  - pending or revoked enrollments 7 days past expiry.
- **Checks**: 43 files and 538 tests pass; typecheck, build (7.17 MB) and `db:check` pass; no migration. Every invariant's concurrency test was seen failing with its guard removed: command dedupe, claim once, one turn per chat, epoch fencing, the warm cap, first answer wins, task dispatch dedupe, task claim, fenced completion, enrollment single use.
- **Phase 4 blocker found here**: nothing cools ACP sessions yet. A prompt warms a session in `acp:warm:<worker>` (24 h TTL), and only revocation or chat deletion takes it out, so a Worker prompted in 64 chats refuses further prompts with `ACP_WORKER_BUSY`. Cooling needs the viewer signal (`acp.cool`, Phase 4). This branch is not released before Phase 4, so no stopgap was added.
- **Phase 4**:
  - `appendFrames`, `LiveFrames`, `StreamCapsule` and the epoch capsule stored with its stream (`chat_frames`/`acp_streams` are not ported);
  - viewer heartbeats, `acp.cool`, Worker inbox doorbells and stream waits;
  - the Worker chat tools in `/api/chat`; the dispatch services are exported from `src/worker/tasks.ts`.
- **Not ported**: the plaintext ACP and edit writers closed by the cutover, unused `worker_tasks.create`/`updateStatus`, and the `worker_presence`/challenge/chat-call cleanups (Valkey TTLs and foreign keys replace them).

Web side, commit `848e209`:

- **Moved to tRPC**: every `api.acp.*` and `api.workers.*` caller, with base64url signed commands, bindings and sealed answers and titles. `workers.list` goes through one hook (`use-workers.ts`). The Convex crypto transport (`cryptoClient`, `chatKeysToConvex`) is gone.
- **Restored** with the slice 3 gaps closed:
  - the keyed ACP Session visibility menu (re-signed binding at stored version + 1);
  - "also delete in the agent", with its signed `close`/`delete` command. If the Worker is no longer certified, the chat is deleted without the command.
- **Legacy envelopes**: `legacy-content.ts` reads them through `e2ee.legacyStorageUrl`. The unused historical relay and frame readers are deleted.
- **Polling until Phase 4**:
  - `getSession`/`openInteractions` every 5 s while the session is busy, or for 60 s after the user's own command;
  - `workers.list` every 30 s while visible, so presence does not go stale;
  - agent sign-in waits on `acp.getCommand` every 5 s for at most 10 min;
  - everything else refetches on focus and after own mutations.
- **Missing until Phase 4**: the ACP transcript and live turns (no frames are persisted or streamed; the screen says "Live agent output is not connected yet"), history paging, the viewer heartbeat, and push of another client's prompt.
- **Checks**:
  - web `tsc` dropped from 101 to 28 errors, because the web app no longer type-imports `backend/convex/_generated/api`. All 28 are the pre-existing Better Auth UI `components/auth/*` ones.
  - `vite:build` passes; `bun test src/lib/crypto` 66 (4 tests of deleted readers removed); `bun test src/components/session` 47.
- **Convex left in the web app**: only shell and auth scaffolding (`ConvexQueryClient` in `router.tsx`/`__root.tsx`, `ConvexBetterAuthProvider`/`useConvexAuth`/`ConvexQueryCacheProvider` in `providers.tsx`, the `convexClient` auth plugin) and about 38 type-only `Id` imports from `backend/convex/_generated/dataModel`. No data call goes to Convex. These go in Phase 5.

Hardening found in the browser check: tRPC attached stack traces to non-internal errors because the built server ran without `NODE_ENV=production`; `init.ts` now sets `isDev: false`, so stacks are never sent.

Browser check of slices 5–6 (built server through the forwarder, existing dev account):

- Activity, Logs, Telemetry, Notifications settings, Workers and ACP settings all render with no request errors. The ACP registry list loads.
- `workers.createEnrollment` returned a setup code with its expiry once dev-only `WORKER_AUTH_PRIVATE_JWK`/`WORKER_AUTH_JWKS` were set. An unknown workspace answers `NOT_FOUND` with no stack.
- **Not exercised**: Worker enrollment and every machine route (the Worker client is still on Convex until Phase 5; the server suite covers them), Web Push (no VAPID keys in the dev env), and ACP sessions (no Worker).
- **Operator note**: JSON-valued variables (`WORKER_AUTH_PRIVATE_JWK`, `WORKER_AUTH_JWKS`) do not survive `set -a; . ./.env` in a shell, which strips their quotes. Start with Bun's own `.env` loading or a compose `env_file`.

### Phase 3 Outcome

- **All six slices are on the new backend**: 44 server test files and 563 tests against real Postgres and Valkey, and every invariant in the [table](../Backend_Migration/Runtime.md#transactions-and-invariants) has a concurrency test that was seen failing without its guard. The web app makes no Convex data calls.
- **What Phase 4 must close before any release**:
  - ACP cooling (the warm cap blocks a Worker after 64 prompted chats);
  - the ACP transcript and live frames;
  - Worker inbox doorbells;
  - Worker chat tools in `/api/chat`;
  - live invalidation replacing the polls listed above;
  - detached and resumable built-in runs.
- **Phase 5**: the Worker client (`packages/worker`) still calls Convex. Its machine procedures exist under `worker.*` (shapes in slice 6 above). The web shell still mounts the Convex providers.
- **Phase 6 env values that must equal the Convex deployment's**: `SECRET_STORE_KEYS`, `TELEMETRY_HASH_SECRET`, `LWC_SECRET`, `WEB_PUSH_VAPID_*`, `WORKER_AUTH_PRIVATE_JWK`/`WORKER_AUTH_JWKS`, `BETTER_AUTH_SECRET`, `OPAQUE_SERVER_SETUP`.

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
