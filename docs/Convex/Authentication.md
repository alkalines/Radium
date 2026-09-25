# Convex function authentication

## Implemented

`packages/backend/convex/auth.ts` exports four `convex-helpers` builders:
`sessionQuery`, `sessionMutation`, `workspaceQuery`, and `workspaceMutation`.
All validate the Better Auth session through `authComponent.getAuthUser(ctx)`.
Workspace builders take `role: "owner" | "member"` and a validated `workspace`
argument. Member access requires direct `workspace_members` membership (or
ownership). They expose `ctx.user`; denials use `Not logged in.` or
`Workspace not found.`. Existing handler-level resource checks remain in place
for provider, key, chat and legacy-pointer relationships. An authenticated
session alone is never proof of access to a chat or arbitrary resource ID.

Internal functions retain their explicit authorization checks instead of using
browser-session builders. Their trusted HTTP/action entry points must first
validate a session or API key and derive user IDs server-side. Some operate on
already-authorized chat IDs, others serve API-key requests, and
migration/maintenance functions run without a browser session. Gateway API-key
authentication stays at the HTTP boundary; `ctx.auth.getUserIdentity()` is not
a substitute for Better Auth validation.

Internal model/provider resolution checks for an active workspace in its
handler; its HTTP/action caller must already have checked the request's
session or API key and workspace scope.

`allowUnauthenticated: true` preserves the existing
`workspaces.list`, `workspaces.listArchived` and `aisdk.ListChats` signed-out
string results (including `auth.userInfo`). An authenticated `ListChats`
caller must still pass the member/owner workspace check before its handler.
The same option preserves signed-out returns for
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
