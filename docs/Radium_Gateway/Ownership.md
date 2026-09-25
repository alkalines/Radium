# Gateway Ownership

Radium Gateway is self-hosted and BYOK-oriented. Each signed-in Better Auth user
can own multiple personal workspaces. A workspace can also have explicit members:
the owner adds an existing Better Auth user by email, independent of any Better
Auth organization. This is direct membership, not an invitation flow.

## Implemented

- `workspaces` records use `ownerType: "user"` and the Better Auth user id as
  `ownerId`.
- Workspace queries and mutations verify access on the server through
  `packages/backend/convex/workspaces.ts` and
  `packages/backend/src/workspaces/policy.ts`. Browser-supplied
  ownership or membership identifiers are not trusted.
- `workspace_members` stores only explicit `member` rows. The owner is implicit.
  `addMember` and `removeMember` accept an existing Better Auth email and are
  owner-only; no pending invitation or acceptance record is created.
- Owners manage provider configuration, credentials, API keys, MCP servers,
  workspace defaults, and telemetry. Members can use configured models and
  workspace-scoped shared chats and can create/use personal chats. Personal
  chats remain private to their creator, including when the creator is the
  workspace owner.
- Provider configurations, provider credentials, Exa credentials, MCP servers,
  Chatroom settings, chats, API keys, completions, and telemetry are workspace-
  scoped where applicable.
- The global `providers` table is catalogue metadata, not workspace state. Each
  workspace configuration stores a local provider snapshot containing its
  endpoint, adapter metadata, model mappings, pricing, and supported parameters.
  Workspace imports and model edits never replace another workspace's snapshot
  or global catalogue metadata.
- A workspace configuration row is authoritative even when disabled. Explicit
  provider deletion keeps a `deletedAt` tombstone and removes workspace and
  legacy credentials so migration fallback cannot resurrect the provider.
- Chats carry an explicit `scope`: `personal` chats are private to their creator;
  `workspace` chats are visible to the workspace owner and explicit members.
  `ListChats` returns a member's own personal chats plus shared workspace chats;
  it does not expose another user's personal chats.
- Workspace API keys are stored in `api_keys`. Only a SHA-512 hash and masked
  preview are persisted; the `rad-sk-...` value is returned once.
- Gateway requests resolve a workspace from the new API key. Legacy balance keys
  remain readable while their workspace mapping is created or backfilled.
- Usage and upstream cost are retained as operational data. New completion
  recording does not require or debit prepaid credits.
- General Gateway usage, logs, activity, and telemetry reads are owner-only and
  filter other users' personal chats. The Chatroom and Gateway UI expose
  workspace selection; owner management uses the selected workspace for settings,
  credentials, keys, MCP servers, logs, and telemetry.
- The application sidebar places workspace selection directly below the account
  menu as a compact icon-and-name control. Owners can choose a workspace icon;
  existing workspaces without one use the default boxes icon. Workspace creation,
  renaming, icon selection, direct member access, archiving, and restoration live
  on the authenticated `/settings/workspace` page. Adding a member grants an
  existing Better Auth user access immediately; it does not send or create an
  invitation.
- Provider, Exa, and MCP secret values stay in Secret Store and are represented in
  application tables by metadata and masked previews. Broader application-level
  encryption is future work. Explicit owner-auditing records are also future
  work and must not bypass workspace or chat authorization.

## Migration

The schema is widened rather than replacing legacy ownership fields. Legacy
`balances`, `keys`, attribution fields, and Secret Store namespaces are retained
intentionally during the cutover; this is not literal legacy-table deletion. The
`@convex-dev/migrations` component is mounted in
`packages/website/convex/convex.config.ts`, and ordered migrations are defined in
`packages/website/convex/migrations.ts`:

1. Create workspaces from balances and settings.
2. Assign legacy MCP servers to the user's deterministic default workspace.
3. Copy provider configurations, local snapshots, credentials, API keys,
   settings, chats, completions, and telemetry records to workspace ownership.
4. Keep legacy fields and Secret Store namespaces for compatibility during the
   forward-only cutover; new writes use workspace ownership and do not add credit
   dependencies.

The default workspace for user-scoped legacy settings and MCP servers is the
first active workspace for that owner in ascending creation order. This matches
`workspaces.getDefaultWorkspaceForUser`; legacy user-scoped resources do not get
duplicated into every workspace.

Migration callbacks fail closed on missing references, duplicate mappings,
cross-owner edges, and legacy chats whose user and balance disagree. Errors do
not include document values or secret material. An expected absent Secret Store
entry is skipped; an expired or unavailable entry stops the migration until key
material is restored. Repair or quarantine the affected record, restore Secret
Store key material when required, then rerun the affected migration and its
verification query.

