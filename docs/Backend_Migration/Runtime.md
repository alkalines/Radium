# Backend Runtime And Code Layout

Status: **Phases 1–3 implemented** in `packages/server`: the foundation, the schema, and every domain (workspaces, gateway, chatroom, e2ee, notifications/usage/telemetry/logging, worker and ACP) with its tRPC routers and HTTP routes. The live layer (Phase 4), the Worker client cutover (Phase 5) and the importer (Phase 6) are still planned. Part of the [backend migration](../Backend_Migration.md). Covers how the new backend is organized, how one codebase deploys to Bun or to serverless targets, and the conventions that replace Convex's.

The goal is a backend that reads like an ordinary TypeScript service, with no shape inherited from Convex. Port domain _behavior_ and its tests; rewrite the mechanics. The `AGENTS.md` code-clarity rules apply unchanged.

## Packages

```
packages/
  contracts/        runtime-neutral code shared by web, Worker and backend
  crypto/           unchanged (radium-crypto)
  backend/          the Convex backend, unchanged until it is deleted (Phase 8)
  server/           the new backend (package `server`)
    drizzle/        generated SQL migrations, one folder per migration (committed)
    nitro.config.ts Nitro build: preset, scheduled tasks, driver alias, runtime plugin
    server.ts       Nitro server entry: exports the Hono app
    src/
      app.ts        createApp(): the Hono app (all routes, tRPC mount)
      config.ts     environment parsing (zod); errors name variables, never values
      runtime.ts    Runtime (config, drivers, auth, job handlers), start checks, process runtime
      kv.ts         typed Valkey commands over the driver's raw `send`, Lua scripts by EVALSHA
      drivers/      db, kv (objects with its first consumer): bun.ts, later portable.ts
      db/           column conventions, schema barrel, ids, migration runner, schema version, backfills/
      trpc/         init, procedures (public/session/workspace/owned/worker), root router
      plugins/      Nitro runtime plugins (start the runtime before traffic, close on shutdown)
      jobs/         outbox (enqueue, dispatch, sweep), handler registry, leases, tasks/
      import-convex/  frozen baseline schema + mappings (see Convex_Import.md)
      <domain>/     schema.ts, services, router.ts, tests: one folder per domain
    bin/
      migrate.ts         applies SQL migrations and backfills
      schema-version.ts  writes src/db/schema-version.ts after drizzle-kit generate
      import-convex.ts   one-time importer
    test/           Vitest global setup (template database) and per-file runtime helper
  worker/           Radium Worker: tRPC client + stream reader (transport rewritten)
apps/web            tRPC client, TanStack Query, TanStack DB collections, /api/* forwarder
```

The new backend is its own package rather than a folder inside `packages/backend`: that package's `src/` is Convex-era code with Convex-shaped names, an edge-runtime Vitest setup and a Convex tsconfig, and it stays the product until the cutover. Deleting it in Phase 8 is then one directory.

Deleted at the end: `packages/backend/` (including `convex/`), `packages/worker-component/`, `scripts/convex-ready.ts`, and every `convex`, `@convex-dev/*`, `convex-helpers`, `convex-secret-store` and `convex-test` dependency.

Domains: `auth`, `workspaces` (with projects, preferences), `gateway` (providers, models, credentials, keys, routing, limits, subscriptions), `chatroom` (chats, messages, files, titles, code mode, tools), `acp`, `worker` (identity, tasks, presence, gateway access), `e2ee`, `telemetry`, `usage`, `notifications`, `logging`. Each domain owns its tables, its authorization checks and its queries, so database access and authorization stay together as `AGENTS.md` requires. Other domains call a domain's exported service functions, never its tables.

### `packages/contracts`

Status: **created** (Phase 1). Runtime-neutral code needed by more than one of web, Worker and backend lives in `packages/contracts` (package `contracts`, sources exported as `contracts/<path>`, mirroring their old `backend/src/<path>` locations): the ACP contract, op types and fold; presence windows; Worker task, edit, Bash and chat contracts; chat tool names, session tools and the Code Mode runtime; e2ee wire contracts (`parseRegistrationPayload`, OPAQUE payload types, `legacyAad`); notification, logging, routing, usage, telemetry and limit-event contracts; models.dev mapping, provider snapshots and slugs; workspace colors, icons, names and selection. The web app and the Worker import none of `backend/src` any more; their remaining backend imports are the generated Convex bindings (Phase 5) and one Worker test that drives the Convex-bound `buildWorkerChatTools`. At the end of the migration the web app imports only `contracts`, `crypto` and the backend's `AppRouter` **type**.

