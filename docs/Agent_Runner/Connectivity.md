# Interactive Runner Connectivity And ACP

Research snapshot: **2026-10-01**. Status: **proposal, not implemented**.
This refines the [authentication research](Authentication.md) for cloud-resource
limits and interactive Agent Client Protocol (ACP) traffic. Runner and client
packages still implement health only.

## Recommended Split

Use **Convex for durable control**, and **an external WSS relay for live traffic**.
Both Runner and browser initiate outbound connections to the relay. The relay can
be an independently deployable mode of the Runner product, possibly on the same
host as other self-hosted services; it is not a persistent socket inside Convex.
No particular hosted relay provider is required.

```text
Chatroom browser ── WSS ──▶ Radium relay ◀── outbound WSS ── Runner supervisor
       │                       │                               │
       └── Better Auth / ──────┴── authorized control ──▶ Convex │
           session access                                  ACP adapter
                                                               │
                                                         local stdio
                                                               │
                                                         ACP CLI agent
```

Convex owns workspace/chat authorization, enrollment/revocation, session grants,
durable approvals, lifecycle transitions and selected checkpoints. The relay owns
connection routing, live delivery, bounded buffers, backpressure and transport
liveness. The Runner owns the subprocess, local filesystem/terminal operations,
ACP adaptation and local recovery journal. Chatroom remains responsible for agent
UX, configuration and human approvals. Gateway retains model routing.

There must be a reachable WSS endpoint for both participants. A private-only
installation can expose it over a VPN. An HTTPS browser must use a trusted secure
endpoint; adding a direct socket to an arbitrary private address is not a universal
cross-network solution. This proposal adds an externally hosted process and its
resource costs, not a zero-infrastructure feature.

### Who Connects To What

The relay has a stable operator-configured address, for example
`wss://relay.example.com`. Runner initiates a connection from its current network
to that address, and the browser independently does the same. The relay pairs
authenticated channels by runner/session identity. It replies over the Runner's
already established socket; it never needs to initiate a connection to the Runner's
private or cellular IP. Ordinary NAT/CGNAT can accommodate this outbound pattern,
provided the network permits WSS and the proxy supports long-lived connections.

Convex does **not** maintain an outbound WebSocket to the relay. The long-running
relay subscribes to narrow Convex control queries. A browser operation or backend
job commits authorized session/dispatch state in Convex; the relay observes that
state and delivers a wakeup/command over the existing Runner connection. A short
authenticated HTTPS call can optionally accelerate a wakeup, but persisted intent
and reconciliation remain authoritative if the notification is lost.

If the relay itself is behind an unreachable home router, outbound Runner traffic
cannot reach it just because the Runner uses WebSockets. Host the relay at a
reachable address, deliberately configure ingress/port forwarding where possible,
or use operator-managed VPN/tunneling. Neither Convex nor the socket protocol
automatically supplies that public routing. The Runner does not need public ingress.

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

Use a narrow indexed control subscription, scoped to runner/session or relay-owned
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
   separate bounded diagnostic output. The relay transport is Radium-specific;
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

| Traffic/state | Default location | Persistence policy |
| --- | --- | --- |
| WebSocket ping/pong, live presence | Relay memory | No Convex write per heartbeat. Persist coarse transitions only if useful; do not oscillate online/offline on every transient reconnect. |
| ACP text/thought deltas, terminal output, progress | WSS and bounded Runner/relay buffers | No database write per frame. Persist only authorized content under the applicable retention policy. |
| Session admission, controller assignment, start/end/failure | Convex | Transactional, idempotent lifecycle records. |
| Permission request/decision | Convex plus live notification | Persist the minimum bound decision before releasing privileged work; the UI socket alone is not approval authority. |
| Completed messages and tool summaries | Convex under chat authorization | Bounded per-turn/domain writes, not each transport update. Final save is acknowledged before reporting durable completion. |
| Recovery checkpoint | Runner journal, optionally batched Convex delta | Configurable time/byte thresholds and retention. Avoid repeatedly rewriting a growing full transcript. |

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

Retain one-use setup and per-runner keys from the authentication proposal. On WSS
connect, a fresh relay challenge proves key possession. An app-issued signed grant
binds deployment/issuer, relay audience, runner/user identity, public-key thumbprint,
workspace/chat/session, controller or viewer role, capabilities, expiry and policy
epoch. The Runner also trusts the configured relay endpoint/issuer. Key verification
and scoped routing stay outside the per-frame Convex hot path.

Human grants are issued only after Better Auth session validation and current chat
access checks; a workspace owner is not automatically allowed to attach to another
user's personal chat. A relay authenticates as its own narrowly scoped service,
not as that user or with a Convex admin key. Initial admission checks authoritative
policy; the relay subscribes to authorized control changes and uses bounded-lived
grants/revalidation for existing sockets. Expiry must be enforced on an already open
socket, not only at handshake. Closing a revoked connection is best effort, not
proof that a previously executed tool has been undone.

