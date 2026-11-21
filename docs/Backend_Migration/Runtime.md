# Backend Runtime And Code Layout

Status: **planned.** Part of the [backend migration](../Backend_Migration.md). Covers how the new backend is organized, how one codebase deploys to Bun or to serverless targets, and the conventions that replace Convex's.

The goal is a backend that reads like an ordinary TypeScript service, with no shape inherited from Convex. Port domain _behavior_ and its tests; rewrite the mechanics. The `AGENTS.md` code-clarity rules apply unchanged.

## Packages

```
packages/
  contracts/        runtime-neutral code shared by web, Worker and backend (new)
  crypto/           unchanged (radium-crypto)
  backend/
    drizzle/        generated SQL migrations + journal (committed)
    nitro.config.ts Nitro build: preset, scheduled tasks, driver aliases
    server.ts       Nitro server entry: exports the Hono app
    src/
      app.ts        createApp(): the Hono app (all routes, tRPC mount)
      drivers/      db, kv, objects: bun.ts and portable.ts (chosen at build time)
      db/           Drizzle client type, schema barrel, ids, migrator, backfills/
      trpc/         init, context, procedures (session/workspace/owned/worker), root router
      http/         non-tRPC routes: gateway, auth, worker auth, chat stream, stream/shape proxies
      jobs/         outbox dispatcher; scheduled jobs as Nitro tasks
      import-convex/  frozen baseline schema + mappings (see Convex_Import.md)
      <domain>/     schema.ts, services, router.ts, tests: one folder per domain
    bin/
      migrate.ts    applies SQL migrations and backfills
      import-convex.ts  one-time importer
  worker/           Radium Worker: tRPC client + stream reader (transport rewritten)
apps/web            tRPC client, TanStack Query, TanStack DB collections, /api/* forwarder
```

Deleted at the end: `packages/backend/convex/`, `packages/worker-component/`, `scripts/convex-ready.ts`, and every `convex`, `@convex-dev/*`, `convex-helpers`, `convex-secret-store` and `convex-test` dependency.

Domains: `auth`, `workspaces` (with projects, preferences), `gateway` (providers, models, credentials, keys, routing, limits, subscriptions), `chatroom` (chats, messages, files, titles, code mode, tools), `acp`, `worker` (identity, tasks, presence, gateway access), `e2ee`, `telemetry`, `usage`, `notifications`, `logging`. Each domain owns its tables, its authorization checks and its queries, so database access and authorization stay together as `AGENTS.md` requires. Other domains call a domain's exported service functions, never its tables.

### `packages/contracts`

The web app imports 67 files from `backend/src/*` today, several of them runtime code (`acp/fold`, `models_dev`, `worker/presence`, `chatroom/tools`). That import direction stops. Code needed by more than one of web, Worker and backend, and free of server dependencies, moves to `packages/contracts`: zod schemas for wire shapes, branded id types, ACP op types and fold, presence windows, limits and constants. The web app imports only `contracts`, `crypto` and the backend's `AppRouter` **type**.

## Deployment Targets: Nitro

The backend is a **Nitro v3** project whose server entry is the Hono app. Nitro supplies what would otherwise be per-vendor glue: one build per **preset** (`bun`, `node_server`, `deno_server`, `cloudflare_module`, `vercel`, `netlify`, `aws_lambda`, …), runtime config from env, startup and shutdown hooks, `waitUntil` where the platform has one, and scheduled tasks wired to the platform's native scheduler. The web app already builds with Nitro (`nitro()` in `apps/web/vite.config.mts`), so this adds a toolchain we already run rather than a new one, and no vendor SDK enters domain code.

```ts
// packages/backend/server.ts
import { createApp } from "./src/app";
export default createApp(); // Hono app; Nitro adapts it to the preset
```

Nitro is used for build, deploy, config, lifecycle and tasks. Its data layers are **not** used:

