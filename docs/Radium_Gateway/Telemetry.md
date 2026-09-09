# AI Telemetry

## Implemented

AI telemetry is optional request/audit capture, separate from
[operational logging](../logging.md) and analytics. Collection defaults to off;
input and output capture are independently controlled. Local persistence does
not require an external collector.

### Responsibilities

Paths below are relative to `packages/website/`.

| Owner                             | Responsibility                                                                                                            |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `convex/telemetry.ts`             | Registered settings/trace queries and mutations, ownership checks, indexed read bounds, and persistence                   |
| `convex/telemetry_schemas.ts`     | Convex validators shared by functions and table schema                                                                    |
| `convex/telemetry_integration.ts` | Thin action-context adapter: attach server-derived owner IDs and wire internal start/finish mutations                     |
| `telemetry/integration.ts`        | Collector contracts, AI SDK event handling, usage mapping, serialization, error formatting, and optional OTLP integration |
| `telemetry/summary.ts`            | Pure request deduplication and bounded-window summary calculation                                                         |

The collector receives typed persistence callbacks, not a Convex context or
generated API. It has no database, browser, or Convex imports. The summary module
uses only type imports from the integration module, so queries do not load the
exporter. Import the integration at runtime only from server code: it reads
exporter environment configuration and may construct an OTLP exporter.

### Request And Auth Flow

`convex/http/chat_completion.ts` derives ownership from the validated Gateway
key and loads the owner's settings. `convex/http/aisdk.chat.ts` validates the
Chatroom session/chat and loads that user's settings. Both entry points gate
instrumentation on `enabled`; the collector factory itself does not enforce that
gate. Disabling settings also clears input/output recording flags in persistence.

Chatroom passes the same request ID into its nested Gateway calls. List and
summary queries prefer a Chatroom parent over a Gateway trace for that request
without reordering requests. Completion linking by request ID remains unchanged.

Public trace reads/deletes retain balance ownership checks. Internal trace start
validates balance ownership and optional key/chat associations before inserting.
These policies remain in Convex, not in the reusable collector. Tables, indexes,
function names, and UI query contracts are unchanged by the extraction.

### Bounds And Failures

The collector persists the first 100 spans. JSON capture uses the existing
32,000-character threshold and JSON-prefix repair, handles bigints/cycles/errors,
and falls back to `[Unserializable]` on serialization failure. Error messages are
capped at 4,000 characters and captured only when output recording is enabled.

Finalization runs at most once per collector instance across end, abort, and
error callbacks. Persistence errors still propagate to the caller of the
callback; finalization is not retried after failure. This is not durable
idempotency or a guarantee of failure isolation for the primary request.

Trace listing reads at most twice its requested limit (maximum limit 200).
Summaries inspect the newest 2,000 rows plus a truncation sentinel, then
deduplicate within that window. Detail reads retain existing span/payload bounds.

### Optional Export

See [deployment configuration](../deployment.md) for `OTEL_*` variables. A
trace-specific endpoint overrides the base endpoint; the base gets `/v1/traces`
appended. Invalid URLs, non-HTTPS remote endpoints, and non-loopback HTTP endpoints
are ignored. Headers are applied only for HTTPS. The existing shared provider
and end/abort/error flush behavior are preserved. No hosted collector is required.

## Known Limitations

- The 100-span cap is applied at finalization, not to in-memory accumulation.
- Per-payload character bounds do not guarantee a whole mutation fits Convex byte limits.
- There is no automatic retention or durable finalization retry in this subsystem.
- Authorization, disabled entry-point gating, live OTLP delivery, and browser
  behavior were reviewed in source but not exercised against a deployment in
  this refactor. New tests exercise the extracted helpers with fake persistence.

## Verification

Run from the repository root:

```sh
bun test ./packages/website/telemetry
bun test ./packages/website
```

Regression coverage includes independent capture controls, correlation, payload
serialization/truncation, span limits, once-only finalization, persistence failure
propagation, parent-trace selection, UTC daily aggregation, and empty summaries.
Future observability work is tracked in [task 08](../tasks/08_Local_Observability.md).
