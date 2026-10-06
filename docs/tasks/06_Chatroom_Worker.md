# Chatroom And Worker Boundary

Status: Authentication/connectivity research completed 2026-10-01; identity
persistence package, owner setup-code UI, JOSE proof admission and Worker Convex
machine authentication implemented locally. Deployment auth verification, command/output
transport, execution protocol and isolation design remain open. See
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

`packages/worker/src/cli.ts`, `packages/worker/src/index.ts`,
`packages/backend/src/http/aisdk.chat.ts`, `packages/backend/convex/chatroom.ts`,
and Chatroom tools/approvals UI. The Worker service implements health, key enrollment,
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
5. Write `docs/Radium_Chatroom.md`, `docs/Worker.md`, and `docs/Worker/Execution.md`, clearly marking design versus health-only reality.

## Next Implementation Slice

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
