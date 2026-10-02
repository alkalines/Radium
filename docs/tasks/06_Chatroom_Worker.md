# Chatroom And Worker Boundary

Status: Authentication/connectivity research completed 2026-10-01; identity
persistence package and backend mount implemented. App authentication and transport
integration, execution protocol and isolation design remain open. See
[Worker authentication research](../Worker/Authentication.md) for the
recommendation, component candidates, proposed boundaries, and verification gates.
The selected 2026-10-02 [Convex Client transport plan](../Worker/Convex_Transport.md)
supersedes the earlier WSS/Tailscale connectivity proposal. Worker and Chatroom
connect outbound to Convex; commands, approvals, batched output and results use
authorized app queries/mutations and subscriptions. ACP adaptation, machine JWT
authentication, bounded output storage and recovery remain proposed. Orchestrator
is a claims/leases reference, not an adopted workflow runtime.
Ownership persistence depends on task 03; boundary research can proceed now.

## Entry Points

`packages/worker/src/index.ts`,
`packages/backend/src/http/aisdk.chat.ts`, `packages/backend/convex/chatroom.ts`,
and Chatroom tools/approvals UI. The Worker service currently implements health only;
the separate HTTP client was removed in favor of app-owned Convex queries/mutations.
`packages/worker-component/src/component/` owns the initial enrollment,
identity and revocation state and is mounted in
`packages/backend/convex/convex.config.ts`. See the
[component guide](../Worker/Component.md) for API, tests and remaining gates.

## Work

Completed foundation: `worker` and `worker-component` package naming, internal
`workerIdentity` query/mutation API, enrollment/identity persistence, and removal
of the standalone HTTP client. Component regressions and package/service
typechecks pass. Authenticated app wrappers, machine identity validation and
Worker subscriptions/transport remain follow-up work.

1. Define responsibility: Chatroom owns conversations/agent approvals, Convex owns durable coordination through app wrappers and the Worker component, Worker owns filesystem/process execution and its external transport.
2. Design versioned job, event, result, cancellation, and reconnect contracts with capability negotiation, correlation, and idempotency. Keep Gateway model routing separate.
3. Threat-model worker authentication, job ownership, workspace confinement, symlinks/path traversal, command approval, isolation, resource/time limits, secret access, and output bounds. Do not equate a workspace path with a sandbox.
4. Produce a minimal safe vertical-slice plan and separate implementation tasks. No arbitrary shell endpoint before the security contract is approved.
5. Write `docs/Radium_Chatroom.md`, `docs/Worker.md`, and `docs/Worker/Execution.md`, clearly marking design versus health-only reality.

## Next Implementation Slice

Design recorded; implementation remains open. Build authenticated Worker Convex
Client access with a stdio ACP test agent, bounded batched output visible in
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
