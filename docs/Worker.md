# Worker

Worker is Radium's external execution service. It is intended to own
filesystem access, processes, and coding operations; Convex owns durable state,
authorization, and coordination, and Chatroom owns conversations and approvals.

## Implemented

`packages/worker/src/cli.ts` starts the unauthenticated `GET /health` service and
connects outbound with an enrolled machine identity. Owners generate a ten-minute
setup code in **Chatroom → Workers**. The Worker persists its own
P-256 key, completes enrollment/recovery, obtains short-lived JWTs and authenticates
a Convex subscription. See [machine authentication](Worker/Machine_Authentication.md)
for the implemented protocol, configuration and local verification boundary.
The standalone HTTP client package has been removed. Control-plane integration
is intended to use app-owned Convex queries and mutations calling the Worker component; future
Worker subscriptions use narrowly authenticated app wrappers. The Worker service
does not yet implement authenticated execution or job dispatch. Root development
does not start the Worker; `bun run dev:worker` watches and restarts an enrolled
Worker alongside it. The [Worker CLI guide](../packages/worker/README.md) covers
masked interactive setup, local status, authentication refresh and forgetting credentials.

The **Chatroom → Workers** page follows the compact Tools settings layout: an
Add Worker button and a list with name, ID, identity authorization status, and a
revoke action. Setup uses a name/code dialog. Worker rows accept optional content
below their controls so future machine alerts can be added in place. Disk I/O,
CPU, temperature, and RAM alert reporting is **planned**, not implemented.

`packages/worker-component` implements isolated Convex enrollment and
public-key identity persistence, exact-retry/token-free recovery, and revocation.
It is mounted as `workerIdentity` in the backend. See the
[component guide](Worker/Component.md) for the internal API and trusted app
boundary. App owner-management and narrowly scoped machine-auth wrappers now call it.

## Proposed

The selected [Convex Client transport plan](Worker/Convex_Transport.md) routes
commands, approvals, batched output and results through Convex. Worker and Chatroom
connect outbound to Convex; Worker adapts a local stdio ACP agent. Local batching,
bounded output chunks, separate control/output subscriptions and retention limit
database load. Machine JWT authentication and identity-management wrappers are now
implemented; command, approval and output transport remain planned.

The [authentication research](Worker/Authentication.md) supplies the enrollment
and per-worker proof-of-possession foundation. Its transport recommendation and
the [WSS/Tailscale connectivity research](Worker/Connectivity.md) are historical,
superseded by the 2026-10-02 Convex Client decision. Convex Orchestrator remains a
claims/leases reference rather than an adopted Worker workflow runtime.

The [Chatroom and Worker task](tasks/06_Chatroom_Worker.md) tracks the remaining
execution, isolation, approval, and verification design. Authenticating a worker
does not make commands safe or provide a sandbox.