- `db0` (`nitro/database`) is experimental, wraps tagged-template SQL, and has no `Bun.SQL` connector (Postgres goes through `pg`). Drizzle stays the only database API.
- `unstorage` (`nitro/kv`) is a get/set store whose Redis driver is `ioredis`. It has none of the atomic operations Valkey is here for (`SET NX`, `GETDEL`, `INCR`, sorted sets, scripts), and it would bypass `Bun.RedisClient`.

Hono stays the router: the tRPC adapter, Better Auth handler and Gateway routes keep their Hono shape. Nitro file routes and H3 handlers are not used.

### Drivers

Only three things differ by runtime. Each has a Bun implementation and a portable one, picked at **build time** from the Nitro preset through a module alias (`#drivers` → `src/drivers/bun.ts` or `src/drivers/portable.ts`), so a Bun build never bundles the portable libraries and a serverless build never references `bun`. Nothing outside `src/drivers/` imports `bun` or a driver package.

| Driver                               | `bun` preset                                                                              | Every other preset                                                                                                                                                                  |
| ------------------------------------ | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `db`: Drizzle `PgDatabase`           | `drizzle-orm/bun-sql` over `Bun.SQL`                                                      | `drizzle-orm/postgres-js`. A platform pooler (Hyperdrive, Neon, Supabase, RDS Proxy) is just a different `DATABASE_URL`, plus Hyperdrive's `prepare: true` requirement as an option |
| `kv`: the Valkey commands we use     | `Bun.RedisClient` (`send` for scripts and `GETDEL`)                                       | `@redis/client` (node-redis core) over TCP; not the `redis` meta-package, which bundles about 1.3 MB of module clients                                                              |
| `objects`: put, get, delete, presign | `Bun.S3Client` (any S3-compatible store) or a local-disk adapter for single-node installs | `aws4fetch` against any S3-compatible API (S3, R2, MinIO, Garage)                                                                                                                   |

