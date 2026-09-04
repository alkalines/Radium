# Radium Documentation

This directory contains operational and developer documentation for Radium.
The root [README](../README.md) is the short project overview and local quick
start.

## Guides

| Guide                                         | Contents                                                                     |
| --------------------------------------------- | ---------------------------------------------------------------------------- |
| [Architecture](architecture.md)               | Runtime boundaries, request flow, data ownership, and repository layout      |
| [API reference](api.md)                       | OpenAI-compatible endpoints, authentication, requests, streaming, and errors |
| [Deployment and configuration](deployment.md) | Environment variables, Convex Cloud, containers, and releases                |

## Source Of Truth

Documentation describes the checked-in implementation. When the docs and code
disagree, use these files to verify behavior before correcting the docs:

- HTTP route registration: `convex/http.ts`
- Endpoint behavior: `convex/http/`
- Database records and indexes: `convex/schema.ts`
- Web routes: `src/app/`
- Commands and dependency versions: `package.json`
- Container behavior: `Dockerfile*`, `docker-compose*.yml`, and `docker/`
- Release behavior: `.github/workflows/release.yml`

Planned behavior should be labeled as planned rather than presented as an
implemented feature.
