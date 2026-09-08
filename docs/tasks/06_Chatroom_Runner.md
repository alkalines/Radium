# Chatroom And Runner Boundary

Status: Not started. First session: execution protocol and security design.
Ownership persistence depends on task 03; boundary research can proceed now.

## Entry Points

`packages/agent-runner/src/index.ts`, `packages/agent-runner-client/src/index.ts`,
`packages/website/convex/http/aisdk.chat.ts`, `packages/website/convex/chatroom.ts`,
and Chatroom tools/approvals UI. Runner and client currently implement health only.

## Work

1. Define responsibility: Chatroom owns conversations/agent approvals, Convex owns durable coordination, Runner owns filesystem/process execution, client package owns the transport contract.
2. Design versioned job, event, result, cancellation, and reconnect contracts with capability negotiation, correlation, and idempotency. Keep Gateway model routing separate.
3. Threat-model runner authentication, job ownership, workspace confinement, symlinks/path traversal, command approval, isolation, resource/time limits, secret access, and output bounds. Do not equate a workspace path with a sandbox.
4. Produce a minimal safe vertical-slice plan and separate implementation tasks. No arbitrary shell endpoint before the security contract is approved.
5. Write `docs/Radium_Chatroom.md`, `docs/Agent_Runner.md`, and `docs/Agent_Runner/Execution.md`, clearly marking design versus health-only reality.

## Acceptance

- The design covers offline runners, duplicate dispatch, crash/restart, cancellation, unauthorized jobs, and output backpressure.
- Verification plan includes isolation/authorization tests and a local integration path without Convex-hosted OS execution.
- No claim that Convex components replace the external Runner or that root dev starts it today.
