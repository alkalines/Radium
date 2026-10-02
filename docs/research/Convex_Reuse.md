# Convex Reuse Research

Research snapshot: 2026-09-07. This is adoption guidance, not a dependency upgrade.
The current-dependency section records components already selected; the evaluation
table and remaining candidates are not claims of implementation.

## Current Dependencies

The backend lives in `packages/backend`. Better Auth, Secret Store, the local logging
component, `@convex-dev/rate-limiter`, and `@convex-dev/migrations` are mounted
components. The migrations component is used for the staged workspace ownership
backfill; its runner and verification queries have not been executed against a
deployment.

As of 2026-09-26, `convex-helpers` is a direct backend dependency pinned to
`0.1.124`. `convex/helpers.ts` imports its `customFunctions` builders for shared
workspace session authorization. This Apache-2.0 release supports the installed
Convex `1.46.0` and TypeScript 7 peer ranges; `0.1.119`, previously resolved
transitively, did not declare TypeScript 7 support. Better Auth backend version
`1.6.33` satisfies the adapter's `>=1.6.11 <1.7.0` peer range.

The official component catalog was checked for this adoption. The existing
Better Auth component owns session persistence; a new component is unnecessary
for stateless app-context customization and cannot inherit app table access.
`customFunctions` is the appropriate helper, with application workspace policy
retained in `convex/workspaces.ts`. It needs no hosted service, new persistence,
migration, or retry policy. Handler regressions exercise the shared authorization
before database operations. Blanket RLS remains unevaluated for broader adoption.

The 2026-09-26 context-enrichment follow-up rechecked the official component
catalog and `customFunctions` documentation. The existing builders also fit
workspace settings snapshots and mutation-only update methods. Chat permission
predicates remain standalone functions. Better Auth remains the session provider; no component is
needed to move app-owned settings into the authorized context. Settings database
access remains in `convex/workspaces.ts`, and the pure management predicate lives
in `src/workspaces/policy.ts`.

### Subscription HTTP Routing (2026-09-29)

The installed `convex-helpers/server/hono` adapter (`HttpRouterWithHono`) fits
subscription routing: it passes Convex action context as Hono bindings and retains
existing Convex route registrations, including Better Auth. Current official
helper/Hono documentation and the installed adapter source were checked. Hono
is a direct backend dependency rather than an implicit transitive import.
Authentication still uses Better Auth session validation and application-owned
workspace checks. The existing internal subscription-state functions retain
their persistence and retry behavior; this change needs no new component or
migration. An official Components directory lookup was attempted but failed to
decode, so no new catalog candidate was evaluated or adopted.

## Recommended Evaluation

| Facility                                | Fit and caution                                                                                                                                          |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `customFunctions`                       | Adopted for workspace query/mutation builders, including internal variants. Retains Better Auth session validation and explicit workspace access policy. |
| `rowLevelSecurity`                      | Consider only with a complete policy and all relevant access paths wrapped. It does not automatically secure existing functions.                         |
| Relationships / `asyncMap`              | Small join conveniences, not a reason to replace readable indexed queries.                                                                               |
| Pagination / QueryStreams               | Consider for multi-range iteration or large telemetry lists; start with native pagination.                                                               |
| Validators / Zod integration            | Reuse existing native `v` and Zod contracts. Check newer native Convex equivalents before adding helpers.                                                |
| Triggers                                | Potential rollup/cleanup tool; all relevant writes must use wrappers. Dashboard edits/imports bypass triggers.                                           |
| Sessions                                | Anonymous client session IDs, not a replacement for Better Auth.                                                                                         |
| Query cache / generic CRUD / JS filters | Avoid redundant caching, authorization-free CRUD, and unbounded scans.                                                                                   |

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

The 2026-10-01 [Worker authentication research](../Worker/Authentication.md)
evaluates API-key components, an external-worker orchestrator, OAuth provider,
and existing official components. It recommends a per-runner proof-of-possession
design. The 2026-10-02 [Convex Client decision](../Worker/Convex_Transport.md)
supersedes the [WSS/Tailscale follow-up](../Worker/Connectivity.md): commands,
approvals and batched output now target Convex queries/mutations and subscriptions.
Orchestrator is a claims/leases reference, not an adopted workflow runtime. The
local Worker identity persistence package is implemented; machine authentication,
transport and execution integration remain planned.

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
