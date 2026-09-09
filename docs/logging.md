# Operational Logging

Radium now has a small, best-effort operational logging path. It is for
diagnosing application behavior, not for audit evidence, AI transcript storage,
or product analytics.

## Scope

- `packages/website/src/utils/logging/server.ts` is the backend helper. Its initial sink is
  `console.log` in the Convex function log stream.
- `packages/website/src/lib/logging.ts` is the frontend helper. It submits a
  versioned envelope to the authenticated `convex/logging.ts` wrapper.
- `packages/website/convex/components/logging/` is a local Convex Component. Its
  `events` table is isolated from the application's regular tables.
- The provider logs one representative `app.loaded` event after Convex confirms
  an authenticated browser session. Existing AI telemetry is not refactored by
  this feature.

There is no required hosted logging or analytics service, no PostHog integration,
and no new logging environment variable. The component runs in the configured
Convex deployment: self-host Convex for local persistence. A locally defined
component does not make a cloud-configured deployment local.

## Envelope

The shared contract in `packages/website/src/utils/logging/contract.ts` is version `1`:

| Field         | Meaning                                                                |
| ------------- | ---------------------------------------------------------------------- |
| `version`     | Contract version, currently `1`                                        |
| `level`       | `debug`, `info`, `warn`, or `error`                                    |
| `event`       | Stable operational event name                                          |
| `message`     | Optional short operational message, not a prompt or transcript         |
| `source`      | Runtime that emitted the event, such as `frontend` or `convex`         |
| `product`     | Product namespace, currently `radium`                                  |
| `timestamp`   | Client/event time; useful context but not trusted for receipt ordering |
| `metadata`    | Optional flat primitive fields for bounded, non-sensitive context      |
| `correlation` | Optional opaque `requestId`, `traceId`, or `sessionId` values          |

The component additionally stores `receivedAt`, which is set inside the
component with the Convex server clock, and `actorId`, which is supplied by the
app wrapper from the `_id` on `await authComponent.getAuthUser(ctx)`. The browser
has no identity field to provide and cannot choose the stored actor. This uses the
Better Auth user record rather than the JWT-only `ctx.auth` identity.

## Limits And Privacy

Convex validators enforce the envelope shape. The shared runtime validation also
enforces these bounds before persistence:

- Event names: 128 characters; source and product: 64 characters each.
- Messages: 512 characters.
- Metadata: 16 entries, 64-character keys, 256-character string values, and
  2,048 serialized JavaScript string code units (not a UTF-8 byte limit).
- Correlation values: 128 characters and restricted to opaque identifier
  characters.
- Total serialized envelope: 8,192 JavaScript string code units.
- Client timestamps cannot be negative or more than five minutes in the future.
- Authenticated ingestion is limited to 60 events per identity in a fixed
  one-minute window by `@convex-dev/rate-limiter`.
- The public app wrapper accepts the frontend source and `radium` product
  namespace only; additional sources should get separate server-owned wrappers.

The default helpers do not include credentials, API keys, prompts, model input,
model output, transcripts, or user profile data. Sensitive-shaped metadata keys
are rejected. Callers must still keep free-form `message` values operational and
must not pass secrets or content explicitly. This logger is not a DLP or secret
scanner.

## Failure Behavior

- Unauthenticated ingestion is rejected.
- Shape-invalid arguments are rejected by Convex validation. Events exceeding
  runtime limits or rate limits return `false` without reaching the component.
- Component and rate-limiter failures are caught by the app wrapper.
- Frontend submission is fire-and-forget and swallows rejection, so logging does
  not block navigation, rendering, or user actions.
- Backend console logging is wrapped as best effort as well.

## Boundaries And Limitations

Operational events are separate from the existing `telemetry_traces`,
`telemetry_spans`, and `telemetry_payloads` tables. AI telemetry remains its own
opt-in feature, including its existing input/output recording controls. The new
events are not audit records and do not provide tamper evidence, legal
retention, or an audit export. They are also not analytics events and no product
metrics pipeline is attached.

The initial component intentionally has no client-facing read, search, delete,
or administration API. There is no automatic retention, TTL, or pruning job;
persisted events remain in the local Convex component until a future controlled
maintenance path removes them. The 60-per-minute limit is per authenticated
identity and is not a network-level DDoS protection layer. Convex deployment
quotas and storage growth still apply.

## Example

Use the frontend hook for small operational status events only:

```tsx
import { useFrontendLogger } from "@/lib/logging";

const log = useFrontendLogger();

log({
  level: "info",
  event: "settings.saved",
  metadata: { section: "preferences" },
});
```

Convex code can use the backend helper without changing application control
flow:

```ts
import { logger } from "../src/utils/logging/server";

logger.warn("provider.unavailable", {
  metadata: { provider: "example" },
});
```

## Verification

Run unit coverage from the repository root:

```bash
bun test packages/website/src/utils/logging
```

These tests cover envelope validation and best-effort console behavior, not
Convex authorization, transactional rate limiting, or component isolation. The
[local observability task](tasks/08_Local_Observability.md) tracks that integration
coverage, retention, and later analytics as separate work.

During initial implementation, `bunx convex codegen --typecheck disable` reported
uploading functions to the configured deployment. Do not treat component codegen
as inherently offline; inspect its mode and target and obtain authorization before
any command that uploads functions. No further remote verification was performed.
