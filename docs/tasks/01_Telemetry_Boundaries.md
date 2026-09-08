# Telemetry Boundaries

Status: Not started. Scope: behavior-preserving refactor, not a telemetry rewrite.

## Entry Points

Under `packages/website/`: `convex/telemetry.ts`, `convex/telemetry_schemas.ts`,
`convex/telemetry_integration.ts`, `convex/schema.ts`, `convex/http/`, and
`src/components/gateway/telemetry-*`.

## Work

1. Trace Gateway and Chatroom instrumentation, settings, serializers, validators, and readers. Identify duplicate policy and unused helpers before moving anything.
2. Keep registered functions, database authorization, and table schema in Convex. Move reusable instrumentation/serialization and runtime-neutral contracts outside `convex/` with one owner per definition.
3. Preserve disabled-by-default collection, independent input/output controls, payload/span bounds, correlation, nested traces, and optional OTLP export.
4. Add regression tests and document the resulting boundaries in `docs/Radium_Gateway.md` and `docs/Radium_Gateway/Telemetry.md`; cross-link Chatroom behavior without duplicating it.

## Acceptance

- Existing UI queries, trace links, ownership checks, and exports retain behavior.
- Backend helpers do not import browser-only modules; frontend bundles do not pull server secrets/exporters.
- Tests cover disabled capture, payload bounds, correlation, ownership, and failure isolation as applicable.
- No schema migration, billing redesign, operational-log merger, or new analytics pipeline. Coordinate file ownership with tasks 02 and 08.
