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

The selected [Convex Client transport plan](Worker/Convex_Transport.md) routes
commands, approvals, batched output and results through Convex. Worker and Chatroom
connect outbound to Convex; Worker adapts a local stdio ACP agent. Local batching,
bounded output chunks, separate control/output subscriptions and retention limit
database load. Machine JWT authentication and app authorization wrappers remain
planned; the identity persistence subset above does not implement them.

The [authentication research](Worker/Authentication.md) supplies the enrollment
and per-worker proof-of-possession foundation. Its transport recommendation and
the [WSS/Tailscale connectivity research](Worker/Connectivity.md) are historical,
superseded by the 2026-10-02 Convex Client decision. Convex Orchestrator remains a
claims/leases reference rather than an adopted Worker workflow runtime.

The [Chatroom and Worker task](tasks/06_Chatroom_Worker.md) tracks the remaining
execution, isolation, approval, and verification design. Authenticating a worker
does not make commands safe or provide a sandbox.
