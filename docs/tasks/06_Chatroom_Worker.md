# Chatroom And Worker Boundary

Status: Authentication/connectivity research completed 2026-10-01; identity
persistence package, owner setup-code UI, JOSE proof admission and Worker Convex
machine authentication and edit-only request/result execution implemented locally.
Deployment auth verification, broader command/output transport, Chatroom integration
and execution isolation design remain open. See
[Worker authentication research](../Worker/Authentication.md) for the
recommendation, component candidates, proposed boundaries, and verification gates.
The selected 2026-10-02 [Convex Client transport plan](../Worker/Convex_Transport.md)
supersedes the earlier WSS/Tailscale connectivity proposal. Worker and Chatroom
connect outbound to Convex; commands, approvals, batched output and results use
authorized app queries/mutations and subscriptions. Machine JWT authentication
is implemented; ACP adaptation, bounded output storage and execution recovery remain proposed. Orchestrator
is a claims/leases reference, not an adopted workflow runtime.
Ownership persistence depends on task 03; boundary research can proceed now.

## Entry Points

`packages/worker/src/cli.ts`, `packages/worker/src/control.ts`,
`packages/backend/src/http/aisdk.chat.ts`, `packages/backend/convex/chatroom.ts`,
and Chatroom tools/approvals UI. The Worker service implements key enrollment,
JWT refresh and an authorized identity subscription;
the separate HTTP client was removed in favor of app-owned Convex queries/mutations.
`packages/worker-component/src/component/` owns the initial enrollment,
identity and revocation state and is mounted in
`packages/backend/convex/convex.config.ts`. See the
[component guide](../Worker/Component.md) for API, tests and remaining gates.

## Work

Completed foundation: `worker` and `worker-component` package naming, internal
`workerIdentity` query/mutation API, enrollment/identity persistence, and removal
of the standalone HTTP client. Component regressions and package/service
typechecks pass. [Machine authentication](../Worker/Machine_Authentication.md) adds
owner-management wrappers, machine identity validation and the Worker identity
subscription. Deployed verifier/transport checks and execution remain follow-up work.

1. Define responsibility: Chatroom owns conversations/agent approvals, Convex owns durable coordination through app wrappers and the Worker component, Worker owns filesystem/process execution and its external transport.
2. Design versioned job, event, result, cancellation, and reconnect contracts with capability negotiation, correlation, and idempotency. Keep Gateway model routing separate.
3. Threat-model worker authentication, job ownership, workspace confinement, symlinks/path traversal, command approval, isolation, resource/time limits, secret access, and output bounds. Do not equate a workspace path with a sandbox.
4. Produce a minimal safe vertical-slice plan and separate implementation tasks. No arbitrary shell endpoint before the security contract is approved.
5. Write `docs/Radium_Chatroom.md`, `docs/Worker.md`, and `docs/Worker/Execution.md`, clearly marking design versus authentication-only reality.

## Next Implementation Slice

### Executable Chatroom File Tools And Disconnect Diagnostics (2026-10-07)

The previous composer slice saved configuration without exposing Worker tools to
the model. This follow-up connects enabled Read/Edit/Create tools to the existing
HTTP chat/model loop and Worker task transport, adds an explicit absolute-directory
input, and uses signed owner/chat/Worker/directory-scoped write approvals before
native staging/application. Backend dispatch rechecks current configuration at
every stage, and Worker write modes prevent Edit/Create toggle bypasses. Durable
`worker_chat_calls` receipts preserve idempotency after five-minute task pruning;
chat deletion schedules indexed bounded receipt cleanup. Control status now
reports fixed, actionable disconnect reason codes and requires authenticated
transport plus active matching identity before reporting connected.

See [Worker tools in Chatroom](../Worker/Chatroom.md) for contracts, data retention,
configuration and failure behavior. The existing Worker identity component and
app authorization are reused; no new infrastructure dependency was added. The
new receipt table and optional directory/write-mode fields widen the schema and
need no existing-data backfill. This does not complete task 06: live deployment
verification, cancellation, ambiguous-outcome recovery, shell/eval and OS isolation
remain open.

Verification: `bun run test` passed the backend suite, including HTTP tool exposure,
signed approval/replay checks, owner/member/private-chat isolation, durable stage
receipts and deletion cleanup. `bun run --cwd packages/worker test` passed control,
CLI and native checks. `bun run --cwd apps/web vite:build` passed with existing
chunk-size/Shiki WASM fallback warnings. The guarded offline API generator ran
locally. Typechecks remain blocked by existing dependency, test typing, routing,
auth and alias errors; scoped ESLint is blocked by the missing root `eslint`
dependency. No real credentials, remote data, deployment configuration or migrations
were changed, and live browser/deployment behavior was not verified.

### Composer Worker Configuration (2026-10-07)