Durable Streams and Electric are reached with `fetch` and `@durable-streams/client` everywhere, so they need no driver. The Drizzle type is the common `PgDatabase<…, typeof schema>`; any driver-specific feature (Bun SQL's `sql.array`, Postgres.js `sql.json`) outside `src/drivers/` is a review blocker. Phase 0 verified the alias in both directions on Nitro's `bun` and `node_server` presets; `bun` is marked external in `nitro.config.ts` so rolldown doesn't warn that it can't resolve it.

Lifetime differs by preset. Long-lived presets (`bun`, `node_server`, `deno_server`) create pools and Valkey connections once in a Nitro startup plugin. Serverless presets create them per request where the platform forbids shared sockets. Services receive drivers through the Hono/tRPC context, never module singletons, so both lifetimes run the same code.

### Long-lived vs serverless presets

| Capability                                                  | `bun` / `node_server` / `deno_server` | Serverless presets                                                                                                  |
| ----------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Detached runs (reply keeps generating after its tab closes) | Yes                                   | No: the run ends when the request ends, plus the platform's `waitUntil` grace. Stop and resume still work           |
| Scheduled tasks                                             | Nitro `scheduledTasks` (croner)       | Native on Cloudflare and Vercel through Nitro; elsewhere an external scheduler calls an authenticated task endpoint |
| After-commit job dispatch                                   | in-process                            | `waitUntil` when available; the one-minute outbox sweep covers the rest                                             |

Vendor primitives that Nitro does not abstract (Durable Objects, Workflows, Queues) are not used. The `bun` preset is the reference deployment; serverless presets are supported for the features in the right-hand column.

## Configuration

| Variable                                                         | Purpose                                                                                                              | Replaces                              |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `SITE_URL`                                                       | Web origin (cookies, CORS for direct API clients, reset links, VAPID subject default)                                | same                                  |
| `API_URL`                                                        | Public backend origin: Gateway base URL, Worker JWT issuer/audience, Worker setup codes                              | `CONVEX_SITE_URL`, `CONVEX_CLOUD_URL` |
| `DATABASE_URL`                                                   | Postgres, or a platform pooler URL on serverless presets; migrations and the importer always use a direct connection | new                                   |
| `VALKEY_URL`                                                     | Valkey (`Bun.RedisClient` also reads `REDIS_URL`/`VALKEY_URL`)                                                       | new                                   |
| `STREAMS_URL`, `STREAMS_TOKEN`                                   | Internal Durable Streams server and the bearer the backend uses; the server is never exposed publicly                | new                                   |
| `ELECTRIC_URL`, `ELECTRIC_SECRET`                                | Optional; enables Electric-sourced collections                                                                       | new                                   |
| `S3_*` or `FILES_DIR`                                            | Object store (Bun's S3 env names, also read by the portable driver) or local disk                                    | Convex File Storage                   |
| `BETTER_AUTH_SECRET`, `OPAQUE_SERVER_SETUP`, `AUTH_PROXY_SECRET` | Unchanged; must be the same values as the Convex deployment for sessions and OPAQUE logins to survive                | same                                  |
| `SECRET_STORE_KEYS`                                              | Unchanged format and values; KEKs for the `secrets` table                                                            | same                                  |
| `TELEMETRY_HASH_SECRET`, `TELEMETRY_HASH_PROVENANCE`             | Unchanged                                                                                                            | same                                  |
| `WORKER_AUTH_PRIVATE_JWK`, `WORKER_AUTH_JWKS`                    | Unchanged keys; the issuer string changes to `API_URL`                                                               | same                                  |
| `WEB_PUSH_VAPID_*`, `LWC_SECRET`                                 | Unchanged                                                                                                            | same                                  |

`AISDK_MaxRetries` is declared in `convex.config.ts` but never read; drop it unless the port wires it. Web: `VITE_CONVEX_URL`/`VITE_CONVEX_SITE_URL` go away; the web server gets `API_INTERNAL_URL` (where `/api/*` is forwarded) and the browser needs no backend URL at all.

## HTTP Surface

| Path (backend)                               | Auth                                                                | Notes                                                                                 |
| -------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `/api/trpc/*`                                | Better Auth session cookie, or Worker JWT for the `worker.*` router | `@hono/trpc-server`; batching on                                                      |
| `/api/auth/*`                                | Better Auth                                                         | Same OPAQUE ingress checks (`Origin === SITE_URL`, proxy-secret client IP)            |
| `/api/openai/v1/chat/completions`, `/models` | Gateway API key                                                     | Paths and behavior unchanged; direct backend origin                                   |
| `/api/worker/auth/{challenge,complete}`      | Proof / setup token                                                 | Unchanged contract                                                                    |
| `/api/chat`                                  | Session                                                             | AI SDK UI message stream; replaces `/api/aisdk/chat`                                  |
| `/api/streams/*`                             | Session or Worker JWT                                               | Authorizing proxy to Durable Streams ([Live data](Live_Data.md#stream-proxy))         |
| `/api/shapes/:collection`                    | Session                                                             | Electric shape proxy; table, columns and `where` set server-side                      |
| `/api/files/*`                               | Session                                                             | Presign upload, register, download redirect, and legacy Convex storage URL resolution |
| `/api/subscription/chatgpt-subscription/*`   | Session + owned workspace                                           | Unchanged                                                                             |

The web server forwards `/api/*` to `API_INTERNAL_URL` as a streaming pass-through. This generalizes `apps/web/src/app/api/backend/$.ts` and absorbs the auth proxy's header handling: strip client-sent proxy headers, add `x-radium-proxy-secret` and the client IP. SSR prefetch calls the backend the same way with the incoming cookie forwarded. When web and backend are deployed to the same host, the forward stays on the internal network.

## tRPC Conventions

- One router per domain (`src/<domain>/router.ts`), merged in `src/trpc/router.ts`. Procedure names are camelCase verbs (`chats.list`, `chats.rename`), not the mixed `GetChat`/`ListChats` casing Convex grew.
- Procedures are thin. They parse input with zod (shared schemas from `contracts`), call one service function, and map domain errors to `TRPCError` codes. Services take `(drivers, actor, input)` and own authorization.
- Base procedures replace the Convex wrappers:
  - `publicProcedure`;
  - `sessionProcedure`: Better Auth session resolved once per request (Valkey `secondaryStorage` cache);
  - `workspaceProcedure`: input has `workspace`; checks owner or direct member, archived workspaces rejected;
  - `ownedWorkspaceProcedure`;
  - `workerProcedure`: ES256 JWT verified with `jose` against `WORKER_AUTH_JWKS`, issuer `API_URL`, kind `worker`; then the identity epoch and revocation are re-checked (Valkey cache, invalidated on revoke). This is the same check `src/worker/machine.ts` does after `ctx.auth`.
- Personal-chat privacy lives in the `chatroom` service's access function (today `authorizeChatForUser`), reused by tRPC, `/api/chat`, the stream proxy and the shape proxy. There is one implementation.
- Outputs are plain JSON. Binary fields cross the wire as base64url strings defined in `contracts` (Convex's `v.bytes()`/`ArrayBuffer` transport disappears); `radium-crypto` already works on `Uint8Array`.
- Pagination is keyset-based (`(last_interaction_at, id)` cursors), replacing `paginate` and convex-helpers' merged streams.
- Web client: `@trpc/tanstack-react-query` with `httpBatchLink` to the same origin. Route loaders prefetch with `queryOptions`; mutations invalidate exact query keys, and invalidation events from streams do the same for other tabs and devices ([Live data](Live_Data.md#invalidation-events)). The `expectAuth` gate of `ConvexQueryClient` is unnecessary because cookies go with every request.

tRPC subscriptions are **not** used. Live data comes from streams and shapes over plain HTTP, which keeps the backend stateless on both runtimes.

## Auth

- Better Auth with `drizzleAdapter(db, { provider: "pg" })`; its tables are generated into the `auth` domain schema by the Better Auth CLI. Never hand-edit that file, same rule as today's generated component schema.
- `secondaryStorage` on Valkey for sessions and Better Auth's rate limiter (replaces `rateLimit.storage: "database"`).
- Plugins: `@alkalines/better-auth-opaque` with the same options and `createOpaqueHooks`. The hooks call the `e2ee` service directly instead of `ctx.runMutation(internal.e2ee.*)`. The `convex()` plugin and its `jwks` table are removed; there is no Convex JWT anymore.
- Cookies live on the web origin because the browser only talks to it. Existing sessions survive the move when `BETTER_AUTH_SECRET` and the session rows are carried ([import](Convex_Import.md#better-auth)).
- Gateway API keys: the `rad-sk-…` SHA-512 hash lookup stays; the resolved key-to-workspace mapping is cached in Valkey for a short TTL and deleted on revoke.
- Rate limits (`@convex-dev/rate-limiter` call sites: Worker setup 10/min, challenge 120/min, OPAQUE account attempts, device recovery offers and takes, log ingest) become Valkey fixed-window or token-bucket counters in one `ratelimit` helper owned by `auth`.

## Database Conventions

- **Ids**: `text` primary keys. Imported rows keep their Convex `_id`; new rows use UUIDv7 from `db/ids.ts`. Never parse or assume an id format.
- **Time**: `created_at timestamptz(6) not null default now()` replaces `_creationTime` on every table. Code that ordered or windowed by `_creationTime` (usage activity, orphan sweep, telemetry provenance, `lastInteractionAt` fallbacks) uses it explicitly. Imported values are rounded to microseconds. Rounding never reorders rows, but rows written by one Convex mutation can tie (13 tables in the Phase 0 export), so every ordering by `created_at` adds `id` as a tiebreaker. Order that matters inside one write needs an explicit column, as `chat_messages.position` already provides.
- **Binary**: `bytea`. **Free-form JSON**: `jsonb`, only where the shape is open (AI SDK message parts, provider metadata, subscription state). Everything Convex stored as a nested validated object becomes columns or a child table when it is queried or indexed (`chat_completions.bill.*`, `request.*`), and stays `jsonb` with a zod schema when it is opaque to SQL (`workspace_configurations.snapshot`, `credential_limits.meters`).
- **References**: real foreign keys with an explicit `on delete` per edge (`cascade` for owned children such as chat messages or wraps, `restrict` or `set null` elsewhere). Convex had none; each hand-written cascade (`cleanupChatContent`, `continueMemberRemoval`, `detachChats`) becomes a constraint or one transaction.
- **Enums**: `text` with `check` constraints mirrored by zod enums in `contracts` (no `pgEnum`, which makes widen-migrate-narrow harder).
- **Indexes**: derived from actual queries, not copied from the 14 indexes on `aisdk_chats` or the 13 on `telemetry_requests`. Each index cites the query it serves in a comment.

## Transactions And Invariants

Each of these relied on Convex serializing mutations. Each gets a concurrency test in its domain (two parallel calls, exactly one wins).

| Invariant                                                                               | Today                                         | Replacement                                                                                                       |
| --------------------------------------------------------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| One ACP turn per chat                                                                   | `acp.Prompt` status check + patch             | `update acp_sessions set status='starting' where chat=$1 and status in ('idle','failed') returning`               |
| One built-in run per chat                                                               | not enforced (last `onEnd` wins)              | `chat_runs` partial unique index on `chat` where active                                                           |
| Command dedupe by `clientId`                                                            | index lookup then insert                      | unique `(worker, issuer, client_id)` + `on conflict do nothing returning`                                         |
| Command claimed once, payload erased                                                    | CAS in mutation                               | conditional `update … where status='pending' returning`, payload set null in the same statement                   |
| Frame order / exact retry                                                               | `acp_streams.nextSeq` row                     | Durable Streams idempotent producer (producer id per Worker and epoch, sequence numbers)                          |
| Epoch fencing (`epoch`, `cooledEpoch`)                                                  | read-compare-patch                            | conditional update on `acp_sessions`; the stream proxy checks the fence (Valkey-cached) before forwarding appends |
| Warm cap: at most 64 warm sessions per Worker                                           | count then patch                              | Valkey script: `ZCARD` + `ZADD` atomically on `warm:<worker>`                                                     |
| First ACP answer wins                                                                   | status CAS                                    | conditional update `pending → answered`                                                                           |
| First Code Mode answer wins                                                             | status CAS                                    | Valkey `SET NX` on the interaction key                                                                            |
| Worker task dispatch dedupe                                                             | `.unique()` on `(workspace, worker, request)` | unique constraint                                                                                                 |
| Worker task claim and fenced completion                                                 | `claimId`, `revision` CAS                     | conditional updates on `(status, claim_id, revision)`                                                             |
| Worker challenge single use                                                             | consume in mutation                           | Valkey `GETDEL`                                                                                                   |
| Enrollment single use, identity epoch                                                   | component mutation                            | conditional update `pending → completed`, epoch column                                                            |
| Routing cursors, cooldowns, session affinity                                            | hot document upserts                          | Valkey hashes with TTL; atomic `HINCRBY`/scripts                                                                  |
| Limit poll lease                                                                        | `nextPollAt` lease mutation                   | `select … for update skip locked` in the poll job                                                                 |
| Budget recompute debounce                                                               | `runAfter(5s)`                                | outbox job with a unique dedupe key                                                                               |
| Notification claimed by a tab vs push fallback                                          | row CAS                                       | conditional `update … where seen_at is null returning`                                                            |
| Uniqueness by `.unique()` (`api_keys.hash`, viewers by tab, presence, streams by epoch) | throws on duplicates                          | unique constraints (or Valkey keys for moved state)                                                               |

The E2EE freeze flag (`assertLegacyWritesAllowed`) is not ported: the importer requires a completed cutover ([narrow first](Convex_Import.md#preconditions)).

## Jobs

### Outbox

Almost every `ctx.scheduler.runAfter` call is `runAfter(0)`, meaning "run after this mutation commits": title generation, notification sealing and push, usage pricing, telemetry export, cascades. The replacement is a `jobs` table written **in the same transaction** as the change that needs it:

`jobs(id, kind, payload jsonb, run_at, dedupe_key unique null, attempts, locked_until, last_error)`

- After commit, the request hands the new job ids to the dispatcher: in-process on long-lived presets, inside `waitUntil` on serverless presets that have it.
- A sweep every minute claims due jobs with `for update skip locked` and runs them, which covers crashes, deploys and delayed jobs (`run_at`: notification fallback after 10 s, superseded epoch deletion after 60 s, budget debounce after 5 s).
- Handlers are idempotent and bounded. A failed job retries with backoff up to a limit, then stays visible for operators.

pg-boss and graphile-worker were considered and rejected: both want a long-running Node poller on a direct connection, which doesn't fit serverless presets and would leave two job systems.

### Scheduled Work

| Convex cron                                                                                                | New home                                                                                                            |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `workers.pruneChallenges` (1 min)                                                                          | Valkey TTL on challenge keys                                                                                        |
| `routing.prune` (10 min)                                                                                   | Valkey TTLs                                                                                                         |
| `code_mode.pruneExpiredInteractions` (5 min)                                                               | Valkey TTL                                                                                                          |
| `e2ee.pruneDeviceRecovery` (15 min)                                                                        | Valkey TTL (single-use handoff, `GETDEL`)                                                                           |
| `worker_tasks.prune`, `acp.prune`, `limits.pruneEvents`, `notifications.prune`, `e2ee.pruneExpiredInvites` | one `retention` job (every 5 min), one bounded `delete` per table policy                                            |
| `acp.coolSessions` (1 min)                                                                                 | `acp.cool` job: finds stale viewers in Valkey and rings the Worker's inbox ([Live data](Live_Data.md#acp-sessions)) |
| `limits.pollDue` (5 min)                                                                                   | `limits.poll` job                                                                                                   |
| `chat_files.prunePendingUploads` (1 h)                                                                     | `files.orphans` job over object-store keys vs `chat_files`                                                          |
| `telemetryRetention.pruneExpired` (1 h)                                                                    | `telemetry.retention` job                                                                                           |

These run as Nitro tasks (`src/jobs/tasks/*`, registered through `tasks` in `nitro.config.ts` with absolute handler paths, since Nitro only scans `serverDir`; `scheduledTasks` there too), plus the one-minute outbox sweep. Each run takes a Valkey lease, so several replicas or overlapping serverless invocations run it once. The lease is a fixed key per task (`SET lease:<task> <id> NX PX <ms>`) with a TTL a little shorter than the interval. Keying it by time slot double-ran in Phase 0 when replicas fired on either side of a slot boundary. Phase 0 verified `scheduledTasks` on the `bun` and `node_server` presets. Nitro tasks are still marked experimental; if that blocks us, the long-lived presets fall back to `Bun.cron` in a startup plugin.

## Object Storage

`chat_files`, large `telemetry_blobs` and E2EE legacy sidecar envelopes move from Convex File Storage to the object store, keyed by their imported storage id (`files/<storageId>`). Uploads use presigned PUT URLs (`Bun.S3Client.presign`, or `aws4fetch` signing in the portable driver), then `files.register`. The local-disk adapter uploads through `/api/files` instead. Downloads redirect to short-lived presigned GETs. Message file parts persisted inside **sealed** messages still contain Convex storage URLs the server cannot rewrite; `/api/files` resolves them through `chat_files.legacy_url` ([import](Convex_Import.md#file-storage)).

## Secrets

The `secrets` table keeps `convex-secret-store`'s envelope exactly: a per-secret random DEK, AES-256-GCM value encryption with AAD `["value", namespace, name]`, and the DEK wrapped under the `SECRET_STORE_KEYS` version with AAD `["dek", namespace, name, version]`. Namespaces embed workspace, server and destination ids, which are preserved, so imported rows decrypt unchanged and the importer never handles plaintext. The code is about 100 lines of WebCrypto owned by `gateway/secrets.ts`, with the same write-only, masked-preview API. The `secretEvents` audit trail becomes `secret_events`.

## Schema Migrations

This is the policy that lets any install upgrade from any earlier release.

- **SQL migrations**: `drizzle-kit generate` writes `packages/backend/drizzle/NNNN_<name>.sql` and its journal in the same PR as the schema change. Merged migrations are never edited; fixes are new migrations.
- **Backfills**: `src/db/backfills/NNNN_<name>.ts` exports `run` (idempotent, bounded batches, resumable) and `verify` (exhaustive, returns issue counts). Progress and the last verify result live in a `backfills` table.
- **Widen → backfill → verify → switch → narrow** across at least two releases. A narrowing migration refuses to apply unless the matching backfill's recorded `verify` is clean. Same discipline as `convex/migrations.ts`, enforced by the runner instead of by convention.
- **One command**: `bun run --cwd packages/backend db:migrate` takes a Postgres advisory lock, applies pending SQL migrations in order, then pending backfills, then records the schema version. Because every migration since the Postgres baseline stays in the repo, an install on any earlier release reaches the current one in a single run. A squash to a new baseline happens only at a major version that documents the minimum version to upgrade from.
- **Boot check**: the server compares the recorded schema version with the one it was built for. If the database is behind, it refuses to start (long-lived presets) or answers `503` (serverless presets). It never migrates on its own. Operators and CI run `db:migrate` with a direct `DATABASE_URL`, never through a pooler.
- **CI**: on every PR, `drizzle-kit check`; regenerating must produce no diff; migrations apply to an empty database **and** to a snapshot of the previous release's database; backfill `verify` runs on that snapshot. Release jobs run `db:migrate` against a target only with explicit authorization (`AGENTS.md`).

## Verification

- Vitest stays the runner (`import { … } from "vitest"`). Backend tests run against **real** Postgres and Valkey from a `test` profile in `docker-compose.yml`, plus `@durable-streams/server` in memory. Each test file gets a fresh database cloned from a migrated template, so tests are isolated and fast.
- Router tests use `createCaller` with real sessions, covering authorization boundaries first: owner, member, outsider, personal-chat privacy, Worker revocation.
- Every invariant in [the table above](#transactions-and-invariants) has a concurrency test.
- The importer has fixture-based tests (a small Convex export ZIP in the repo, generated from a local deployment) and a rehearsal procedure ([runbook](Convex_Import.md#runbook)).
- Web: `vite:build` plus a typecheck against `AppRouter`; browser verification of chat, ACP, approvals and notifications across two tabs.
- Worker: existing unit and native suites, plus transport tests against a real backend.

As today, offline or unit tests are not deployment verification. Report integration checks as blocked when their infrastructure is missing.

## Serverless Spikes

A serverless preset is supported only after these pass on a real deployment, not a local emulator. Cloudflare (`cloudflare_module`) is the first target; the same list applies to any other preset.

1. Postgres through the portable driver and the platform's pooler (Hyperdrive on Cloudflare): a transaction with `for update skip locked`, prepared statements, a 5-minute streaming response holding no connection.
2. Valkey over TCP with TLS through `redis` (node-redis): scripts (`EVAL`), `GETDEL`, connections per request. Without working TCP, the preset is unsupported. We don't add a vendor-specific store.
3. A Durable Streams SSE read proxied for 10 minutes, and the AI SDK durable transport end to end.
4. Better Auth with the OPAQUE plugin, and `web-push` (Node crypto) or a WebCrypto Web Push library.
5. `@opencode/codemode` and MCP clients within the platform's CPU limits.
6. Nitro `scheduledTasks` and `waitUntil` reaching the Hono app on that preset.
7. The web deployment forwarding `/api/*` to the backend with streaming intact.
