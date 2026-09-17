# Self-Hosted Ownership

Status: In progress. Workspace implementation is available; migration rollout,
verification, and narrowing are not complete.

## Entry Points

Under `packages/website/`: `convex/schema.ts`, `convex/auth.ts`, `convex/workspaces.ts`,
`convex/migrations.ts`, `convex/key.ts`, `convex/keys.ts`, `convex/usage.ts`,
`convex/secrets.ts`, `convex/providers.ts`, `convex/aisdk.ts`, `convex/logs.ts`,
telemetry functions, `convex/http/chat_completion.ts`, `convex/provider_records.ts`,
and Gateway/Chatroom UI
workspace selection and ownership call sites.

## Work

1. Inventory every balance reference and its actual role: owner, credential namespace, usage attribution, quota, or billing. Include API keys, chats, completion history, traces, Exa secrets, and setup/provisioning.
2. Use personal user-owned workspaces as the explicit self-hosted BYOK ownership model; do not invent a multi-tenant SaaS product.
3. Separate usage/cost estimates and optional quotas from prepaid credits. Self-hosted requests must not require purchasing or manually provisioning credits. Preserve access control and historical attribution.
4. Implement and verify a forward-only widen-migrate-narrow cutover with resumable backfills, secret namespace handling, recovery, and authorization coverage. The parent schema must not be redeployed after workspace-only writes exist.
5. Record the decision in `docs/Radium_Gateway/Ownership.md` and update deployment/API docs when behavior actually changes.

## Acceptance

- The plan accounts for existing data, keys, encrypted secrets, historical usage, and fresh installs.
- Required verification includes BYOK without credits, ownership isolation,
  migration resume, preserved history/credentials, and deterministic assignment
  of legacy user-scoped settings and MCP servers.
- Illicit legacy chats, duplicate workspace mappings, missing references, and
  cross-owner key/trace/completion edges stop the affected migration without
  exposing secret material.
- Expected absent secrets remain valid; expired or unavailable Secret Store
  entries require key recovery before retrying.
- Legacy API-key revocations are propagated to both the new and retained key
  records, preventing fallback or reset resurrection.
- Every migrated table has an exhausted paginated verification query with zero
  issue counts before rollout is called ready.
- No dropping `balances`, silently disabling auth, remote migration, or renaming IDs across the repository in this design session.

## Current Follow-Up

- Pure authorization and migration decision tests cover personal/workspace chat
  access, legacy balance isolation, archived workspaces, deterministic
  user-scoped ownership, revocation propagation, and retry decisions. Registered
  Convex handler regressions additionally cover cross-workspace rejection,
  member/private-chat authorization, legacy key revocation, BYOK usage without
  credit debits, malformed migration graphs, removed-member history, and MCP
  secret recovery. These local checks do not replace deployment-data verification.
- Exhaust `migrations.verifyBalances`, `verifyWorkspaces`,
  `verifyWorkspaceConfigurations`, `verifyProviderConfigurations`,
  `verifyProviderSecrets`, `verifyKeys`, `verifyMcpServers`,
  `verifyApiKeys`, `verifyWorkspaceCredentials`, `verifyWorkspaceSettings`,
  `verifyChatroomSettings`, `verifyChats`, `verifyCompletions`, `verifyTraces`,
  `verifySpans`, and `verifyTelemetryPayloads`; record page cursors, issue
  counts, and remediation samples.
- Verify legacy API-key revocation and Secret Store namespace recovery before
  calling the cutover ready.
- Run the migration only in a controlled environment, inspect all verification
  pages, then document the evidence. Narrowing/removing legacy fields remains a
  separate follow-up after the forward-only cutover is stable.

## Component Rationale

`@convex-dev/migrations` is the official Convex Components directory's stateful
batch migration component. It provides persisted progress, resumable batches,
serial runners, dry runs, and status queries without adding an application
migration table. `convex-helpers/server/migrations` was considered, but its own
documentation recommends the official component for new work; `convex-helpers`
is retained only as the component's required peer dependency.

## Local Verification

- `bun test ./packages/website/src/test.ts`: 42 passing tests.
- `bun run --cwd packages/website vitest run --config vitest.config.ts`: 20 passing
  tests across five files.
- `bun run --cwd packages/website vite:build`: passed.
- Scoped formatting and `git diff --check`: passed.
- `bunx tsc --noEmit` from `packages/website`: blocked by existing errors in
  `src/components/auth/` and `src/components/ai-elements/reasoning.tsx`.
- `bun run lint`: blocked because the root script cannot resolve `eslint`.
- An independent subagent reviewed the change; integration findings were fixed.
  No remote migration, deployment, or deployment-data verification was performed.
