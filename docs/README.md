# Radium Documentation

This directory contains operational and developer documentation for Radium.
The root [README](../README.md) is the short project overview and local quick
start.

## Guides

| Guide                                             | Contents                                                                     |
| ------------------------------------------------- | ---------------------------------------------------------------------------- |
| [Architecture](architecture.md)                   | Runtime boundaries, request flow, data ownership, and repository layout      |
| [API reference](api.md)                           | OpenAI-compatible endpoints, authentication, requests, streaming, and errors |
| [Deployment and configuration](deployment.md)     | Environment variables, Convex Cloud, containers, and releases                |
| [Operational logging](logging.md)                 | Local structured logging, ingestion limits, privacy, and known gaps          |
| [Convex reuse research](research/Convex_Reuse.md) | Helper/component candidates and adoption caveats                             |
| [Future agent tasks](tasks/README.md)             | Separate scoped sessions for architecture debt and product work              |

## Growing The Docs

Document meaningful changes as they are implemented, in the same change as code.
Use product overviews such as `Radium_Gateway.md`, `Radium_Chatroom.md`, and
`Agent_Runner.md`, with focused guides such as `Radium_Gateway/LoadBalancer.md`.
These are naming conventions, not claims that those planned guides or features
already exist. Create them as their tasks proceed, link them here and from the
owning product overview, and distinguish implemented behavior from proposals.

## Source Of Truth

Documentation describes the checked-in implementation. When the docs and code
disagree, use these files to verify behavior before correcting the docs:

- HTTP route registration: `packages/website/convex/http.ts`
- Endpoint behavior: `packages/website/convex/http/`
- Database records and indexes: `packages/website/convex/schema.ts`
- Web routes: `packages/website/src/app/`
- Commands and dependency versions: root and package `package.json` files
- Container behavior: `packages/website/Dockerfile*`, `docker-compose*.yml`, and `packages/website/docker/`
- Release behavior: `.github/workflows/release.yml`

Planned behavior should be labeled as planned rather than presented as an
implemented feature.
