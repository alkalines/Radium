# Gateway Ownership

Radium Gateway is self-hosted and BYOK-oriented. A signed-in Better Auth user
owns one or more personal workspaces. Organizations and workspace membership are
not implemented.

## Implemented

- `workspaces` records use `ownerType: "user"` and the Better Auth user id as
  `ownerId`.
- Workspace queries and mutations verify ownership on the server through
  `convex/workspaces.ts`. Browser-supplied ownership identifiers are not trusted.
- Providers, provider credentials, Exa credentials, MCP servers, Chatroom
  settings, chats, API keys, completions, and telemetry accept workspace
  ownership where applicable.
- The global `providers` table is catalogue metadata, not workspace state. Each
  workspace configuration stores a local provider snapshot containing its
  endpoint, adapter metadata, model mappings, pricing, and supported parameters.
  Workspace imports and model edits never replace another workspace's snapshot
  or global catalogue metadata.
- A workspace configuration row is authoritative even when disabled. Explicit
  provider deletion keeps a `deletedAt` tombstone and removes workspace and
  legacy credentials so migration fallback cannot resurrect the provider.
- Chats carry an explicit `scope`: `personal` chats are private to their creator;
  `workspace` chats are visible to the workspace audience. The current audience
  contains only the personal workspace owner because organization membership is
  not implemented.
- Workspace API keys are stored in `api_keys`. Only a SHA-512 hash and masked
  preview are persisted; the `rad-sk-...` value is returned once.
- Gateway requests resolve a workspace from the new API key. Legacy balance keys
  remain readable while their workspace mapping is created or backfilled.
- Usage and upstream cost are retained as operational data. New completion
  recording does not require or debit prepaid credits.
- The Chatroom and Gateway UI expose workspace selection and use the selected
  workspace for settings, credentials, keys, logs, telemetry, and chats.

## Migration

The schema is widened rather than replacing legacy ownership fields. The
`@convex-dev/migrations` component is mounted in `convex/convex.config.ts`, and
ordered migrations are defined in `convex/migrations.ts`:

1. Create workspaces from balances and settings.
2. Move workspace configurations, local provider snapshots, credentials, API
   keys, MCP servers, settings, chats, completions, and telemetry records to
   workspace ownership.
3. Keep legacy fields for fallback reads and rollback until verification is
   complete.

The migration runner has not been executed against a deployment. Fresh installs
provision a personal workspace through `workspaces.ensurePersonalWorkspace`.

## Known Limitations

- Organization ownership, invitations, roles, and shared workspaces are not
  supported.
- Existing records may still be balance-owned until the migration runs; the
  runtime intentionally keeps bounded legacy fallback reads.
- Provider catalogue records remain global and read-only to workspace mutations.
  A workspace with no configuration rows may temporarily fall back to enabled
  catalogue providers while its legacy balance migration is pending. Once any
  local configuration row exists, including a disabled or tombstoned row, the
  workspace does not use that fallback.
- The migration currently guards the global provider catalogue at 200 provider
  rows and aborts rather than silently skipping a larger catalogue. Paginated
  provider migration is required before running against a catalogue above that
  documented limit.
- Migration verification, production rollout, and narrowing/removal of legacy
  fields are pending.

## Verification

Run the focused website suite with:

```sh
bun test ./packages/website/src/test.ts
```

This currently exercises 32 tests, including
`src/utils/workspaces/policy.test.ts` and
`src/utils/workspaces/migration.test.ts` and
`src/utils/workspaces/provider.test.ts`. The production website build also
passes with `bun run --cwd packages/website vite:build`. The full TypeScript
check remains blocked by unrelated Better Auth/UI dependency errors; no
deployment migration has been run. Do not run the migration runner as a
substitute for ownership and authorization tests.