Contracts depends only on `zod`, `radium-crypto`, `ai`, `@opencode/codemode` and `effect` (the last three for session tools and the Code Mode runtime); it never imports `convex` or any server package. Its tests run in Node and edge-runtime (`bun run --cwd packages/contracts test`, part of the root `bun run test`).

Shapes are zod schemas. Two cases zod has no type for go through `contracts/wire`: `idOf("table")` is a string schema typed as a branded `Id<"table">` (structurally the same as Convex's `Id`), and `bytes()` is the one binary schema, an `ArrayBuffer` for now so the later switch to base64url text happens in one place. Both register in the `wireTypes` registry.

While Convex still runs, its schema and function validators are derived from these zod schemas by `packages/backend/src/zod-validators.ts` (`zodToConvex`, `zodToConvexFields`): ids become `v.id(table)`, bytes `v.bytes()`. `convex-helpers`' `zodToConvex` cannot express either (it knows only its own `zid()` and maps other custom schemas to `v.any()`), so the converter covers exactly the subset contracts use and throws on anything else. The derived Convex schema and every function's argument and return validators were checked byte-identical to the hand-written `v` validators they replace.

## Deployment Targets: Nitro

The backend is a **Nitro v3** project whose server entry is the Hono app. Nitro supplies what would otherwise be per-vendor glue: one build per **preset** (`bun`, `node_server`, `deno_server`, `cloudflare_module`, `vercel`, `netlify`, `aws_lambda`, …), runtime config from env, startup and shutdown hooks, `waitUntil` where the platform has one, and scheduled tasks wired to the platform's native scheduler. The web app already builds with Nitro (`nitro()` in `apps/web/vite.config.mts`), so this adds a toolchain we already run rather than a new one, and no vendor SDK enters domain code.

```ts
// packages/server/server.ts
import { createApp } from "./src/app";
import { useProcessRuntime } from "./src/runtime";
export default createApp(useProcessRuntime); // Hono app; Nitro adapts it to the preset
```

`createApp` takes the function that resolves the request's `Runtime` (config, drivers, Better Auth, Worker token verifier, job handlers). Long-lived presets pass the process runtime, which `src/plugins/runtime.ts` starts and checks before Nitro serves traffic; a serverless preset will pass a per-request one.

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

Durable Streams and Electric are reached with `fetch` and `@durable-streams/client` everywhere, so they need no driver. The Drizzle type is `Database` in `src/drivers/types.ts`, `PgAsyncDatabase<PgQueryResultHKT, typeof relations>`, which a transaction also satisfies; any driver-specific feature (Bun SQL's `sql.array`, Postgres.js `sql.json`) outside `src/drivers/` is a review blocker. Valkey is the `Kv` interface, one raw `send(command, args)`, which both `Bun.RedisClient` and node-redis's `sendCommand` provide; `src/kv.ts` types the commands in use and runs Lua scripts with `EVALSHA`, sending the source only on `NOSCRIPT`. Phase 0 verified the alias in both directions on Nitro's `bun` and `node_server` presets; `bun` is marked external (`rolldownConfig.external`) so rolldown doesn't warn that it can't resolve it. Outside Nitro (Vitest, `bin/`), `#drivers` resolves through the `imports` field of `packages/server/package.json`.

Phase 1 ships only `drivers/bun.ts` with `db` and `kv`. The object-store driver arrives with its first consumer (chat files, Phase 3) and `drivers/portable.ts` with the serverless presets (Phase 7).

Lifetime differs by preset. Long-lived presets (`bun`, `node_server`, `deno_server`) create pools and Valkey connections once, in the Nitro runtime plugin, and close them on Nitro's `close` hook. Serverless presets create them per request where the platform forbids shared sockets. Services receive drivers through the Hono/tRPC context, never module singletons, so both lifetimes run the same code.

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

`src/config.ts` parses only what the implemented code reads: in Phase 1 `SITE_URL`, `API_URL` (both validated as an HTTPS origin, or HTTP on loopback), `DATABASE_URL`, `VALKEY_URL`, `BETTER_AUTH_SECRET`, `OPAQUE_SERVER_SETUP`, and optionally `AUTH_PROXY_SECRET` and `WORKER_AUTH_JWKS`. Each later slice adds its own variables there. A parse error lists the variable names and never their values. `packages/server/.env.example` mirrors the schema.

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

The web server forwards `/api/*` to `API_INTERNAL_URL` as a streaming pass-through (`apps/web/src/app/api/$.ts`, `apps/web/src/lib/backend-forwarder.ts`; it replaced `/api/auth/$` and `/api/backend/$`). It drops hop-by-hop and client-sent proxy headers, adds `x-radium-proxy-secret` and the client IP when `AUTH_PROXY_SECRET` is set, passes redirects back instead of following them, and strips `content-encoding`/`content-length` from the response. SSR calls the backend directly with the incoming cookie (`apps/web/src/lib/trpc.ts`). When web and backend are deployed to the same host, the forward stays on the internal network. `/api/health` answers `ok` without touching Postgres or Valkey.

## tRPC Conventions

- One router per domain (`src/<domain>/router.ts`), merged in `src/trpc/router.ts`. Procedure names are camelCase verbs (`chats.list`, `chats.rename`), not the mixed `GetChat`/`ListChats` casing Convex grew.
- Procedures are thin. They parse input with zod (shared schemas from `contracts`) and call one service function. Services take `(drivers, actor, input)` and own authorization.
- Services refuse with `AppError(code, message)` (`src/errors.ts`: `BAD_REQUEST`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`), never with tRPC errors, so they stay transport-neutral. `publicProcedure`, the base of every procedure, turns an `AppError` into the `TRPCError` of the same code and message. Anything else is an internal error: the client gets `Internal server error` with no stack, and the server logs only the innermost cause's name and message (Drizzle's query error, whose message lists statement parameters, is never logged).
- Base procedures replace the Convex wrappers (`src/trpc/init.ts`):
  - `publicProcedure`;
  - `sessionProcedure`: Better Auth session resolved once per request (Valkey `secondaryStorage` cache, Postgres on a miss); `UNAUTHORIZED` without one;
  - `workspaceProcedure`: input has `workspace`; owner or direct member in one query (`src/workspaces/access.ts`), archived workspaces rejected; `ctx.access.role` is `owner` or `member`. Outsider, archived and unknown all get the same `NOT_FOUND`;
  - `ownedWorkspaceProcedure`: the same, owners only, members also get `NOT_FOUND`;
  - `workerProcedure`: `Authorization: Bearer` ES256 JWT verified with `jose` against `WORKER_AUTH_JWKS` (issuer `${API_URL}/api/worker`, audience `radium-worker`, kind `worker`); then key, Worker status, identity epoch and workspace are re-read from Postgres on every call (`src/worker/auth.ts`), the check `packages/backend/src/worker/machine.ts` does after `ctx.auth`. One indexed join per call; a Valkey cache, invalidated on revoke, can come with the Worker slice if that join ever shows up in load. Without `WORKER_AUTH_JWKS` every Worker call is refused.
- Personal-chat privacy lives in the `chatroom` service's access function (today `authorizeChatForUser`), reused by tRPC, `/api/chat`, the stream proxy and the shape proxy. There is one implementation.
- Outputs are plain JSON. Binary fields cross the wire as unpadded base64url strings: inputs parse them with `base64urlBytes(maxBytes)` from `contracts/wire` (length bounded before decoding, `Uint8Array` after), outputs send `toBase64Url` text. Convex's `v.bytes()`/`ArrayBuffer` transport disappears slice by slice; `radium-crypto` already works on `Uint8Array`. Sealed boxes stored in `jsonb` (`legacy_content`) are already in that text form (`StoredJson`).
- Pagination is keyset-based (`(last_interaction_at, id)` cursors), replacing `paginate` and convex-helpers' merged streams.
- Web client: `@trpc/tanstack-react-query` (`createTRPCOptionsProxy`, created per router in `apps/web/src/router.tsx` and passed as `context.trpc`) with `httpBatchLink` to the same origin in the browser and to `API_INTERNAL_URL` during SSR. Route loaders prefetch with `queryOptions`; mutations invalidate exact query keys, and invalidation events from streams do the same for other tabs and devices ([Live data](Live_Data.md#invalidation-events)). The `expectAuth` gate of `ConvexQueryClient` is unnecessary because cookies go with every request.

tRPC subscriptions are **not** used. Live data comes from streams and shapes over plain HTTP, which keeps the backend stateless on both runtimes.

## Auth

- Better Auth with the Drizzle adapter's `relations-v2` entry (`@better-auth/drizzle-adapter/relations-v2`, the one for Drizzle 1.0); its tables are generated into `src/auth/schema.ts` by `bun run auth:schema` from `src/auth/schema-config.ts`. Never hand-edit or reformat that file, same rule as today's generated component schema. The generator writes `timestamp` without time zone for Better Auth's own columns; Drizzle writes and reads them as UTC regardless of the session time zone, and SQL comparing them with `now()` must cast. New Better Auth ids are UUIDv7 text (`advanced.database.generateId`), like every other table.
- `secondaryStorage` on Valkey (`src/auth/secondary-storage.ts`, keys prefixed `auth:`) for the session cache, Better Auth's per-address rate-limit counters (fixed windows by an `INCR`+`EXPIRE` script) and short-lived verification values (OPAQUE login state, reset tokens), so there is no `verification` or `rateLimit` table. `session.storeSessionInDatabase` keeps sessions in Postgres as the record: a Valkey flush or restart signs nobody out, and imported sessions work.
- Plugins: `@alkalines/better-auth-opaque` with the same options and hooks (`src/e2ee/hooks.ts`). The hooks call the `e2ee` service (`src/e2ee/keys.ts`) directly instead of `ctx.runMutation(internal.e2ee.*)`; each write is one transaction holding a per-user advisory lock, plus unique indexes on key id and `(user, credential version)` and a partial unique index for one active identity per user. The custody release that Convex's activation requested is not ported ([narrow first](Convex_Import.md#preconditions)). `signIn.revealClassicCredential` waits for plugin 0.2.1: published 0.2.0 does not have it ([task 14](../tasks/14_Backend_Migration.md#phase-1-results-2026-11-22)). The `convex()` plugin and its `jwks` table are removed; there is no Convex JWT anymore. Startup runs `auth.api.validateOpaqueSetup()`.
- The OPAQUE ingress policy (`src/auth/ingress.ts`) is the Convex one: `Origin === SITE_URL` on OPAQUE POSTs, a 256 KiB body bound, and the client address from the proxy headers only with `AUTH_PROXY_SECRET`, otherwise the connection peer (srvx's `request.ip`).
- Cookies live on the web origin because the browser only talks to it. Existing sessions survive the move when `BETTER_AUTH_SECRET` and the session rows are carried ([import](Convex_Import.md#better-auth)).
- Gateway API keys: the `rad-sk-…` SHA-512 hash lookup stays; the resolved key-to-workspace mapping is cached in Valkey for a short TTL and deleted on revoke.
- Rate limits (`@convex-dev/rate-limiter` call sites: Worker setup 10/min, challenge 120/min, OPAQUE account attempts, device recovery offers and takes, log ingest) become Valkey token buckets through `takeToken` in `src/auth/ratelimit.ts` (one Lua script, server time, the key expires once the bucket would be full). The OPAQUE per-account budget (30 per hour) uses it from Phase 1.

## Database Conventions

- **Ids**: `text` primary keys. Imported rows keep their Convex `_id`; new rows use UUIDv7 from `db/ids.ts`. Never parse or assume an id format.
- **Time**: `created_at timestamptz(6) not null default now()` replaces `_creationTime` on every table. Code that ordered or windowed by `_creationTime` (usage activity, orphan sweep, telemetry provenance, `lastInteractionAt` fallbacks) uses it explicitly. Imported values are rounded to microseconds. Rounding never reorders rows, but rows written by one Convex mutation can tie (13 tables in the Phase 0 export), so every ordering by `created_at` adds `id` as a tiebreaker. Order that matters inside one write needs an explicit column, as `chat_messages.position` already provides.
- **Binary**: `bytea`. **Free-form JSON**: `jsonb`, only where the shape is open (AI SDK message parts, provider metadata, subscription state). Everything Convex stored as a nested validated object becomes columns or a child table when it is queried or indexed (`chat_completions.bill.*`, `request.*`), and stays `jsonb` (`json<T>()` in `db/columns.ts`, typed from the contracts shape) when it is opaque to SQL (`workspace_providers.snapshot`, `credential_limits.meters`). Nested objects that hold bytes follow one rule: a small fixed struct without unions becomes prefixed columns with real `bytea` and an all-or-none check (`sealed_title_epoch` + `sealed_title_box`); unions, arrays of objects and open shapes (`acp_sessions.binding`, `session_proof`, `legacy_content`) are `jsonb` with every binary field as unpadded base64url text (`StoredJson<T>`), the planned wire format. SQL never filters on or checks inside `jsonb`.
- **Optional fields**: Convex optional fields are nullable, except where absence had a documented default ("absent means enabled"); those are `not null default …` and the importer fills them. Defaults that live in code and may change (`workspace_settings.routing`, `limits`) stay nullable, null meaning "the current default".
- **References**: real foreign keys with an explicit `on delete` per edge (`cascade` for owned children such as chat messages or wraps, `set null` where the referrer outlives the target, `restrict` for users, who are never deleted). Convex had none; each hand-written cascade (`cleanupChatContent`, `continueMemberRemoval`, `detachChats`) becomes a constraint or one transaction. Rows that name both a workspace and a chat, Worker or MCP server use a composite key to `(id, workspace)`, so they cannot point into another workspace. Arrays of ids whose targets get deleted (`mcpServers` lists) are child tables. Telemetry's content-addressed edges are `no action`: garbage collection deletes only unreferenced rows, and the constraint is its safety net.
- **Enums**: `text` with `check` constraints (no `pgEnum`, which makes widen-migrate-narrow harder). Values come from the contracts zod schema through `literals()` and `checkIn()` in `db/columns.ts`, so a contract change shows up as a migration.
- **Checks** state structure (all-or-none groups, status ⇔ timestamp, one form of a value), never product limits such as list caps, name lengths or retention maxima, which stay in services.
- **Indexes**: derived from actual queries, not copied from the 14 indexes on `aisdk_chats` or the 13 on `telemetry_requests`. Each index cites the query it serves in a comment. Foreign keys that cascade from a large parent have an index led by the referencing column.

## Transactions And Invariants

Each of these relied on Convex serializing mutations. Each gets a concurrency test in its domain (two parallel calls, exactly one wins).

| Invariant                                                                               | Today                                         | Replacement                                                                                                                     |
| --------------------------------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| One ACP turn per chat                                                                   | `acp.Prompt` status check + patch             | `update acp_sessions set status='starting' where chat=$1 and status in ('idle','failed') returning`                             |
| One built-in run per chat                                                               | not enforced (last `onEnd` wins)              | `chat_runs` partial unique index on `chat` where active                                                                         |
| Command dedupe by `clientId`                                                            | index lookup then insert                      | unique `(worker, client_id)` + `on conflict do nothing returning`; a row from another issuer (`issued_by`) is refused, as today |
| Command claimed once, payload erased                                                    | CAS in mutation                               | conditional `update … where status='pending' returning`, payload set null in the same statement                                 |
| Frame order / exact retry                                                               | `acp_streams.nextSeq` row                     | Durable Streams idempotent producer (producer id per Worker and epoch, sequence numbers)                                        |
| Epoch fencing (`epoch`, `cooledEpoch`)                                                  | read-compare-patch                            | conditional update on `acp_sessions`; the stream proxy checks the fence (Valkey-cached) before forwarding appends               |
| Warm cap: at most 64 warm sessions per Worker                                           | count then patch                              | Valkey script: `ZCARD` + `ZADD` atomically on `warm:<worker>`                                                                   |
| First ACP answer wins                                                                   | status CAS                                    | conditional update `pending → answered`                                                                                         |
| First Code Mode answer wins                                                             | status CAS                                    | Valkey `SET NX` on the interaction key                                                                                          |
| Worker task dispatch dedupe                                                             | `.unique()` on `(workspace, worker, request)` | unique constraint                                                                                                               |
| Worker task claim and fenced completion                                                 | `claimId`, `revision` CAS                     | conditional updates on `(status, claim_id, revision)`                                                                           |
| Worker challenge single use                                                             | consume in mutation                           | Valkey `GETDEL`                                                                                                                 |
| Enrollment single use, identity epoch                                                   | component mutation                            | conditional update `pending → completed`, epoch column                                                                          |
| Routing cursors, cooldowns, session affinity                                            | hot document upserts                          | Valkey hashes with TTL; atomic `HINCRBY`/scripts                                                                                |
| Limit poll lease                                                                        | `nextPollAt` lease mutation                   | `select … for update skip locked` in the poll job                                                                               |
| Budget recompute debounce                                                               | `runAfter(5s)`                                | outbox job with a unique dedupe key                                                                                             |
| Notification claimed by a tab vs push fallback                                          | row CAS                                       | conditional `update … where seen_at is null returning`                                                                          |
| Uniqueness by `.unique()` (`api_keys.hash`, viewers by tab, presence, streams by epoch) | throws on duplicates                          | unique constraints (or Valkey keys for moved state)                                                                             |
| One personal workspace on first sign-in; at most 100 owned; keep one active on archive  | count then insert/patch                       | per-owner advisory lock (`workspaces:<user>`) for the transaction (`src/workspaces/workspaces.ts`)                              |
| Workspace key epoch advances once (member removal, rotation, bootstrap)                 | read `keyEpoch` then insert                   | workspace row locked `for no key update` (`lockWorkspace`), plus the unique `(workspace, epoch)` and `(workspace, version)`     |
| Sealed name compare-and-swap                                                            | compare in mutation                           | same, under the workspace row lock (and the Project row lock for Project names)                                                 |
| At most 200 Projects per workspace, 200 members per workspace                           | count then insert                             | per-workspace advisory lock (Projects) or the workspace row lock (members)                                                      |
| Model pins from several tabs all apply                                                  | read-modify-write                             | `insert … on conflict do nothing`, then the row `for update`                                                                    |

The E2EE freeze flag (`assertLegacyWritesAllowed`) and the plaintext gate (`assertLegacyPlaintextAllowed`) are not ported: the importer requires a completed cutover ([narrow first](Convex_Import.md#preconditions)), after which plaintext names and icons are never accepted. The new backend therefore has no plaintext rename or icon endpoint for workspaces and Projects; clients seal both to the workspace member key (`workspaces.setName`, `projects.setName`).

## Jobs

### Outbox

Almost every `ctx.scheduler.runAfter` call is `runAfter(0)`, meaning "run after this mutation commits": title generation, notification sealing and push, usage pricing, telemetry export, cascades. The replacement is a `jobs` table written **in the same transaction** as the change that needs it:

`jobs(id, kind, payload jsonb, run_at, dedupe_key unique null, attempts, locked_until, last_error, failed_at)` (`src/jobs/`)

- `enqueueJob(tx, …)` writes the row in the caller's transaction; with a `dedupeKey`, a job with the same key that is still queued wins and the new one is dropped (debounce).
- After commit, the request hands the new job ids to `dispatchJobs` through `runtime.defer`: in-process on long-lived presets, inside `waitUntil` on serverless presets that have it.
- A sweep every minute (`jobs:sweep`) claims due jobs and runs them, which covers crashes, deploys and delayed jobs (`run_at`: notification fallback after 10 s, superseded epoch deletion after 60 s, budget debounce after 5 s). Claiming is one `update … where id in (select … for update skip locked) returning` that stamps `locked_until` (5 minutes) and counts the attempt, so concurrent sweeps, replicas and after-commit dispatches never run one job twice. A runner that dies loses its claim when `locked_until` passes.
- Handlers (`src/jobs/handlers.ts`, by kind) are idempotent and bounded; delivery is at least once. A finished job is deleted. A failed one retries with exponential backoff from 10 s (capped at one hour), and after 8 attempts it is parked with `failed_at` and `last_error` for operators; parked jobs are never claimed again. Error messages are stored, so handlers throw messages without secrets.

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

These run as Nitro tasks (`src/jobs/tasks/*`, registered through `tasks` in `nitro.config.ts` with absolute handler paths, since Nitro only scans `serverDir`; `scheduledTasks` there too), plus the one-minute outbox sweep. Each run takes a Valkey lease (`claimLease` in `src/jobs/lease.ts`), so several replicas or overlapping serverless invocations run it once. The lease is a fixed key per task (`SET lease:<task> <id> NX PX <ms>`) with a TTL a little shorter than the interval, and it is never released early. Keying it by time slot double-ran in Phase 0 when replicas fired on either side of a slot boundary. Phase 0 verified `scheduledTasks` on the `bun` and `node_server` presets. Nitro tasks are still marked experimental; if that blocks us, the long-lived presets fall back to `Bun.cron` in a startup plugin.

## Object Storage

`chat_files`, large `telemetry_blobs` and E2EE legacy sidecar envelopes move from Convex File Storage to the object store, keyed by their imported storage id (`files/<storageId>`). Uploads use presigned PUT URLs (`Bun.S3Client.presign`, or `aws4fetch` signing in the portable driver), then `files.register`. The local-disk adapter uploads through `/api/files` instead. Downloads redirect to short-lived presigned GETs. Message file parts persisted inside **sealed** messages still contain Convex storage URLs the server cannot rewrite; `/api/files` resolves them through `chat_files.legacy_url` ([import](Convex_Import.md#file-storage)).

## Secrets

The `secrets` table keeps `convex-secret-store`'s envelope exactly: a per-secret random DEK, AES-256-GCM value encryption with AAD `["value", namespace, name]`, and the DEK wrapped under the `SECRET_STORE_KEYS` version with AAD `["dek", namespace, name, version]`. Namespaces embed workspace, server and destination ids, which are preserved, so imported rows decrypt unchanged and the importer never handles plaintext. The code is about 100 lines of WebCrypto owned by `gateway/secrets.ts`, with the same write-only, masked-preview API. The `secretEvents` audit trail becomes `secret_events`.

## Schema Migrations

This is the policy that lets any install upgrade from any earlier release.

- **SQL migrations**: `bun run --cwd packages/server db:generate` runs `drizzle-kit generate` (Drizzle 1.0: one folder per migration, `drizzle/<timestamp>_<name>/migration.sql` plus its snapshot, no journal) and then `bin/schema-version.ts`, which records the newest migration in `src/db/schema-version.ts`. Both land in the same PR as the schema change. Merged migrations are never edited; fixes are new migrations.
- **Backfills**: `src/db/backfills/NNNN_<name>.ts` exports a `Backfill` (`after`, optional `narrowedBy`, `run`: idempotent, bounded batches, resumable; `verify`: exhaustive, returns issue counts), listed in `src/db/backfills/index.ts`. The last verify result lives in `drizzle.backfills`.
- **Widen → backfill → verify → switch → narrow** across at least two releases. A backfill runs after its `after` migration on every `db:migrate` until its verify is clean, then never again. A narrowing migration (`narrowedBy`) refuses to apply until that verify is clean. Same discipline as `convex/migrations.ts`, enforced by the runner instead of by convention.
- **One command**: `bun run --cwd packages/server db:migrate [--to <migration>]` (`src/db/migrate.ts`) holds a Postgres advisory lock for the whole run, applies each pending migration in its own transaction, interleaved with the backfills that follow it, and records it in Drizzle's own `drizzle.__drizzle_migrations` table (same columns, so Drizzle's tooling reads the same history). It refuses a database that has a migration the build does not know or whose file changed since it was applied. Drizzle's own `migrate()` is not used: it applies everything in one transaction and has no place for backfills, the narrowing gate or `--to`. Because every migration since the Postgres baseline stays in the repo, an install on any earlier release reaches the current one in a single run. A squash to a new baseline happens only at a major version that documents the minimum version to upgrade from. A migration that cannot run in a transaction (`create index concurrently`) needs a runner change first.
- **Boot check**: at start the server checks that the database has applied `SCHEMA_VERSION`, the newest migration it was built with. A database behind it makes a long-lived server exit before serving (serverless presets will answer `503`); a database ahead passes, since widen-before-narrow keeps older builds working. It never migrates on its own. Operators and CI run `db:migrate` with a direct `DATABASE_URL`, never through a pooler.
- **CI** (`.github/workflows/server.yml`): on every PR touching the server, contracts or crypto, `drizzle-kit check`; regenerating must produce no diff; migrations apply twice to an empty database; tests and the Nitro build run. Applying to a snapshot of the previous release's database, with backfill `verify` on it, starts with the first Postgres release. Release jobs run `db:migrate` against a target only with explicit authorization (`AGENTS.md`).

## Verification

- Vitest stays the runner (`import { … } from "vitest"`), run under Bun (`bun --bun vitest`) because the drivers are Bun's. Backend tests run against **real** Postgres and Valkey from `docker-compose.test.yml` (a separate file, because `docker-compose.yml` requires real secrets for every command; Durable Streams joins in Phase 4 with `@durable-streams/server` in memory). The global setup migrates a template database once per run with the real runner; each test file gets a fresh database cloned from it and a Valkey database of its own (one per worker, at most 8 workers). `TEST_POSTGRES_URL` and `TEST_VALKEY_URL` override the locations.
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
