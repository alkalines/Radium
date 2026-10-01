# Observability And Usage

## Implemented Organization

Radium's registered observability APIs live under
`packages/backend/convex/observability/`. This is a shared namespace with three
purpose-specific owners:

| Module        | Responsibility                                                                                                       | Persistence / shared code                                                                                                              |
| ------------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `events.ts`   | Authenticated browser operational-event ingestion and per-actor rate limiting                                        | Isolated logging Component; `packages/backend/src/logging/` owns the generic v1 envelope and best-effort backend console logger        |
| `usage.ts`    | Generation history (`getGenerations`), activity aggregation (`getActivity`), and recent usage estimates (`getUsage`) | `chat_completions`; one bounded workspace/legacy read and chat-visibility policy feeds all three queries                               |
| `aiTraces.ts` | Opt-in AI capture settings, trace/span/payload reads, summaries, deletion, and internal persistence                  | Existing `telemetry_*` tables; `packages/backend/src/telemetry/` owns AI SDK collection, summaries, validators, and the action adapter |

The frontend and internal AI persistence adapter use these namespaces. The old
`logging`, `logs`, `usage`, and `telemetry` modules re-export their original
functions for compatibility with existing clients and in-flight function references.
They own no independent implementations. Table shapes, indexes, Component mount
names, settings, and stored attribution are unchanged by this organization; no
data backfill is needed.

## Data And Authorization Flow

- Browser operational events pass through Better Auth session validation in
  `events.ingest`. The app derives the actor and applies the limiter before calling
  the isolated Component. This policy belongs in the app wrapper: Components do
  not inherit application auth. See [operational logging](logging.md) for envelope
  bounds, failure behavior, and the console-only backend sink.
- Usage queries require the workspace owner, merge bounded workspace and legacy
  reads, deduplicate completion IDs, and exclude other users' personal chats.
  Costs are historical operational estimates, never charges or balances.
- AI traces retain owner-only management and visibility filtering. Internal
  persistence validates server-derived workspace, actor, key, and chat
  associations. Capture is disabled by default and input/output recording remains
  independently controlled. See [AI telemetry](Radium_Gateway/Telemetry.md).

## Extending Operational Events

Non-AI backend events belong to the operational-event contract, not AI trace
payloads or completion usage. Existing Convex code can emit bounded operational
events with `logger` from `packages/backend/src/logging/server.ts`. It currently
writes to the Convex console only. New event names do not require an envelope or
table change; keep metadata non-sensitive and reuse opaque correlation fields.

Persistent backend events are **planned**, not implemented. A future server-owned
adapter must derive actor/workspace attribution at its authorized entry point;
the browser wrapper still accepts only the frontend source. Workspace-owned
events need an explicit workspace authorization/retention design before adding a
read API. Do not infer workspace access from the current actor-only Component
rows.

## Known Limitations And Verification

Operational events have no read API or automatic retention. AI capture has no
automatic retention or durable finalization retry. Usage and trace summaries are
bounded windows, not complete accounting or analytics pipelines. There is no
required hosted collector.

Run local regressions from the repository root:

```bash
bun run --cwd packages/backend test convex/ownership-review.test.ts src/logging src/telemetry
```

Handler coverage checks canonical/compatibility usage reads, duplicate legacy
attribution, owner/member boundaries, and personal-chat filtering for usage and
AI traces. Logging unit coverage does not prove authenticated Component ingestion
or rate limiting; the [observability follow-up](tasks/08_Local_Observability.md)
tracks that integration coverage and persistence expansion. Local tests do not
verify a deployment.

### Refactor Checks

- `bun run --cwd packages/backend test convex/ownership-review.test.ts src/logging src/telemetry`: 31 tests passed.
- `bun run --cwd packages/backend test src/http`: 17 tests passed.
- Offline API-only generation completed with the guarded command in
  [deployment configuration](deployment.md#offline-api-binding-codegen). It writes
  the local generated declaration, which is ignored in this checkout; no functions
  were uploaded and no deployment data was changed.
- Changed files were formatted with `apps/web/node_modules/.bin/oxfmt`; the root
  `bun run format` script could not resolve that executable.
- Scoped ESLint was blocked because the root `eslint.config.mjs` cannot resolve
  its `eslint` import from the workspace root.
- `apps/web/node_modules/.bin/tsc --noEmit -p packages/backend/tsconfig.json`
  was blocked by the backend's `rootDir: src` excluding its Convex files. Retrying
  with `--rootDir packages/backend` exposed strict/test typing issues elsewhere;
  the canonical observability modules and new regression-test calls produced no
  diagnostics.
- `apps/web/node_modules/.bin/tsc --noEmit -p apps/web/tsconfig.json` reported
  workspace alias, AI SDK version, and auth/UI type errors. Neither package has a
  clean typecheck result; these checks are not deployment verification.
