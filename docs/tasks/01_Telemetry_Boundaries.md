# Telemetry Boundaries

Status: Implemented extraction; deployment-level verification remains open.
Scope: behavior-preserving refactor, not a telemetry rewrite.

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

## Outcome

- Extracted collector/contracts/serialization/export into `packages/website/src/utils/telemetry/integration.ts`
  with typed persistence callbacks; the Convex adapter retains ownership IDs and mutation wiring.
- Extracted deduplication and aggregation into `packages/website/src/utils/telemetry/summary.ts`.
- Kept validators, bounded database access, authorization, schema, and API names in Convex.
- Added collector and summary regression tests. No dependency or schema changes;
  no codegen, deployment, or data migration performed.
- Documented the boundary and known limitations in the [Gateway overview](../Radium_Gateway.md)
  and [shared Gateway/Chatroom telemetry guide](../Radium_Gateway/Telemetry.md).
- Follow-up: deployed ownership/disabled-capture checks, UI smoke tests, and live
  OTLP delivery remain unverified. Failure propagation is preserved, not replaced
  with an untested isolation guarantee.

## Verification Evidence

- `bun test ./packages/website/src/utils/telemetry`: 12 passed, 0 failed.
- `bun test ./packages/website`: 21 passed, 0 failed.
- `bunx tsc --noEmit --incremental false -p packages/website/tsconfig.json`:
  blocked by 20 existing errors outside changed files (auth UI types, fetch
  types, missing `firstUserMessageText`, and reasoning component props).
- `bunx eslint packages/website/src/utils/telemetry packages/website/convex/telemetry.ts packages/website/convex/telemetry_integration.ts`:
  blocked because root `eslint.config.mjs` cannot resolve the `eslint` package.
- `bunx oxfmt --check packages/website/src/utils/telemetry packages/website/convex/telemetry.ts packages/website/convex/telemetry_integration.ts docs/Radium_Gateway.md docs/Radium_Gateway/Telemetry.md docs/README.md docs/architecture.md docs/tasks/01_Telemetry_Boundaries.md docs/tasks/README.md`:
  passed for the scoped code/docs; `git diff --check` passed.