Implemented a minimal Worker menu inside the home and conversation prompt inputs,
with independent Read/Edit/Create preferences persisted per chat. Selection is
owner-only, checks chat visibility, and validates an active Worker in the exact
chat workspace on the server. Members and cross-workspace identities are denied.
Changing the home workspace resets its selection; existing chats stay scoped to
their own workspace. Root `bun run dev` also starts the Worker source watcher.

This slice configures preferences only. Next: define target-directory selection,
model-tool dispatch and approval enforcement, persist durable outcomes, and verify
deployed transport. See the [Chatroom guide](../Radium_Chatroom.md) for UI and
permission behavior. Existing chats need no backfill; the Worker field is optional.

Verification: `bun run --cwd packages/backend test convex/workers.test.ts convex/workspaces.test.ts`
passed 22 checks, including configuration authorization and workspace isolation.
`bun run --cwd apps/web vite:build` passed with chunk-size and Shiki WASM fallback
warnings. Scoped formatting and `git diff --check` passed. The guarded offline
API generator ran locally; no deployment or remote migration was run. Scoped
ESLint is blocked by the missing root `eslint` dependency; frontend TypeScript
checking remains blocked by AI SDK version mismatches, auth component errors,
and backend `@/` alias resolution, with no Worker configuration diagnostics.
Browser interaction verification was unavailable because no desktop browser was
connected. Root `bun run dev` was not launched during checks because it starts
the deployment-connected Convex process and enrolled Worker.

### Edit-Only Execution And Messaging (2026-10-07)

Implemented an initial native read/preview/apply/close path where the owner-only
`dispatchEdit` caller supplies the target Worker's execution directory, plus
machine-authorized exclusive claims/completions. Edit tasks carry bounded,
short-lived requests/results; the assignment query returns at most four records and
supports an indexed edit filter. The consumer serializes local work and retries
completion receipts without re-executing filesystem changes. Restart discards native
session state and leaves claimed unknown outcomes in `processing`. See
[tasks](../Worker/Tasks.md) and
[native editing](../Worker/Native_Tools.md).

This does not complete task 06. Next: wire model tools and approved previews into
Chatroom, persist durable chat outcomes before task cleanup, define cancellation
and ambiguous-outcome recovery, then verify separately deployed machine transport.
ACP, Bash and eval remain separate slices. Do not use terminal task receipts as
permanent execution deduplication. No deployment or migration was performed.

Verification: `bun install --frozen-lockfile` passed. `bun run test` passed all 130
backend tests, including seven edit/task regressions. `bun run --cwd packages/worker test`
passed 39 Vitest tests and 20 real-native-engine Bun tests on Linux x64 / Bun 1.4.2
with native build 18.8.3.
The guarded offline API generator ran without remote analysis or upload.
`bun run --cwd packages/worker typecheck` remains blocked by the previously recorded
Gateway routing/translator/type-import errors; scoped lint remains blocked by the
missing ESLint dependency. Scoped formatting and `git diff --check` passed.

Correction follow-up: the execution-directory contract is backend-selected, not a
Worker startup option. Worker `start` always consumes edit tasks, and public
`dispatchEdit` requires an absolute `request.directory` on the target Worker; the
owner-authorized backend caller selects it, and the Worker canonicalizes it. Stored
requests may omit the directory only for legacy compatibility; queued tasks missing
it fail with `DIRECTORY_REQUIRED` and do not use the current working directory.
Native editing loads lazily for a valid directory request. A live runner session is
bound to its canonical directory and rejects a switch with
`SESSION_DIRECTORY_CHANGED`; closing releases the binding and a new directory under
the reused session ID starts with fresh snapshots. The 64-session cap is across
directories. Existing verification records above are unchanged; this correction
does not claim deployment. Correction verification: backend Worker/task tests
passed 17 checks; Worker checks passed 40 Vitest tests and 21 native-engine tests.
Worker typechecking still reports only the previously recorded Gateway errors.

### Domain Placement, Task Status And Stdin Setup (2026-10-06)

Worker backend policy now lives under `packages/backend/src/worker/`: machine
builders in `machine.ts`, enrollment/proof policy in `identity.ts`, task
coordination in `tasks.ts` and its contract in `task-contract.ts`. Registered
entry points remain thin exports in `convex/workers.ts` and `convex/worker_tasks.ts`.
Owner-management definitions live in `src/worker/management.ts`.
The earlier `convex/workers/` folder was removed; internal auth callers use
`internal.workers.*`.

Added `worker_tasks` with `sent`, `processing`, `failed`, `retrying` and `success`.
Owner-authorized internal creation validates chat visibility and assignment;
machine status updates check assignment and expected revision. The five-minute
cron deletes failed/successful records at least five minutes after their terminal
transition in indexed, bounded batches. It preserves active tasks and chat data.
See [task coordination](../Worker/Tasks.md) for transitions, ephemeral deduplication
and remaining execution/Chatroom integration work.

