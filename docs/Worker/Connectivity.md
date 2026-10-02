# Interactive Worker Connectivity And ACP

Research snapshot: **2026-10-01**. Status: **superseded transport proposal, not implemented**.
The 2026-10-02 [Convex Client transport decision](Convex_Transport.md) replaces
the Worker-hosted WSS/Tailscale recommendation below. This document preserves the
earlier research and tradeoffs; use the new guide for the current plan.
This refines the [authentication research](Authentication.md) for cloud-resource
limits and interactive Agent Client Protocol (ACP) traffic. Runner and client
service still implements health only; the Worker component now owns identity
persistence. This snapshot uses "Runner" for the service now named **Worker**.
The separate HTTP client was removed; control-plane integration targets app-owned
Convex queries/mutations and authenticated subscriptions.

## Recommended Split

Use **Convex for durable control**, and **a Runner-hosted WSS endpoint reached
through operator-configured Tailscale** for live traffic. This replaces the proposed
custom Radium relay with existing network infrastructure. Tailscale handles peer
connectivity, NAT traversal and network relay fallback; Radium does not implement
its own networking relay or embed a Tailscale SDK in the first slice.

```text
Chatroom browser ── WSS via Tailscale Serve / optional Funnel ──▶ Runner supervisor
       │                                                          │
       └── Better Auth / session access ──▶ Convex ◀── quiet control subscription
                                                                  │
                                                              ACP adapter
                                                                  │ stdio
                                                              CLI agent
```

Convex owns workspace/chat authorization, enrollment/revocation, session grants,
durable approvals, lifecycle transitions and selected checkpoints. Tailscale owns
the network path; the Runner endpoint owns authenticated session attachment,
live delivery, bounded buffers, backpressure and application connection liveness.
The Runner also owns the subprocess, local filesystem/terminal operations,
ACP adaptation and local recovery journal. Chatroom remains responsible for agent
UX, configuration and human approvals. Gateway retains model routing.

Tailscale is the preferred **operator-selected connectivity profile**, not a required
hosted dependency for all Radium installations. Keep the application contract as
ordinary authenticated HTTPS/WSS, so operators can use another VPN, direct ingress
or reverse proxy. Tailscale's managed coordination/DERP/Funnel infrastructure is an
external service choice, not a claim that all infrastructure becomes self-hosted.
Configuration and an installed Tailscale daemon replace our custom relay service;
the Runner application endpoint and recovery protocol still need implementation.

### Who Connects To What

Run the Runner's HTTP/WSS service locally and configure Tailscale on that machine.
Use its stable tailnet DNS endpoint rather than the current cellular/public IP.
Tailnet peers can establish direct encrypted connections where possible, with
DERP relay fallback where NAT/network conditions prevent direct connectivity.
DERP forwards encrypted network traffic; it is not an ACP message queue or session
router. No public router port forwarding is required for this profile.

There are two distinct access modes:

| Mode                                              | Who can connect                                                                           | Integration                                                                                                                                                     |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tailscale Serve (private default)                 | Browser device joined to the tailnet or otherwise explicitly granted tailnet reachability | Serve proxies HTTPS/WSS to the local Runner endpoint. Tailnet grants/ACLs constrain network access; Radium grants still constrain workspace/chat access.        |
| Tailscale Funnel (operator-enabled public access) | Ordinary internet browsers without Tailscale                                              | Funnel publishes the configured Runner service through a public TLS endpoint. Network access is public, so Radium application authentication remains essential. |

A browser does not join Tailscale because the Radium web server does. Serve requires
connectivity on the browser's device. Funnel avoids that requirement but has its
own prerequisites and non-configurable bandwidth limits; official docs currently
label it beta. Serve and Funnel cannot share one port as private/public modes at
the same time. Test WSS upgrade, browser Origin handling and chosen proxy settings
before presenting this as an operational setup.

