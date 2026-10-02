# Agent Runner

Agent Runner is Radium's external execution service. It is intended to own
filesystem access, processes, and coding operations; Convex owns durable state,
authorization, and coordination, and Chatroom owns conversations and approvals.

## Implemented

`packages/agent-runner/src/index.ts` exposes an unauthenticated `GET /health`.
`packages/agent-runner-client/src/index.ts` calls that endpoint and sends a bearer
token, but the server does not validate it. Neither package implements enrollment,
authenticated execution, job dispatch, or reconnect behavior. Root development
does not start the Runner.

## Proposed

The [authentication and connectivity research](Agent_Runner/Authentication.md)
recommends single-use enrollment tokens and per-runner proof-of-possession
identities. The [interactive connectivity research](Agent_Runner/Connectivity.md)
refines transport to a Runner-hosted WSS endpoint through operator-configured
Tailscale Serve or optional Funnel, replacing the proposed custom Radium relay.
Convex handles low-frequency control and checkpoints. Tailscale remains an optional
deployment profile; standard HTTPS/WSS contracts support other networks. The guide
covers a stdio ACP adapter and cloud
resource tradeoffs. The research compares existing Convex Components
and proposes a local component boundary. This is a design recommendation, not an
implemented protocol or a dependency selection.

The [Chatroom and Runner task](tasks/06_Chatroom_Runner.md) tracks the remaining
execution, isolation, approval, and verification design. Authenticating a runner
does not make commands safe or provide a sandbox.
