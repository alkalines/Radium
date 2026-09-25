# Convex function authentication

## Implemented

`packages/backend/convex/function_auth.ts` exports `convex-helpers` custom
query/mutation builders. `authenticatedQuery` and `authenticatedMutation`
validate the Better Auth session through `authComponent.getAuthUser(ctx)` and
expose `ctx.user`. `ownerQuery` / `ownerMutation` require an active personal
workspace owned by that user; `memberQuery` / `memberMutation` permit the owner
or a direct `workspace_members` member. They accept a validated `workspace`
argument and expose `ctx.authorizedWorkspace`. Denials use `Not logged in.` or
`Workspace not found.`; existing handler-level resource checks remain in place
for provider, key, chat and legacy-pointer relationships. An authenticated
session alone is never proof of access to a chat or arbitrary resource ID.

`internalOwnerMutation` and `internalMemberMutation` check a workspace against
the `userId` passed by a trusted internal caller. They **do not** authenticate
that ID: the HTTP/action entry point must first validate its session or API
key and derive the ID server-side. OAuth credential binding and trace start
use these builders. Other internal queries/mutations have distinct policies:
some operate on already-authorized chat IDs, some serve API-key requests, and
migration/maintenance functions run without a browser session. Do not wrap
those in a browser-session builder. Gateway API-key authentication stays at
the HTTP boundary; `ctx.auth.getUserIdentity()` is not a substitute for Better
Auth validation.

`internalActiveWorkspaceQuery` checks only that a workspace exists and is
active for internal model/provider resolution. It does **not** authorize a
principal; its HTTP/action caller must already have checked the request's
session or API key and workspace scope.

`optionalSessionQuery` and `optionalMemberQuery` preserve the existing
`workspaces.list`, `workspaces.listArchived` and `aisdk.ListChats` signed-out
string results. `auth.userInfo` retains its direct Better Auth check in the
auth module to avoid an initialization cycle. An authenticated `ListChats`
caller must still pass the member/owner workspace check before its handler.
`optionalMemberMutation` similarly preserves signed-out returns for
`aisdk.CreateChat` and `aisdk.ForkChat` while checking workspace membership
for signed-in callers.

For a new function, choose the narrowest builder by entry-point identity and
resource role; retain indexed ownership checks for any other IDs in its args.
Keep internal server-derived attribution separate from user-submitted IDs.
Tests in `packages/backend/convex/workspaces.test.ts` cover missing sessions,
owner/member/outsider roles and internal chat authorization. Run:

```bash
bun run --cwd packages/backend test workspaces.test.ts
```

## Planned and limitations

Organization-based membership has no implemented policy. The builders only
recognize a user owner or explicit direct membership, independent of Better
Auth organization records. Resource-specific internal jobs and API-key flows
are not covered by a single generic session builder. Several migrated handlers
still repeat their original checks; this is safe but incurs redundant reads
until a reviewed follow-up consolidates each policy without losing its legacy
and per-resource constraints. There is no blanket row-level security wrapper:
unwrapped functions still require their own explicit checks.