Convex does **not** maintain a WebSocket to the Runner, and managed Convex does
not automatically have tailnet access. The Runner initiates a narrowly scoped,
authenticated Convex control subscription. Browser/backend operations commit
authorized session/dispatch intent in Convex; the Runner observes and reconciles
that intent. Interactive frames travel between browser and Runner through Tailscale,
without entering Convex. This also supports backend jobs while no browser is open.
Do not require Funnel just so Convex can reach the Runner; outbound subscription
is the control path.

## Why Polling And Database Streaming Are Different Costs

One request every five seconds is **518,400 endpoint requests per runner per
30-day month**, even with no work. Ten-second polling is 259,200. These are request
counts, not a complete invoice: internal calls, compute and plan accounting need
deployment-specific measurement.

A Convex subscription avoids that idle request cadence. Queries are dependency
tracked and cached; relevant database changes invalidate results. An unchanged
subscription is not equivalent to repeatedly issuing the query. Connections still
consume concurrent-session capacity, and initial reads, reconnects and subscription
updates have costs. Cached reads do not incur database bandwidth according to the
current realtime guide; this is not a claim that all subscription activity is free.

However, **Convex's WebSocket carries reactive database operations**, not an
application-defined ephemeral message bus. Putting each ACP frame into a mutation
and subscribed table still incurs writes, invalidation/read work, update accounting
and retained bytes. Current Cloud limits count subscription updates as function
calls. CPU/compute charging differs by function type and deployment class, so do
not describe every database write as a separately billed action CPU interval.

Use a narrow indexed control subscription, scoped to runner/session-owned
sessions. Keep its dependencies separate from output/checkpoint data: a heartbeat
or transcript update must not wake every runner. No global event-table scan or
changing timestamp argument to force refresh. Notifications are hints; a durable
claim/authorization transition is still atomic.

## ACP Over The Link