Setup accepts masked prompting or piped stdin. `--setup-file` and its setup-code
file reader were removed; local credential persistence is separate and retained.

Verification for this follow-up:

- `bun run --cwd packages/backend test`: 127 tests passed, including four new
  task regressions and ten Worker auth/wrapper regressions. Existing migration
  denial tests intentionally print rejected-document diagnostics.
- `bun run --cwd packages/worker test`: all 30 tests passed.
- Local inspection of the serialized cron registration confirms
  `worker_tasks:prune` runs at a five-minute interval.
- The guarded offline API generator refreshed local declarations after removing
  the nested auth namespace and adding `worker_tasks`.
- `bun run --cwd packages/worker typecheck`: still blocked by existing Gateway
  routing/translator/type-import errors; no Worker domain or CLI diagnostics.
- Scoped `bunx oxfmt` checks pass except for a trailing space already present in
  the user's machine helper, preserved when moving it to `src/worker/machine.ts`.
- No deployment, remote migration or deployment-data mutation was performed.

### Worker Organization And Typed Control Foundation (2026-10-06)

Implemented the preparation for tool/Chatroom work:

- `packages/backend/src/worker/machine.ts` provides `workerQuery` and
  `workerMutation` using `convex-helpers` custom functions. Both inject verified
  `ctx.worker` scope and recheck active workspace/key/epoch authority before the
  handler; `workers.current` uses the query builder.
- Public owner management and current-machine subscription are registered in
  `workers.ts`; implementation now lives in `src/worker/management.ts`. Internal
  enrollment, challenge, proof admission and cleanup live in `src/worker/identity.ts`
  and are exported through the same `internal.workers.*` namespace.
