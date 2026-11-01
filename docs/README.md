# Radium Documentation

This directory contains operational and developer documentation for Radium.
The root [README](../README.md) is the short project overview and local quick
start.

## Guides

- [Radium Gateway](Radium_Gateway.md)
- [Radium Chatroom](Radium_Chatroom.md)
- [Live sessions across Tabs](Radium_Chatroom/Live_Sessions.md) — proposed: live in-flight replies, Stop and reload resume in every Tab and device through short-lived Convex frames instead of Redis; shared with ACP
- [Notifications](Notifications.md) — session and usage-limit notifications: toasts and sound in open tabs, system notifications, Web Push, preferences, and the planned phone channel
- [Interface design](Interface_Design.md) — web UI spec: layout model, visual tokens, Run state, and Motion rules
- [ACP agents](ACP.md) — external harnesses (Claude Agent, Codex, Gemini CLI, …) over the Agent Client Protocol on a Worker: Worker host and Convex transport implemented, Chatroom UI proposed; with [agents](ACP/Agents.md), [sessions](ACP/Sessions.md), [transport](ACP/Transport.md), and [Chatroom mapping](ACP/Interactions.md)
- [Worker](Worker.md) — machine authentication, identity persistence, task status coordination, and proposed execution transport
- [Worker machine authentication](Worker/Machine_Authentication.md) — setup codes, key proofs, JWT refresh, owner management and configuration
- [Worker identity component](Worker/Component.md) — workspace package, internal enrollment/recovery/revocation API, and integration boundary
- [Worker task coordination](Worker/Tasks.md) — assignment/status boundaries, chat correlation and five-minute terminal cleanup
- [Worker tools in Chatroom](Worker/Chatroom.md) — executable Read/Edit/Create/Bash tools, configured directories, signed approvals and durable stage receipts
- [Worker native tools plan](Worker/Native_Tools.md) — Oh-My-Pi package reuse for full file editing and upstream shell/background-terminal architecture
- [Worker Bash tool reference](Worker/Bash_Tool.md) — embedded Rust shell, managed jobs, PTYs, service modes, and Worker integration requirements
- [Worker eval tool reference](Worker/Eval_Tool.md) — retained JavaScript/Python execution, tool callbacks, output, and runtime lifecycle
- [Worker authentication research](Worker/Authentication.md) — cross-network transport, machine identity, and component evaluation
- [Worker Convex Client transport](Worker/Convex_Transport.md) — authenticated identity subscription, task request/result paths and the ACP relay implemented
- [Earlier Worker connectivity research](Worker/Connectivity.md) — superseded WSS/Tailscale proposal and tradeoffs
- [Gateway ownership](Radium_Gateway/Ownership.md)
- [Gateway telemetry](Radium_Gateway/Telemetry.md) — opt-in request capture, deduplicated storage, sessions and branches, retention, and OTLP/webhook export
- [Observability and usage](observability.md)
- [Gateway subscription providers](Radium_Gateway/Subscriptions.md)
- [Gateway routing](Radium_Gateway/LoadBalancer.md) — strategies, session affinity, retries, cooldowns, error rules, and request provider preferences
- [Gateway credentials](Radium_Gateway/Credentials.md) — per-provider pools of API keys and OAuth/subscription accounts, OAuth flow adapters, and legacy secret names
- [Gateway usage limits](Radium_Gateway/Limits.md) — per-credential limit and balance snapshots, adapters, polling, budgets, and limit events

| Guide                                                             | Contents                                                                                        |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| [Architecture](architecture.md)                                   | Runtime boundaries, request flow, data ownership, and repository layout                         |
| [API reference](api.md)                                           | OpenAI-compatible endpoints, authentication, requests, streaming, and errors                    |
| [Deployment and configuration](deployment.md)                     | Environment variables, Convex Cloud, containers, and releases                                   |
| [Operational logging](logging.md)                                 | Local structured logging, ingestion limits, privacy, and known gaps                             |
| [Backend pre-rewrite handoff](Backend_Pre_Rewrite_Report.md)      | Source snapshot, persisted contracts, ownership bridge, and rewrite migration checklist         |
| [Convex reuse research](research/Convex_Reuse.md)                 | Helper/component candidates and adoption caveats                                                |
| [Gateway auto-routing research](research/Gateway_Auto_Routing.md) | Proposed cache-affine, quota-aware routing algorithm and prerequisites                          |
| [Gateway usage limits research](research/Gateway_Usage_Limits.md) | Upstream limit signals per provider and the per-credential tracking design                      |
| [OpenCode Code Mode research](research/OpenCode_Code_Mode.md)     | OpenCode v2 `execute` runtime, Code Mode tool split, catalog prompt, and captured system prompt |
| [Future agent tasks](tasks/README.md)                             | Separate scoped sessions for architecture debt, rollout, and product work                       |

## Growing The Docs

Document meaningful changes as they are implemented, in the same change as code.
Use product overviews such as `Radium_Gateway.md`, `Radium_Chatroom.md`, and
`Worker.md`, with focused guides such as `Radium_Gateway/LoadBalancer.md`.
Link implemented guides here and from the owning product overview, and
distinguish implemented behavior from proposals and rollout work.

## Source Of Truth

Documentation describes the checked-in implementation. When the docs and code
disagree, use these files to verify behavior before correcting the docs:

- HTTP route registration: `packages/backend/convex/http.ts`
- Application HTTP routes and handlers: `packages/backend/src/http/`; see
  [routing and CORS](api.md#http-routing-and-cors)
- Endpoint behavior: `packages/backend/convex/http/`
- Database records and indexes: `packages/backend/convex/schema.ts`
- Workspace authorization and membership: `packages/backend/convex/workspaces.ts` and
  `packages/backend/src/workspaces/policy.ts`
- Ownership migration definitions and verification: `packages/backend/convex/migrations.ts`
- Web routes: `apps/web/src/app/`
- Commands and dependency versions: root and package `package.json` files
- Container behavior: `packages/website/Dockerfile*`, `docker-compose*.yml`, and `packages/website/docker/`
- Release behavior: `.github/workflows/release.yml`

Planned behavior should be labeled as planned rather than presented as an
implemented feature. The audited offline API-only generator documented in
`deployment.md#offline-api-binding-codegen` writes only
`packages/website/convex/_generated/api.d.ts`; it does not perform remote
component analysis or deployment verification.
