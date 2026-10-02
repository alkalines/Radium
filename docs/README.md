# Radium Documentation

This directory contains operational and developer documentation for Radium.
The root [README](../README.md) is the short project overview and local quick
start.

## Guides

- [Radium Gateway](Radium_Gateway.md)
- [Radium Chatroom](Radium_Chatroom.md)
- [Agent Runner](Agent_Runner.md) — health-only implementation and proposed boundary
- [Runner authentication research](Agent_Runner/Authentication.md) — cross-network transport, machine identity, and component evaluation
- [Interactive Runner connectivity](Agent_Runner/Connectivity.md) — Tailscale-reachable Runner WSS, ACP stdio bridge, and bounded Convex persistence (proposal)
- [Gateway ownership](Radium_Gateway/Ownership.md)
- [Gateway and Chatroom AI telemetry](Radium_Gateway/Telemetry.md)
- [Observability and usage](observability.md)
- [Gateway subscription providers](Radium_Gateway/Subscriptions.md)

| Guide                                                        | Contents                                                                                |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| [Architecture](architecture.md)                              | Runtime boundaries, request flow, data ownership, and repository layout                 |
| [API reference](api.md)                                      | OpenAI-compatible endpoints, authentication, requests, streaming, and errors            |
| [Deployment and configuration](deployment.md)                | Environment variables, Convex Cloud, containers, and releases                           |
| [Operational logging](logging.md)                            | Local structured logging, ingestion limits, privacy, and known gaps                     |
| [Backend pre-rewrite handoff](Backend_Pre_Rewrite_Report.md) | Source snapshot, persisted contracts, ownership bridge, and rewrite migration checklist |
| [Convex reuse research](research/Convex_Reuse.md)            | Helper/component candidates and adoption caveats                                        |
| [Future agent tasks](tasks/README.md)                        | Separate scoped sessions for architecture debt, rollout, and product work               |

## Growing The Docs

Document meaningful changes as they are implemented, in the same change as code.
Use product overviews such as `Radium_Gateway.md`, `Radium_Chatroom.md`, and
`Agent_Runner.md`, with focused guides such as `Radium_Gateway/LoadBalancer.md`.
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
