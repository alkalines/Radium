# Self-Hosted Ownership

Status: Not started. First session: design and migration plan, not bulk deletion.

## Entry Points

Under `packages/website/`: `convex/schema.ts`, `convex/auth.ts`, `convex/key.ts`,
`convex/keys.ts`, `convex/credits.ts`, `convex/secrets.ts`, `convex/providers.ts`,
`convex/aisdk.ts`, `convex/logs.ts`, telemetry functions, `convex/http/chat_completion.ts`,
and Gateway/Chatroom UI references to `balances[0]`.

## Work

1. Inventory every balance reference and its actual role: owner, credential namespace, usage attribution, quota, or billing. Include API keys, chats, completion history, traces, Exa secrets, and setup/provisioning.
2. Propose the smallest explicit ownership model for self-hosted BYOK. Resolve single-owner versus workspace requirements with the user; do not invent a multi-tenant SaaS product.
3. Separate usage/cost estimates and optional quotas from prepaid credits. Self-hosted requests must not require purchasing or manually provisioning credits. Preserve access control and historical attribution.
4. Write a widen-migrate-narrow plan with resumable backfills, secret namespace handling, rollback/recovery, and verification; evaluate the migrations component.
5. Record the decision in `docs/Radium_Gateway/Ownership.md` and link from `docs/Radium_Gateway.md`. Split approved implementation into bounded follow-up task files and update deployment/API docs when behavior actually changes.

## Acceptance

- The plan accounts for existing data, keys, encrypted secrets, historical usage, and fresh installs.
- Future tests include BYOK without credits, ownership isolation, migration resume, and preserved history/credentials.
- No dropping `balances`, silently disabling auth, remote migration, or renaming IDs across the repository in this design session.