Provider catalogue traversal uses the `by_slug` index and async pagination. It
does not truncate at an arbitrary provider count. If a single workspace's
provider snapshots or credential checks exceed Convex transaction limits, the
migration fails with remediation rather than partially claiming success; split
that provider work into a smaller migration before retrying.

Legacy API-key revocations are copied to `api_keys.revokedAt`. Revocation must
also be propagated to the retained legacy `keys` row so a deleted migrated key
cannot be accepted through the compatibility fallback or recreated by a reset.
Existing completion chat/user attribution is validated when present; historical
rows without disclosed chat attribution are not assigned a synthetic chat.

The migration runner and paginated verification queries have not been executed
against a deployment. Fresh installs provision a personal workspace through
`workspaces.ensurePersonalWorkspace`. The parent schema cannot be redeployed
after new workspace-only writes exist: legacy required fields are absent from
those writes. This is therefore a forward-only cutover, not a rollback-compatible
deployment.

The audited offline API-only binding generator is documented in
`docs/deployment.md#offline-api-binding-codegen`. It uses the installed
`componentApiDTS` template and writes only
`packages/website/convex/_generated/api.d.ts`; it does not perform remote
component analysis or deployment verification. Never hand-edit generated files
or use that command as migration-readiness evidence.

## Known Limitations

- Better Auth organization ownership, invitations, organization-derived
  membership, and broader roles are not supported. Direct owner/member
  membership of existing users is the only implemented sharing policy.
- Existing records may still be balance-owned until the migration runs; the
  runtime intentionally keeps bounded legacy fallback reads.
- Provider catalogue records remain global and read-only to workspace mutations.
  A workspace with no configuration rows may temporarily fall back to enabled
  catalogue providers while its legacy balance migration is pending. This
  fallback applies to completion routing through Gateway API keys and to the
  Gateway model listing. Once any local configuration row exists, including a
  disabled or tombstoned row, the workspace does not use that fallback.
- Intentionally blank user-created workspaces may have no provider configuration
  until the owner imports a provider; verification requires catalogue coverage
  for migrated workspaces with legacy resources.
- All provider work for one workspace still shares one Convex transaction. A
  catalogue or snapshot set that exceeds transaction limits requires a separate
  smaller provider migration; it must not be truncated.
- The legacy `keys` table and Secret Store namespaces are retained during the
  cutover. A full rollback to the parent schema is not supported after any
  workspace-only record has been written.
- The current archive operation checks chats but not every child resource, so
  archived workspaces with credentials or keys require explicit remediation.
- Membership management is exposed through the owner-only Convex functions in
  `packages/website/convex/workspaces.ts`; a separate organization/invitation
  workflow is not claimed.
- Provider and MCP endpoints are owner-configured, but a complete
  SSRF/private-network policy and configurable egress control are not implemented.
  Deliberately configured local/private endpoints remain a required self-hosted
  use case. Define the policy separately in [task 04](../tasks/04_Upstream_Instances.md)
  before broadening endpoint configuration or claiming URL validation is complete.
- Migration verification, production rollout, and narrowing/removal of legacy
  fields are pending.

## Verification

Run the backend unit suite with:

```sh
bun test ./packages/backend/src/test.ts
```

Run the registered Convex backend regression suite with:

```sh
bun run --cwd packages/backend vitest run --config vitest.config.ts
```

The Bun suite includes `packages/backend/src/workspaces/policy.test.ts`,
`packages/backend/src/workspaces/migration.test.ts`, and
`packages/backend/src/workspaces/provider.test.ts`. The Convex suite
covers handler-level workspace/member chat authorization, migration ownership
checks, key revocation, and BYOK usage. No deployment migration has been run.
Do not run the migration runner as a substitute for ownership and authorization
tests.

Before declaring the migration complete, exhaust the paginated internal
verification queries: `verifyBalances`, `verifyWorkspaces`,
`verifyWorkspaceConfigurations`, `verifyProviderConfigurations`,
`verifyWorkspaceCredentials`, `verifyProviderSecrets`, `verifyKeys`,
`verifyApiKeys`, `verifyWorkspaceSettings`, `verifyMcpServers`,
`verifyChatroomSettings`, `verifyChats`, `verifyCompletions`, `verifyTraces`,
`verifySpans`, and `verifyTelemetryPayloads`. Aggregate every page's `issues`
and require zero issues; `pageClean` only describes the page returned by that
invocation. Verification returns bounded sample record IDs and never secret
values. For example:

```sh
bunx convex run migrations:verifyBalances \
  '{"paginationOpts":{"numItems":100,"cursor":null}}'
```

Continue with each query's `continueCursor`. `verifyProviderSecrets` can be
called with a provider slug when the complete catalogue does not fit in one
verification transaction. The `runAll` runner and these verification queries are
staged operational procedures, not evidence that the migration has run. Legacy
field narrowing is allowed only after every page reports zero issues and the
deployment readiness evidence is recorded. A successful migrations-component
status without zero-result verification is not readiness evidence.