During loss of control-plane freshness, stop new privileged operations and approvals
under the chosen fail-closed policy. The allowed revalidation age must be explicit;
there is no instantaneous revocation guarantee during partitions without a synchronous
authority check. Persisted approval/dispatch boundaries can use that stronger check
without querying for every output frame. Socket transport ping and authority/lease
renewal are separate cadences, never one database write per ping.

Browser WebSocket APIs cannot generally set arbitrary `Authorization` headers.
Use a secure appropriately scoped cookie on a compatible relay origin, or a short
unauthenticated admission phase with a grant and fresh key proof in the first
protocol messages. Bound its timeout/size/concurrency and route no data before
authentication. Avoid reusable credentials in query strings; validate browser
Origin as an additional control, not proof of identity. Browser ephemeral keys must
not expose the Runner's long-lived private key.

For a trusted relay, WSS plus authenticated, scoped channels does not require a
database nonce or HTTP signature for each frame. RFC 9421 remains useful for HTTPS
control operations; it is not a WebSocket frame protocol. If the relay must be
untrusted with respect to payloads, add an explicitly designed end-to-end encryption
and command-authentication layer; TLS terminated at the relay alone is insufficient.

## Reliability Without Persisting Every Frame

### Cellular/IP Failover And Resume

Switching internet connections generally destroys the current TCP/WebSocket
connection. Stable DNS points to the relay; the Runner reconnects from its new
source IP, re-authenticates, and presents its existing runner/session identity.
Do not use IP address as identity or require a fixed source-IP allowlist by default.
Detect half-open connections with bounded ping timeouts and network-change signals
where available, then reconnect with jittered backoff. No session traffic is routed
until fresh admission succeeds. Resume must reject revoked/expired authority.

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

- **Transport receipt:** relay has received bytes, possibly only in RAM. This is
  insufficient evidence to delete the Runner's sole durable copy.
- **Consumer delivery:** a browser has received/rendered data. Browser memory is
  not a durable conversation checkpoint.
- **Durable checkpoint:** the authorized persistence destination has committed a
  contiguous output range. The Runner can prune that range under retention policy.

Batch durable checkpoint acknowledgments to Convex instead of writing one ACK per
delta. If an optional relay disk spool takes ownership, its ACK must explicitly
mean a durable commit with a defined retention/recovery policy. Crash-durable local
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
- Keep the authoritative recovery journal on the Runner. A relay restart can drop
  ephemeral routing; Runner reconnect re-registers active sessions. Old connection
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

| Candidate | Fit / tradeoff |
| --- | --- |
| Convex Orchestrator | Useful for discrete durable background workflows. Leasing/state replay is different from full-duplex ACP permission and stream delivery; it does not remove per-event persistence costs. Optional coordination, not the interactive transport. |
| Convex reactive client | Appropriate for quiet runner/relay control subscriptions and revocation changes. Requires dedicated machine auth and wrapper policies; no per-delta writes. |
| Bun native WebSocket relay | Recommended first topology to evaluate: fits the repository runtime and offers connection handlers, ping/idle settings and backpressure/drain support. Radium must supply scoped admission, multiplexing and recovery. Not implemented or benchmarked. |
| NATS Core with WSS | Applicable optional broker for a fleet: ephemeral pub/sub, request/reply, TLS and subject ACLs. Core delivery is at-most-once; offline consumers miss messages. Subject permissions and session grants need integration; it is not a raw ACP WebSocket endpoint. |
| NATS JetStream | Optional external persistence for selected events. Persisting all deltas here moves storage costs rather than eliminating them. Do not duplicate Convex job/approval authority or assume broker deduplication makes execution exactly-once. |
| WebRTC data channel | Possible future direct browser/Runner route with signaling and ICE/STUN/TURN. NAT traversal may still require a relay, and recovery/ACL complexity rises; not the first topology. |

The Convex catalog was rechecked for relay, WebSocket, NATS and pub/sub candidates;
no matching raw interactive relay was identified. Persistent Text Streaming and
Presence are database-backed facilities for different purposes, not evidence of
an ephemeral ACP channel. `convex-helpers` provides app wrapper/HTTP conveniences,
not a persistent socket host. The local identity component remains justified for
durable identity state; no Convex component can host the external connection loop
just by wrapping it in registered functions. No dependency was selected here.

## Next Verification Slice

Prototype **authorized WSS echo + stdio ACP test agent + permission round trip**,
with a quiet scoped control subscription and measured lifecycle writes. Compare
idle, streaming, slow-viewer and reconnect operation counts/bytes. Test cross-chat
denial, expired open sockets, revocation/control outage, relay restart, stdout/stderr
separation and an ambiguous prompt acknowledgment. Execution isolation remains a
prerequisite for real subprocess capabilities. Deployment packaging belongs to the
workspace operations task; this proposal is not a working container quickstart.

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
- [NATS Core delivery](https://docs.nats.io/learn/core-nats/),
  [NATS WebSocket](https://docs.nats.io/learn/websocket/), plus current official
  NATS permission/persistence docs via Context7.
- [Convex component catalog](https://www.convex.dev/components/llms.txt).
