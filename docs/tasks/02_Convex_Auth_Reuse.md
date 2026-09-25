# Convex Auth Reuse

Status: In progress (2026-09-25). Scope: evaluate and adopt a small shared auth pattern.
Prerequisite: read [research](../research/Convex_Reuse.md) and current official docs.

## Entry Points

Under `packages/website/`: `package.json`, `convex/auth.ts`, `convex/keys.ts`,
`convex/chatroom.ts`, `convex/aisdk.ts`, `convex/providers.ts`, and telemetry functions.

## Work

1. Inventory repeated session validation separately from resource authorization, HTTP API-key auth, upstream auth, and internal functions.
2. Evaluate `convex-helpers/server/customFunctions`; record alternatives and current compatible versions. Add a direct dependency only if adopted. Check the Better Auth dependency range against the adapter's actual peer requirements.
3. Introduce the smallest wrapper retaining `authComponent.getAuthUser(ctx)` session validation. Migrate a bounded representative set first; do not introduce blanket RLS or hide ownership checks.
4. Audit `CreateChat` and `ForkChat`: inspection found supplied balance IDs are not independently checked for ownership before insertion. Confirm and fix with regression coverage; do not wait for the larger ownership migration to close a verified access-control gap.
5. Document the pattern, exceptions, and migration checklist in `docs/Convex.md` and `docs/Convex/Authentication.md`.

## Acceptance

- Tests cover absent/expired session, authenticated owner, authenticated non-owner, and internal/API-key paths remaining distinct.
- No auth weakening, direct imports from transitive dependencies, or accidental public exposure of internal functions.
- Remaining migration work is listed explicitly. No unrelated provider routing or balance schema changes.

## Progress and remaining work

`convex-helpers@0.1.124` is now a direct backend dependency (peer range supports
Convex 1.46 and TypeScript 7). `packages/backend/convex/function_auth.ts` has
session, direct-workspace, and server-derived user/workspace builders. Public
workspace configuration, chat and telemetry entry points use them; OAuth
binding and trace start use internal attribution builders. The explicit
per-resource checks and HTTP API-key paths remain separate. See
[authentication](../Convex/Authentication.md).

Follow up on the internal chat-ID jobs, usage attribution and API-key flows
individually: identify the trusted caller and propagate authorized identity
where required before introducing more builders. Review repeated handler
checks only after measuring and testing each legacy relationship. The legacy
balance ID audit for chat creation/forking remains an independent follow-up.
