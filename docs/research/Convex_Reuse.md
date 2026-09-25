# Convex Reuse Research

Research snapshot: 2026-09-07. This is adoption guidance, not a dependency upgrade.
Update (2026-09-25): `convex-helpers` custom function builders are now a direct
backend dependency for Better Auth session and workspace guards; see
[authentication](../Convex/Authentication.md). The other candidates remain
evaluation items, not implemented features.
The current-dependency section records components already selected; the evaluation
table and remaining candidates are not claims of implementation.

## Current Dependencies

The backend lives in `packages/backend`. Better Auth, Secret Store, the local logging
component, `@convex-dev/rate-limiter`, and `@convex-dev/migrations` are mounted
components. The migrations component is used for the staged workspace ownership
backfill; its runner and verification queries have not been executed against a
deployment.

`convex-helpers@0.1.124` is a direct backend dependency for the custom function
builders; Better Auth and Secret Store also depend on compatible helper versions.
Recheck the lockfile, peer ranges, and release notes before upgrading.

## Recommended Evaluation

| Facility                                | Fit and caution                                                                                                                                               |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `customFunctions`                       | Adopted for shared authenticated query/mutation builders. Preserve `authComponent.getAuthUser(ctx)` and explicit resource ownership checks. |
| `rowLevelSecurity`                      | Consider only with a complete policy and all relevant access paths wrapped. It does not automatically secure existing functions.                              |
| Relationships / `asyncMap`              | Small join conveniences, not a reason to replace readable indexed queries.                                                                                    |
| Pagination / QueryStreams               | Consider for multi-range iteration or large telemetry lists; start with native pagination.                                                                    |
| Validators / Zod integration            | Reuse existing native `v` and Zod contracts. Check newer native Convex equivalents before adding helpers.                                                     |
| Triggers                                | Potential rollup/cleanup tool; all relevant writes must use wrappers. Dashboard edits/imports bypass triggers.                                                |
| Sessions                                | Anonymous client session IDs, not a replacement for Better Auth.                                                                                              |
| Query cache / generic CRUD / JS filters | Avoid redundant caching, authorization-free CRUD, and unbounded scans.                                                                                        |

The current workspace policy is application-owned rather than supplied by a
generic wrapper. Each user can own multiple personal workspaces;
`workspace_members` grants direct `member` access to an existing Better Auth
user, independent of Better Auth organizations. Owners manage workspace
configuration and secrets; members use configured models and shared chats, while
personal chats remain private to their creator. Do not replace this with
organization-derived access without an explicit policy and authorization tests.

Better Auth session validation is different from reading a JWT with
`ctx.auth.getUserIdentity()`. Browser auth wrappers must use the app's Better Auth
integration. Gateway bearer API keys and internal/scheduled jobs require their own
policies, not blanket browser-session wrappers. Components cannot read app auth or
app tables; the parent wrapper authorizes and supplies trusted identifiers.

The installed Better Auth adapter was `0.12.5`, with peer requirement
`better-auth >=1.6.11 <1.7.0`. The app's `^1.6.16` range permits a future unsupported
minor; evaluate a narrow compatible range in the auth task, not a blind upgrade.

## Components Before Custom Infrastructure

Search the [official directory](https://www.convex.dev/components),
[official catalog](https://www.convex.dev/components/get-convex-llms.txt), and
[full catalog](https://www.convex.dev/components/llms.txt). Inspect maintenance,
license, tests, peer compatibility, self-hosting, auth boundaries, migration
support, retry semantics, and operating costs before selection.

- [Rate limiter](https://www.convex.dev/components/rate-limiter): quotas and concurrency-related policy building blocks; now used for frontend log ingestion. Not network DDoS protection or billing.
- [Migrations](https://www.convex.dev/components/migrations): the selected component for the staged, resumable ownership backfill. `convex/migrations.ts` retains legacy schema and Secret Store namespaces during the forward-only cutover; it does not modify packaged Better Auth tables directly. Run and exhaust verification only in a controlled, authorized deployment.
- [Aggregate](https://www.convex.dev/components/aggregate): local usage/telemetry rollups, provided all source writes keep aggregates consistent.
- [Workpool](https://www.convex.dev/components/workpool) and [Action retrier](https://www.convex.dev/components/retrier): durable background work only with explicit idempotency. Not an OS execution runtime or automatic generation failover.
- [Action cache](https://www.convex.dev/components/action-cache): deterministic costly lookups, with identity/privacy/invalidation considered. Do not cache billable generation indiscriminately.
- [Persistent text streaming](https://www.convex.dev/components/persistent-text-streaming): evaluate for reconnectable streams, not a drop-in rich message persistence replacement.
- [Agent](https://www.convex.dev/components/agent): evaluate against existing Chatroom threads, AI SDK flow, and migration cost; do not adopt solely because this is an agent product. It does not replace the Runner's execution boundary.

Keep Radium-specific routing, credential eligibility, ownership, chat visibility,
and audit policy in the application. A reusable component is not automatically the
right owner of product policy. Secret Store protects the write-only credential
boundary; broader application-level encryption and an optional explicit owner
audit mode are future work. Hosted-service integrations are not suitable required
dependencies for the self-hosted baseline.

## Official Sources

- [convex-helpers README](https://github.com/get-convex/convex-helpers/blob/main/packages/convex-helpers/README.md)
- [convex-helpers changelog](https://github.com/get-convex/convex-helpers/blob/main/packages/convex-helpers/CHANGELOG.md)
- [Understanding components](https://docs.convex.dev/components/understanding)
- [Using components](https://docs.convex.dev/components/using)
- [Authoring components](https://docs.convex.dev/components/authoring)
- [Better Auth authorization](https://labs.convex.dev/better-auth/basic-usage/authorization)
- [Better Auth supported plugins](https://labs.convex.dev/better-auth/supported-plugins)
- [Better Auth local install](https://labs.convex.dev/better-auth/features/local-install)

See the [auth reuse task](../tasks/02_Convex_Auth_Reuse.md) for a bounded next step.
