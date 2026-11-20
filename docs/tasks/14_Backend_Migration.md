# 14 Backend Migration (Convex → Bun, Hono, Postgres)

Status: **not started.** Design: [Backend migration](../Backend_Migration.md), with [runtime and layout](../Backend_Migration/Runtime.md), [live data](../Backend_Migration/Live_Data.md) and [Convex import](../Backend_Migration/Convex_Import.md). Branch: `refactor/abandon-convex`.

This is several sessions of work, not one. Each phase ends with the docs updated and its verification recorded here. The Convex backend on `dev` stays the product until the cutover release. The new backend is built beside it and exercised against imported copies of a local deployment, never production data.

Interacts with:

- [11 E2EE](11_E2EE.md): phase 9 cutover must be complete on a deployment before it can be imported. The streamed-reply sealing in [live data](../Backend_Migration/Live_Data.md#e2ee-on-streams) is new E2EE scope and needs the same review bar.
- [12 Local models](12_Local_Models.md): its planned Convex chunk relay (`local_requests`/`local_chunks`) must be re-targeted to Durable Streams before it is built.
- [09 Workspace operations](09_Workspace_Operations.md): container and compose docs are rewritten in Phase 7 here.
- [Live sessions](../Radium_Chatroom/Live_Sessions.md): superseded by Phase 4.

## Phase 0: Spikes And Final Convex Release

Findings recorded in this file. Every spike runs against real services, not mocks.

1. **Convex export.** On the local deployment: `convex export --include-file-storage`. Record whether component tables (`betterAuth`, `workerIdentity`, `secretStore`), `bytes` values and `_storage.sha256` are present, and the ZIP/JSONL layout. Decide primary vs fallback export ([export](../Backend_Migration/Convex_Import.md#export)).
2. **Durable Streams.** Caddy-plugin server in compose; JSON mode; idempotent producer retry; `Stream-TTL` expiry with and without readers; SSE through a Hono proxy for 10 minutes; whether the server implements retention (decides the `<gen>` rotation details); `@durable-streams/aisdk-transport` with a custom decrypting reader.
3. **Electric.** Shape proxy with server-set `where`, `txid` reconciliation with a TanStack DB electric collection, the same collection switched to a query source.
4. **Bun platform.** `drizzle-orm/bun-sql` transactions, `for update skip locked`, `Bun.RedisClient` scripts and `GETDEL`, `Bun.S3Client` presign against MinIO or Garage, `Bun.cron`.
5. **Load.** One watched ACP session and one built-in run across two Tabs: Postgres writes, Valkey ops and stream appends per minute, compared with the Convex function-call counts. Fill in the [load profile](../Backend_Migration/Live_Data.md#load-profile).
6. **Final Convex release scope**: `migrationStatus` query and maintenance mode, as specified in [upgrade path](../Backend_Migration/Convex_Import.md#upgrade-path). Implemented on `dev` and released before Phase 6.

Acceptance: each spike has a recorded result; designs updated where a result disagrees.

## Phase 1: Foundation

- `packages/contracts` created; runtime-neutral modules moved out of `backend/src` (ACP contract types and fold, presence, Worker task contract, chat tool names, model slugs, workspace colors/icons/names), with Convex `v` validators rewritten as zod.
- Backend skeleton: `createApp(platform)`, Bun platform adapter, env parsing, `/api/trpc` with the four base procedures, `bin/server.ts`, `bin/migrate.ts`, outbox `jobs` table and dispatcher, scheduled-job registry with Valkey leases.
- Better Auth on Drizzle + Valkey `secondaryStorage` + OPAQUE plugin and hooks; generated auth schema; ratelimit helper.
- `docker-compose.yml` with Postgres (`wal_level=logical`), Valkey, Durable Streams, optional Electric; `test` profile; Vitest setup with template databases.
- Web: `/api/*` forwarder replacing `/api/auth/$` and `/api/backend/$`; tRPC client with `@trpc/tanstack-react-query`.

Verification: sign-up and OPAQUE sign-in against the new backend; session survives restart (Valkey + Postgres); `db:migrate` on empty DB; CI checks from the [migration policy](../Backend_Migration/Runtime.md#schema-migrations) running.

## Phase 2: Schema

Drizzle schema for every retained table, per domain, following the [conventions](../Backend_Migration/Runtime.md#database-conventions): text ids, `created_at`, real foreign keys with explicit delete policy, constraints for every [invariant](../Backend_Migration/Runtime.md#transactions-and-invariants), `secrets` with the Secret Store envelope. Each table's import mapping (`src/<domain>/import.ts`) is written with its schema.

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

Stream proxy, user and workspace invalidation streams, chat signal streams, Worker inboxes; built-in chat runs on streams (admission, sealed runs for keyed chats, Stop, lease, detached runs on Bun); ACP epochs on streams with Valkey viewers, warm cap and `acp.cool`; Worker task and Code Mode waits; notification doorbells; optional Electric collections.

Verification: two browsers and a phone-sized viewport on one keyed chat and one ACP session: live reply in both, reload resumes, Stop from the non-sender, approval answered once, session cools after 5 minutes without viewers and re-warms with a new epoch; stream server holds only ciphertext for keyed chats.

## Phase 5: Client Cutover

- Web: every Convex call replaced by tRPC or a collection (about 90 files import generated Convex bindings; list them with `rg -l "convex/_generated|convex/react" apps/web/src`); `Id<>`/`FunctionReturnType` replaced by `contracts` ids and `inferRouterOutputs`; Convex providers, `@convex-dev/react-query`, `convex-helpers` cache removed; uploads through presigned URLs; `lib/crypto` transport switched from `cryptoClient()` to tRPC with base64url bytes.
- Worker: tRPC client, inbox SSE reader, ACP relay appends through the proxy, `relocate` command; Convex client removed.

Verification: `vite:build`; web typecheck against `AppRouter`; Worker unit, native and typecheck suites; Worker edit/Bash tools and an ACP session end to end with a paired Worker.

## Phase 6: Convex Import

`bin/import-convex.ts` per [Convex import](../Backend_Migration/Convex_Import.md): gates, transform, blob copy, verification report. Fixture export from the local deployment checked into tests.

Verification: full rehearsal on a restored copy of the local deployment, all seven verification steps, timings recorded here.

## Phase 7: Cloudflare And Deployment

Cloudflare spikes from [runtime](../Backend_Migration/Runtime.md#cloudflare-spikes), then the Cloudflare platform adapter, `wrangler.toml`, Service Binding from the web Worker. `docs/deployment.md`, `README.md`, `docs/architecture.md`, `docs/api.md`, Worker README and container files rewritten for the new stack; compose quickstart verified from a clean checkout.

## Phase 8: Removal

Delete `packages/backend/convex/`, `packages/worker-component/`, `scripts/convex-ready.ts` and every Convex dependency; rewrite `AGENTS.md` sections that describe Convex (wiring, verification, generated files, deployment); archive Convex-specific docs (`Worker/Convex_Transport.md`, `research/Convex_Reuse.md`, `Backend_Pre_Rewrite_Report.md`) or mark them historical; update [E2EE data classification](../E2EE/Data.md) for streams and Valkey.

Acceptance: `rg -i convex` finds only historical docs and the importer.