The current [ACP transport specification](https://agentclientprotocol.com/protocol/transports)
defines stdio and explicitly permits custom bidirectional transports. Streamable
HTTP is still described as a draft. The
[HTTP/WebSocket RFD](https://agentclientprotocol.com/rfds/streamable-http-websocket-transport)
is active, not a finalized interoperable transport guarantee; its reconnect sections
also need reconciliation before adopting them as an implementation contract.

Radium can bridge an existing stdio-only agent today in a future implementation:

1. Runner launches an operator-configured ACP executable under execution policy.
   Browser requests never select an unrestricted executable, environment or cwd.
2. A Runner-side ACP adapter implements the logical client's filesystem/terminal
   capabilities locally. It presents agent updates and permission requests to the
   remote Chatroom controller through a versioned Radium WSS transport.
3. Preserve ACP initialization/capability negotiation, JSON-RPC request IDs,
   notifications and errors. Calls are bidirectional: permission requests are not
   just agent-output text. Scope routing by the authorized session/channel, not
   arbitrary IDs supplied inside messages.
4. Stdio uses newline-delimited UTF-8 JSON; stdout is protocol-only, stderr is
   separate bounded diagnostic output. The application WSS transport is Radium-specific;
   supporting it does not make the CLI a native remote-ACP server.
5. Pin tested ACP/SDK versions and advertised capabilities. Reconnect to a living
   Runner session where possible; after agent restart, use `session/load` or
   `session/resume` only if the particular agent advertises support. Loading history
   is not automatic resumption of an ambiguous in-flight prompt.

One interactive controller per session is the initial policy; authorized viewers
can receive updates without permission to answer approvals or issue prompts.
Multi-controller handoff needs explicit generation/ownership checks. Agent/provider
authentication via ACP's `authenticate` is separate from Radium runner identity;
the two must not be treated as interchangeable credentials.

## What Goes Through Convex

| Traffic/state                                               | Default location                                 | Persistence policy                                                                                                                      |
| ----------------------------------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| WebSocket ping/pong, live presence                          | Runner connection state                          | No Convex write per heartbeat. Persist coarse transitions only if useful; do not oscillate online/offline on every transient reconnect. |
| ACP text/thought deltas, terminal output, progress          | WSS through Tailscale and bounded Runner buffers | No database write per frame. Persist only authorized content under the applicable retention policy.                                     |
| Session admission, controller assignment, start/end/failure | Convex                                           | Transactional, idempotent lifecycle records.                                                                                            |
| Permission request/decision                                 | Convex plus live notification                    | Persist the minimum bound decision before releasing privileged work; the UI socket alone is not approval authority.                     |
| Completed messages and tool summaries                       | Convex under chat authorization                  | Bounded per-turn/domain writes, not each transport update. Final save is acknowledged before reporting durable completion.              |
| Recovery checkpoint                                         | Runner journal, optionally batched Convex delta  | Configurable time/byte thresholds and retention. Avoid repeatedly rewriting a growing full transcript.                                  |

For illustration, 100 updates/second over a 60-second turn means 6,000 live updates.
A 15-second checkpoint policy can mean roughly four incremental checkpoint batches
plus lifecycle/final writes, rather than 6,000 update writes. This is **not a total
cost guarantee**: approvals, content sizes, readers, retries and multiple sessions
add work. Long sessions require bounded chunk documents or separately authorized
artifact storage; they cannot fit unbounded transcripts in one Convex document.

The tradeoff is recovery granularity. If only the final result reaches Convex,
losing the Runner before completion can lose intermediate output. A durable local
journal protects against process restart, not host/disk loss. Operators can choose
coarser or finer remote checkpoints without changing the live transport. Do not
implicitly capture reasoning, prompts or terminal transcripts as operational logs.

## Connection Security And Revocation

Retain one-use Radium setup and per-runner keys from the authentication proposal.
Tailnet enrollment keys are separate operator credentials; they do not replace
Radium enrollment and must not enter browser state or Radium logs. On WSS connect,
an app-issued signed grant binds deployment/issuer, Runner endpoint audience,
user identity, client public-key thumbprint, workspace/chat/session, controller or
viewer role, capabilities, expiry and policy epoch. A fresh Runner challenge proves
client key possession. The browser verifies the configured Runner HTTPS endpoint;
the Runner trusts the configured Radium issuer. Key verification and scoped routing
stay outside the per-frame Convex hot path.

Human grants are issued only after Better Auth session validation and current chat
access checks; a workspace owner is not automatically allowed to attach to another
user's personal chat. The Runner authenticates to Convex as its own narrowly scoped
machine identity, not as that user or with a Convex admin key. Initial admission
checks authoritative policy; the Runner subscribes to authorized control changes
and uses bounded-lived grants/revalidation for existing sockets. Expiry must be enforced on an already open
socket, not only at handshake. Closing a revoked connection is best effort, not
proof that a previously executed tool has been undone.

During loss of control-plane freshness, stop new privileged operations and approvals
under the chosen fail-closed policy. The allowed revalidation age must be explicit;
there is no instantaneous revocation guarantee during partitions without a synchronous
authority check. Persisted approval/dispatch boundaries can use that stronger check
without querying for every output frame. Socket transport ping and authority/lease
renewal are separate cadences, never one database write per ping.

Browser WebSocket APIs cannot generally set arbitrary `Authorization` headers.
Use a secure appropriately scoped cookie on a compatible Runner origin, or a short
unauthenticated admission phase with a grant and fresh key proof in the first
protocol messages. Bound its timeout/size/concurrency and route no data before
authentication. Avoid reusable credentials in query strings; validate browser
Origin as an additional control, not proof of identity. Browser ephemeral keys must
not expose the Runner's long-lived private key.

WSS plus authenticated, scoped channels does not require a database nonce or HTTP
signature for each frame. RFC 9421 remains useful for HTTPS control operations;
it is not a WebSocket frame protocol. Tailscale network identity/grants do not imply
Better Auth workspace membership. Serve identity headers are not a replacement for
Radium policy; trust proxy-derived headers only through a configured local proxy.
Funnel does not supply Serve user identity headers. Bind a proxied local service
to loopback when relying on that proxy boundary.

## Reliability Without Persisting Every Frame

### Cellular/IP Failover And Resume

Tailscale keeps a stable virtual endpoint and can switch underlying paths without
breaking application connections during a sufficiently short network transition.
This improves roaming but does not guarantee socket survival for every outage,
daemon restart or Funnel connection. If the socket fails, the browser reconnects
to the same Runner endpoint, re-authenticates and reattaches its existing session;
the Runner separately reconnects its Convex control subscription when necessary.
Do not use IP address as identity or require a fixed source-IP allowlist by default.
Detect half-open connections with bounded ping timeouts and network-change signals
where available, then reconnect with jittered backoff. No session traffic is routed
until fresh admission succeeds. Resume must reject revoked/expired authority.
Tailscale/DERP does not retain or replay ACP output during a prolonged disconnect.

Transport recovery is an application contract, not a WebSocket feature. Proposed
logical stream records carry a session/stream epoch and monotonically increasing
sequence number independent of socket lifetime. Keep per-direction contiguous
cursors; a resume exchanges the receiver's last acknowledged position and the
sender's retained range. Replace the old socket generation, reconcile commands,
then replay only authorized retained data. Acknowledging sequence 80 must not
discard a missing sequence 79. A new connection must not create a new ACP prompt.

For example, if output 401–420 was sent and the receiver acknowledged through 410,
the Runner retains 411 onward. Output generated while disconnected, such as
421–440, enters the same bounded local spool. After reattachment the receiver asks
for 411 onward. Some previously delivered records may be replayed if their ACK was
lost; deduplicate by stream identity and sequence, not by comparing their text.
The agent process can stay alive independently of the lost socket, but new
privileged work still follows authority freshness/controller-loss policy.

There are distinct acknowledgments:

- **Transport receipt:** the application peer has received bytes, possibly only
  in RAM. A TCP/network ACK or DERP delivery is also insufficient evidence to
  delete the Runner's sole durable copy.
- **Consumer delivery:** a browser has received/rendered data. Browser memory is
  not a durable conversation checkpoint.
- **Durable checkpoint:** the authorized persistence destination has committed a
  contiguous output range. The Runner can prune that range under retention policy.

Batch durable checkpoint acknowledgments to Convex instead of writing one ACK per
delta. Tailscale infrastructure does not take durable ownership of this stream.
Crash-durable local
journal records require durable storage before promising that guarantee; buffered
writes alone are not proof of disk persistence. Group commits can amortize I/O.

In the opposite direction, prompts/commands need stable operation IDs, persisted
intent and Runner-side durable admission records before execution. If a command
was executed but its receipt was lost, reconnect queries/reconciles its status;
it must not blindly run it again. A crash between an external side effect and its
completion record still leaves an ambiguous outcome, requiring reconciliation.

Outages and storage are bounded. If the retained range no longer covers a resume
cursor, report an explicit gap and recover from a checkpoint/agent-supported load
where possible. Pause/backpressure or cancel under policy before exhausting spool
limits; do not silently drop required messages. Local journals can bridge an IP
change while the host survives, but cannot promise recovery after loss of that
host/disk. More complete disaster recovery requires remote durable storage and its
corresponding cost. Test WAN switching, lost ACKs and replay in both directions.

- Ordered delivery holds on one live WebSocket, not across reconnects. Use channel
  generation, sequence/cursor acknowledgments and bounded replay windows in the
  Radium envelope. Keep ACP JSON-RPC semantics distinct from transport sequence IDs.
- Keep the authoritative recovery journal on the Runner. An endpoint or Tailscale
  daemon restart can drop connections; reattachment reconciles active sessions. Old connection
  generations cannot control the session. A gap beyond retained history requires
  explicit resync rather than pretending that every missing notification is recoverable.
- Do not automatically resend `session/prompt` or approve a tool after disconnect.
  JSON-RPC IDs are correlation IDs, not exactly-once side-effect guarantees. Persist
  prompt admission/approval identities and reconcile their outcome.
- Bound per-session and per-connection buffers. Backpressure propagates to the
  adapter where possible; disconnect a slow viewer or provide a resync snapshot.
  Never silently discard requests, permission responses or completion messages.
- Define controller-loss behavior for each agent: pause permission prompts, cancel
  or continue only under already authorized policy, and enforce resource deadlines.
  A browser closing does not prove that the agent stopped.

## Reuse And Deployment Choices

| Candidate                                   | Fit / tradeoff                                                                                                                                                                                                                                 |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Convex Orchestrator                         | Useful for discrete durable background workflows. Leasing/state replay is different from full-duplex ACP permission and stream delivery; it does not remove per-event persistence costs. Optional coordination, not the interactive transport. |
| Tailscale daemon + Serve / optional Funnel  | Preferred operator-selected network profile. Supplies connectivity/proxying/relay fallback without custom Radium networking relay code. Private/public browser access and provider limits must be explicit.                                    |
| Convex reactive client                      | Appropriate for quiet Runner control subscriptions and revocation changes. Requires dedicated machine auth and wrapper policies; no per-delta writes.                                                                                          |
| Bun native WebSocket endpoint               | Runner application endpoint, not a separate relay service. Radium still supplies scoped admission, ACP adaptation, backpressure and recovery. Not implemented or benchmarked.                                                                  |
| Ordinary HTTPS/WSS via other VPN or ingress | Preserves provider-independent self-hosted operation. Same Radium application contracts; operator supplies network reachability.                                                                                                               |

The Convex catalog was rechecked for relay, WebSocket, NATS and pub/sub candidates;
no matching raw interactive relay was identified. Persistent Text Streaming and
Presence are database-backed facilities for different purposes, not evidence of
an ephemeral ACP channel. `convex-helpers` provides app wrapper/HTTP conveniences,
not a persistent socket host. The local identity component remains justified for
durable identity state; no Convex component can host the external connection loop
just by wrapping it in registered functions. Tailscale was selected as a preferred
deployment profile, not installed or integrated in this research. A custom Radium
relay and NATS broker are no longer first-slice deliverables.

## Next Verification Slice

Prototype **Tailscale-reachable authorized Runner WSS + stdio ACP test agent + permission round trip**,
with a quiet scoped control subscription and measured lifecycle writes. Compare
idle, streaming, slow-viewer and reconnect operation counts/bytes. Test cross-chat
denial, expired open sockets, revocation/control outage, Tailscale/Runner restart, stdout/stderr
separation and an ambiguous prompt acknowledgment. Execution isolation remains a
prerequisite for real subprocess capabilities. Deployment packaging belongs to the
workspace operations task; this proposal is not a working container quickstart.
Verify private Serve from a tailnet browser and separately optional Funnel from
a non-tailnet browser. Measure direct and DERP paths, WAN failover, bandwidth and
browser local-network restrictions; do not claim seamless recovery before testing.

## Sources

- [Convex realtime and caching](https://docs.convex.dev/realtime),
  [Cloud limits and accounting](https://docs.convex.dev/production/state/limits),
  [HTTP actions](https://docs.convex.dev/functions/http-actions).
- [ACP transports](https://agentclientprotocol.com/protocol/transports),
  [overview](https://agentclientprotocol.com/protocol/overview),
  [session setup](https://agentclientprotocol.com/protocol/session-setup), and
  [active HTTP/WebSocket proposal](https://agentclientprotocol.com/rfds/streamable-http-websocket-transport).
- [Bun WebSockets](https://bun.sh/docs/runtime/http/websockets), checked through
  current official documentation via Context7. Exact runtime compatibility remains
  an implementation check.
- [Tailscale connection types](https://tailscale.com/docs/reference/connection-types),
  [Serve](https://tailscale.com/docs/features/tailscale-serve),
  [Funnel](https://tailscale.com/docs/features/tailscale-funnel), and
  [network roaming](https://tailscale.com/docs/reference/ssh-over-tailscale).
  Current official documentation checked through Context7 and direct pages.
- [Convex component catalog](https://www.convex.dev/components/llms.txt).
