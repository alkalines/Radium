# Worker

Worker is Radium's external execution service. It is intended to own
filesystem access, processes, and coding operations; Convex owns durable state,
authorization, and coordination, and Chatroom owns conversations and approvals.

## Implemented

`packages/worker/src/index.ts` exposes an unauthenticated `GET /health`.
The standalone HTTP client package has been removed. Control-plane integration
is intended to use app-owned Convex queries and mutations calling the Worker component; future
Worker subscriptions use narrowly authenticated app wrappers. The Worker service
does not yet implement enrollment, authenticated execution, job dispatch, or
reconnect behavior. Root development does not start the Worker.

`packages/worker-component` implements isolated Convex enrollment and
public-key identity persistence, exact-retry/token-free recovery, and revocation.
It is mounted as `workerIdentity` in the backend. See the
[component guide](Worker/Component.md) for the internal API and trusted app
boundary. No app auth wrappers or transport endpoints call it yet.

## Proposed

The [authentication and connectivity research](Worker/Authentication.md)
recommends single-use enrollment tokens and per-worker proof-of-possession
identities. The [interactive connectivity research](Worker/Connectivity.md)
refines transport to a Worker-hosted WSS endpoint through operator-configured
Tailscale Serve or optional Funnel, replacing the proposed custom Radium relay.
Convex handles low-frequency control and checkpoints. Tailscale remains an optional
deployment profile; standard HTTPS/WSS contracts support other networks. The guide
covers a stdio ACP adapter and cloud
resource tradeoffs. The research compares existing Convex Components
and proposes an identity component boundary. The persistence subset is now in the
workspace package above; cryptographic authentication and transport remain design
recommendations, not an implemented protocol.

The [Chatroom and Worker task](tasks/06_Chatroom_Worker.md) tracks the remaining
execution, isolation, approval, and verification design. Authenticating a worker
does not make commands safe or provide a sandbox.
