# Chatroom And Worker Boundary

Status: Authentication/connectivity research completed 2026-10-01; identity
persistence package and backend mount implemented. App authentication and transport
integration, execution protocol and isolation design remain open. See
[Worker authentication research](../Worker/Authentication.md) for the
recommendation, component candidates, proposed boundaries, and verification gates.
The [interactive connectivity follow-up](../Worker/Connectivity.md) supersedes
idle polling with Worker-hosted WSS through operator-configured Tailscale
Serve/optional Funnel and quiet Convex control subscriptions. A custom Radium relay
is no longer planned for the first slice; ACP adaptation, resource measurements,
endpoint admission and replay are still proposed. Tailscale is not a required
hosted dependency for all installations.
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

## Acceptance

- The design covers offline workers, duplicate dispatch, crash/restart, cancellation, unauthorized jobs, and output backpressure.
- Verification plan includes isolation/authorization tests and a local integration path without Convex-hosted OS execution.
- No claim that Convex components replace the external Worker or that root dev starts it today.