- Worker `cli/` separates dispatch, options, protected input, presentation and
  startup/shutdown. Worker `auth/` separates enrollment/recovery, proof exchange,
  token caching and credential persistence. Small entry/export facades retain
  existing imports. See the [source map](../../packages/worker/README.md#source-organization).
- Worker declares `backend: workspace:*` and subscribes with the generated
  `api.workers.current`; metadata types derive from its generated return contract.

Next agents should use `workerMutation` for machine state transitions and add
capability/job-assignment policy within the same transaction. Put external tool
execution in Worker-owned modules, with Chatroom retaining agent state and approval
UX. Identity authentication alone grants no tool execution or job authority.

The generated API import brings backend sources into the Worker TypeScript
program. Its tsconfig resolves backend aliases and includes web API types; existing
Gateway routing/translator diagnostics now surface in the Worker typecheck. This
remains an explicit check blocker rather than weakening strictness or changing
unrelated Gateway logic.

Verification:

- `bun install --frozen-lockfile`: passed after adding the workspace dependency;
  the lockfile retains the existing external package versions.
- `bun run --cwd packages/worker test`: all 30 tests passed.
- `bun run --cwd packages/backend test workers.test.ts`: all 10 regressions
  passed, including the test-only machine mutation's revocation denial.
- `bun run --cwd packages/worker test src/control.test.ts`: both tests passed
  after switching control imports to the organized auth modules.
- `bun run --cwd packages/worker typecheck`: blocked by existing backend routing,
  translator and type-only-import diagnostics loaded through the generated API.
- Scoped `bun run lint` for the machine helper, control client and protocol file
  could not run because the `eslint` binary is not installed. The root
  `format:check` script also lacks a local `oxfmt` binary; formatting was completed
  and checked with `bunx oxfmt` on the changed Worker/backend sources and guides.
- `git diff --check`: passed. API declarations were refreshed using the documented
  offline generator with its network guard. No deployment or data mutation was run.

### Outbound-only Worker Cleanup (2026-10-06)

Removed the Worker-hosted health HTTP server, its `--port` option, health-only
package entry point and direct Hono dependency. `start` and `dev` now run only
the authenticated outbound Convex subscription. Signal shutdown still closes
the control client. Enrollment/recovery and JWT exchange retain their outbound
Convex-hosted HTTP auth boundary; execution transport remains planned.

Verification: `bun run --cwd packages/worker test` passed all 30 tests, including
outbound-only startup and successful/failed control shutdown;
`bun run --cwd packages/worker typecheck` and `git diff --check` passed.
The scoped formatter could not run because no installed `oxfmt` binary is available.

### Authentication Usability Follow-up (2026-10-05)

The authentication lifecycle now has a dedicated **Chatroom → Workers** management
page and a masked terminal setup flow. Worker CLI commands cover local status,
proof-based authentication refresh, and forgetting the local identity; aliases
`add-token` and `forget-token` refer to enrollment/removal, not a persisted bearer
refresh token. `bun run dev:worker` supplies an independent watch/restart loop.
The app declares typed deployment variables in `defineApp`; the identity component
declares an empty env contract. Public frontend examples and backend runtime
examples now live in their owning packages. The audited offline API parser accepts
these declarations; generated server `env` accessors await standard authorized codegen.
See the [CLI guide](../../packages/worker/README.md) for credential storage policy
and headless operation. These changes retain the existing enrollment, recovery
and owner-revocation protocol; live deployment verification remains open.
The durable key defaults to OS credential storage; `auto`/`file` explicitly permit
the protected-file fallback. Local version-1 state migrates while preserving the
identity and recovery selectors, and version-2 metadata omits the private key.

Follow-up checks:

- `bun install --frozen-lockfile`: passed.
- `bun run --cwd packages/worker test`: 28 checks passed, including credential
  migration, explicit fallback, missing-key refusal, interrupted-write recovery,
  and preserving unsupported state formats.
- `bun run --cwd packages/worker typecheck`: passed.
- `bun run --cwd packages/backend test convex/workers.test.ts`: nine handler
  regressions passed, including the real Worker proof exchange and revocation.
- `bun run --cwd packages/worker test src/cli.test.ts`: nine lifecycle checks
  passed, including secret-free output, redirected-terminal handling and failed
  control shutdown cleanup.
- `node --test apps/web/scripts/convex-config-parser.test.mjs`: five parser
  regressions passed. The audited offline generator passed with the network guard;
  its API-only write produced no generated-file diff.
- `bun run --cwd packages/worker-component typecheck` and
  `bun run --cwd packages/worker-component build`: passed. The app config check
  passed from `packages/backend` with
  `bunx tsc --ignoreConfig --noEmit --skipLibCheck --target ES2022 --module ESNext --moduleResolution Bundler --types node convex/convex.config.ts`.
- `bun run --cwd apps/web vite:build`: passed with existing chunk-size and Shiki
  WASM fallback warnings. The changed UI files had no TypeScript diagnostics;
  the full frontend check still reports unrelated existing errors.
- Scoped ESLint remains blocked by the root configuration's `eslint` resolution.
  No remote deployment, migration, or auth-config upload was performed.

### Authentication Slice Verification (2026-10-04)

- `bun install --frozen-lockfile` passed after adding direct Worker/issuer dependencies.
- `bun run test` passed **122 tests in 24 backend files**, including nine app-auth
  regressions and a real Worker-client/app-handler enrollment, refresh and revoke round trip.
- `bun run --cwd packages/worker test` passed **10 tests in two files**.
- `bun run --cwd packages/worker typecheck` passed.
- `bun run --cwd apps/web vite:build` passed with existing chunk-size/WASM fallback warnings.
- Scoped formatting and `git diff --check` passed. The issuer generator produced
  a `0700` directory and `0600` files without printing keys; temporary test keys were removed.
- The explicit backend TypeScript check using an external scoped tsconfig is
  blocked by existing type-only import and unchecked-index diagnostics in
  `models.ts`, `ai_balancer.ts`, `chat_completion.ts`, `translators/openai.ts` and
  `types/ai_provider.ts`; it reported no diagnostics in the new production auth files.
  Frontend typechecking likewise has existing unrelated diagnostics, and scoped
  ESLint remains blocked by root configuration's `eslint` resolution issue.
- Only the audited offline root API generator ran. The identity component's schema
  and public contract were reused unchanged. No deployment, remote codegen,
  auth-config upload or migration was run. Live verifier, socket revocation and
  separately deployed TLS/reconnect checks remain open.

Execution-transport implementation remains open. Extend the authenticated Worker Convex
Client with a stdio ACP test agent, bounded batched output visible in
Chatroom, and a durable permission round trip. Use the transport guide's initial
500 ms text batching candidate plus byte caps; tune from measurements. Separate
control from output, define idempotent batch ingestion and catch-up, and specify
retention before introducing output tables. Real execution capabilities depend
on the isolation contract; packaging depends on task 09. No dependency adoption
or remote deployment is authorized by this plan.

## Acceptance

- The design covers offline workers, duplicate dispatch, crash/restart, cancellation, unauthorized jobs, and output backpressure.
- Verification plan includes isolation/authorization tests and a local integration path without Convex-hosted OS execution.
- No claim that Convex components replace the external Worker or that root dev starts it today.
- Machine JWT refresh/revocation and app wrappers preserve workspace, assignment
  and private-chat authorization; Worker has no human/admin credential authority.
- Load verification records writes, read/return bytes, subscription fan-out,
  conflicts, queue bounds and latency across idle, streaming and reconnect cases.
- Batch retries, lost acknowledgments, retention gaps and ambiguous commands have
  explicit recovery behavior; no growing full-transcript live query or per-token writes.
