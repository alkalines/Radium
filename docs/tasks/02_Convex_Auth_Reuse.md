# Convex Auth Reuse

Status: Workspace-access wrapper slice implemented; broader auth consolidation remains.
Scope: evaluate and adopt a small shared auth pattern.
Prerequisite: read [research](../research/Convex_Reuse.md) and current official docs.

## Entry Points

Under `packages/backend/`: `package.json`, `convex/helpers.ts`, `convex/auth.ts`, `convex/keys.ts`,
`convex/chatroom.ts`, `convex/aisdk.ts`, `convex/providers.ts`, and telemetry functions.

## Work

1. Inventory repeated session validation separately from resource authorization, HTTP API-key auth, upstream auth, and internal functions.
2. Evaluate `convex-helpers/server/customFunctions`; record alternatives and current compatible versions. Add a direct dependency only if adopted. Check the Better Auth dependency range against the adapter's actual peer requirements.
3. Introduce the smallest wrapper retaining `authComponent.getAuthUser(ctx)` session validation. Migrate a bounded representative set first; do not introduce blanket RLS or hide ownership checks.
4. `CreateChat` and `ForkChat` now take workspace IDs and use the shared workspace mutation builder before insertion; outsider rejection and member attribution have regression coverage.
5. Keep the pattern, exceptions, and migration guidance in the [ownership guide](../Radium_Gateway/Ownership.md#workspace-function-builders-implemented).

## Outcome And Remaining Work

- Implemented in `convex/helpers.ts`: public/internal workspace query and mutation
  builders exposing `ctx.identity` from `authComponent.getAuthUser(ctx)` and the
  authorized `ctx.workspace`. All nine `requireWorkspaceAccess` call sites migrated.
- Added direct `convex-helpers@0.1.124`; selection and compatibility are recorded in
  [reuse research](../research/Convex_Reuse.md).
- `CreateChat`, `ForkChat`, and `ListChats` throw on failed authentication rather
  than returning a string sentinel; creation/fork UI callers handle errors.
- Owner-only, chat-specific, optional-session, and non-workspace session checks
  remain explicit. Further consolidation needs its own inventory and regressions.
  API-key/HTTP and background-job authorization remain separate. Internal
  workspace builders are available but no existing background jobs were migrated.
- No persisted-data changes or remote operations are needed for this slice.

## Verification (2026-09-26)

- `bun install --frozen-lockfile`: passed after adding the direct dependency.
- `bun run test`: 68 tests passed across 16 files.
- `bun run --cwd packages/backend test convex/workspaces.test.ts`: all 6 passed
  after the final typed-reference test edits.
- Scoped `apps/web/node_modules/.bin/oxfmt --check` and `git diff --check`: passed.
- `packages/backend/node_modules/.bin/tsc --project packages/backend/tsconfig.json --rootDir packages/backend --noEmit`:
  fails on existing backend type-only imports, optional-index accesses, missing
  `vite/client` test types, and older `anyApi` test references. No errors reported
  in the new helper or new regression bodies.
- `apps/web/node_modules/.bin/tsc --project apps/web/tsconfig.json --noEmit --incremental false`:
  fails on existing frontend/backend type issues, including duplicate AI SDK
  types; the refactored creation/fork calls have no reported errors.
- Scoped `apps/web/node_modules/.bin/eslint`: blocked before linting because the
  root `eslint.config.mjs` cannot resolve its `eslint` import from root dependencies.
- No build, remote codegen, deployment, or migration was run. The offline API
  generator still targets the former frontend-owned Convex layout and pins an
  older audited Convex version; that workspace-layout blocker remains in task 09.
  The new module exports builders only; the migrated registered functions retain
  their existing names and their checked-in API imports infer the updated types.

## Acceptance

- Tests cover absent/expired session, authenticated owner, authenticated non-owner, and internal/API-key paths remaining distinct.
- No auth weakening, direct imports from transitive dependencies, or accidental public exposure of internal functions.
- Remaining migration work is listed explicitly. No unrelated provider routing or balance schema changes.
