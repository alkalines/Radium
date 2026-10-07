# Worker

Worker is Radium's external execution service. It is intended to own
filesystem access, processes, and coding operations; Convex owns durable state,
authorization, and coordination, and Chatroom owns conversations and approvals.

## Implemented

`packages/worker/src/cli.ts` connects outbound with an enrolled machine identity,
without an inbound HTTP listener. The former health endpoint and `--port` option
have been removed. Owners generate a ten-minute
setup code in **Chatroom → Workers**. The Worker persists its own
P-256 key, completes enrollment/recovery, obtains short-lived JWTs and authenticates
a Convex subscription. See [machine authentication](Worker/Machine_Authentication.md)
for the implemented protocol, configuration and local verification boundary.
The standalone HTTP client package has been removed. Control-plane integration
is intended to use app-owned Convex queries and mutations calling the Worker component; future
Worker subscriptions use narrowly authenticated app wrappers. The Worker now
implements owner-dispatched, machine-claimed edit tasks and short-lived results.
`start` consumes edit tasks without a directory CLI option; the owner-authorized
backend dispatch supplies an absolute directory on the target Worker, and native
editing is loaded lazily for a valid request. See [Worker tasks](Worker/Tasks.md)
for directory selection, result subscriptions and crash behavior. Root development
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

Machine endpoints use the `convex-helpers` custom builders `workerQuery` and
`workerMutation` in `packages/backend/src/worker/machine.ts`. Both inject
verified scope as `ctx.worker` after rechecking workspace/key/epoch authority.
The Worker imports the backend's generated API through a workspace dependency;
CLI and authentication code have dedicated folders. See the
[source map](../packages/worker/README.md#source-organization) before extending it
with tools or Chatroom coordination.

[Worker tasks](Worker/Tasks.md) persist `sent`, `processing`, `failed`, `retrying`
and `success`, with optional chat/tool-call correlation. Every five minutes,
cleanup removes terminal task records aged at least five minutes, including edit
inputs/results. Chatroom model-tool wiring, durable conversation outcomes and
approval presentation remain planned.

The [native tools guide](Worker/Native_Tools.md) describes Oh-My-Pi's own
`@oh-my-pi/pi-natives` package and the edit adapter's read/preview/apply lifecycle,
as well as the planned shell, background-job, and PTY primitives.

## Proposed

The [Bash tool reference](Worker/Bash_Tool.md) details shell execution,
background jobs, interactive terminals, and the required Worker adapter. The
[eval reference](Worker/Eval_Tool.md) covers upstream's separate persistent
JavaScript/Python code-execution stack; Radium adoption is not yet selected.

The selected [Convex Client transport plan](Worker/Convex_Transport.md) routes
commands, approvals, batched output and results through Convex. Worker and Chatroom
connect outbound to Convex; Worker adapts a local stdio ACP agent. Local batching,
bounded output chunks, separate control/output subscriptions and retention limit
database load. Machine JWT authentication and identity-management wrappers are now
implemented; the edit-only request/result path is implemented locally. ACP,
streaming/batched output and approval transport remain planned.

The [authentication research](Worker/Authentication.md) supplies the enrollment
and per-worker proof-of-possession foundation. Its transport recommendation and
the [WSS/Tailscale connectivity research](Worker/Connectivity.md) are historical,
superseded by the 2026-10-02 Convex Client decision. Convex Orchestrator remains a
claims/leases reference rather than an adopted Worker workflow runtime.

The [Chatroom and Worker task](tasks/06_Chatroom_Worker.md) tracks the remaining
execution, isolation, approval, and verification design. Authenticating a worker
does not make commands safe or provide a sandbox.
