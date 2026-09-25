# AGENTS.md - Radium

## Product Direction

- **Radium** is the whole project, not a synonym for its gateway or chat UI. The current product target is self-hosted, bring-your-own-key/account/endpoint operation. Do not introduce required hosted services, prepaid credits, or SaaS billing assumptions.
- **Radium Gateway** is the OpenRouter-replacement routing product. It currently exposes OpenAI-compatible Chat Completions and workspace-scoped model listing. OpenAI Responses, Anthropic Messages, Gemini, and Grok protocol support are future work, not implemented compatibility claims. Optional request capture supports debugging and audit support; it is not an audit ledger and is distinct from operational logs and analytics.
- **Radium Chatroom** is the user-facing home for conversations and agents. It owns chat state, configuration, approvals, and agent UX; it uses Gateway for model routing rather than implementing a second router.
- **Implemented ownership boundary:** Each Better Auth user can own multiple personal workspaces. `workspace_members` explicitly grants `member` access to any existing Better Auth user added by email; the owner is implicit. Workspace-owned provider configuration, credentials, API keys, settings, MCP servers, chats, usage, and telemetry are isolated by workspace. Owners manage those resources; members use configured models and shared chats, while personal chats remain private to their creator. A widen-migrate-narrow bridge retains legacy balance-owned records, keys, and Secret Store namespaces until the backfill is verified. New BYOK operation does not require prepaid credits.
- **Membership boundary:** Direct owner/member membership is implemented without invitation acceptance. Better Auth organization ownership, invitations, organization-derived membership, and broader roles are future work; do not treat Better Auth organization records as workspace membership until an explicit policy is implemented and tested.
- **Agent Runner** is the external execution service for agent filesystem access, commands, coding, and other privileged work. `packages/agent-runner` and `packages/agent-runner-client` are currently health-check skeletons, not a functioning execution platform. Do not implement arbitrary shell/file execution in Convex or claim runner integration exists.
- Convex owns durable state, authorization, reactive queries, and coordination. Its default runtime is constrained, not a general-purpose host OS; external execution belongs in the Runner even though Convex also supports Node actions.
- Current debt is not the target architecture: `balances` mixes ownership with credits, provider credentials are not a general upstream pool, and routing is random. Do not extend these assumptions into new cross-product contracts. Do not remove persisted behavior without a migration either. The legacy balance bridge is compatibility code, not permission to add new balance or credit dependencies.

## Repository And Commands

- This is a Bun workspace. The TanStack Start/Vite frontend lives in `apps/web`; the Convex app and shared backend code live in `packages/backend`. Frontend routes are `apps/web/src/app`, configured in `apps/web/vite.config.mts`.
- `apps/web/src/router.tsx` wires TanStack Router, React Query, and `@convex-dev/react-query`. `@/*` resolves to the frontend's `src/*`.
- Run `bun install` at the root. `bun run dev` starts Vite and Convex, not the Runner.
- Frontend commands from the root: `bun run --cwd apps/web vite:dev`, `bun run --cwd apps/web vite:build`, and `bun run --cwd apps/web vite:start`. Convex dev: `bun run --cwd packages/backend dev`.
- Root scripts include `bun run lint`, `bun run format`, `bun run format:check`, and `bun run test`. `bun run test` runs all `packages/backend/src/**/*.test.ts` unit tests and `packages/backend/convex/**/*.test.ts` handler regressions through Vitest (`packages/backend/vitest.config.ts`). Import test APIs from `vitest`; add new tests as `*.test.ts` files under the appropriate tree, without a central test entrypoint. To run a subset, use `bun run --cwd packages/backend test <path-filter>`. There is no configured typecheck script. Use explicit, scoped commands for other checks and report their results. Do not run repository-wide formatting for an unrelated change.
- Ownership migration code is staged through `packages/backend/convex/migrations.ts` and `@convex-dev/migrations`; `runAll` and the paginated verification queries have not been run against a deployment. Do not run remote migrations or any codegen mode that may upload functions without explicit authorization.
- The checked-in Convex generated declarations are refreshed with the audited offline API-only command in `docs/deployment.md`, not by hand. It uses the installed Convex `componentApiDTS` internal template, writes only `packages/backend/convex/_generated/api.d.ts`, and fails closed on unsupported config syntax. Never hand-edit `packages/backend/convex/_generated/`; this path does not perform remote component analysis or deployment verification, so do not claim either.
- Check each package's `package.json` before documenting or running commands. Container and release paths are currently blocked and unverified pending the workspace-layout audit in [task 09](docs/tasks/09_Workspace_Operations.md); do not present those paths as a working quickstart or repair broad infrastructure in an ownership session.

## Work Method

1. Read relevant source, documentation, skills, and the worktree diff before proposing abstractions. Trace callers and persisted data, not just filenames. Search for an existing helper, validator, component, or policy before adding another.
2. For nontrivial library work, consult current official documentation (Context7 when available). Before building generic backend infrastructure, search the [Convex Components directory](https://www.convex.dev/components) and [convex-helpers](https://github.com/get-convex/convex-helpers). Record the relevant candidate and why it fits or does not fit. Do not install a dependency just because it exists.
3. Use subagents for bounded research, independent implementation, and review when useful. Give each a clear scope, owned files, constraints, and verification expectations; do not have parallel agents edit the same files. The coordinating agent reviews and integrates their results.
4. Keep a session to one coherent, verifiable change. Cross-cutting redesigns should become separate handoff tasks, not a speculative rewrite in one session. Use [docs/tasks](docs/tasks/README.md), record dependencies and outcomes, and do not mark plans as implemented.
5. Make the smallest correct change, update its documentation as you go, add regression coverage for changed behavior, and run relevant checks. Report exact commands, pre-existing failures, skipped checks, and side effects. Never substitute a passing build for authorization or behavior tests.
6. Preserve unrelated work. Do not commit, deploy, upload functions, run remote migrations, or mutate deployment data without explicit authorization. Some Convex codegen modes upload functions: inspect command behavior and target first; use local/offline generation where supported or report the blocker.

## Boundaries And Reuse

- Keep application `packages/backend/convex/` focused on registered queries, mutations, actions, HTTP entry points, schema, configuration, and database/auth policy. Component implementations have their own schema and functions under `packages/backend/convex/components/`.
- Put reusable runtime-neutral contracts, formatting, serialization, routing decisions, and instrumentation helpers **outside** `convex/`, under the nearest domain module in `packages/backend/src/`; `packages/backend/src/logging/` is the shared logging example. Browser-specific helpers belong elsewhere under `src/`. Shared backend helpers must not import browser state or bundler-only modules.
- Keep database access and ownership checks near the Convex function that owns them. Small local helpers are fine; do not scatter one feature into `*_schemas`, `*_integration`, and utility modules with duplicate definitions. File count alone is not the problem: establish one owner per contract or policy.
- Promote genuinely repeated validators, auth checks, provider options, error mappings, and header sets to their nearest shared owner. Avoid copied branches, one-use abstraction layers, generic frameworks, and parallel implementations of the same feature.
- Prefer a Convex Component for reusable isolated persistence or durable infrastructure; prefer `convex-helpers` for appropriate function wrappers and stateless conveniences. Evaluate maintenance, license, peer versions, self-hosted operation, auth boundaries, idempotency, migrations, and tests before adoption. Do not depend on transitive packages directly.
- `convex-helpers` is not an auth provider. An app auth wrapper must preserve Better Auth session validation via `authComponent.getAuthUser(ctx)`. Keep browser-session auth, Gateway API-key auth, internal jobs, and upstream credentials distinct. See [research notes](docs/research/Convex_Reuse.md) before adopting wrappers or RLS.
- Components do not inherit application auth or table access. Authenticate and authorize in the app wrapper, then pass server-derived identity into the component. Never trust browser-supplied ownership identifiers.
- Use argument and return validators on new Convex functions, bounded/indexed reads, explicit ownership checks, and tested retry/idempotency behavior. Preserve authorization when consolidating code.
- Use TSDoc for useful public contracts and non-obvious behavior, not narration of obvious code. Follow existing formatting and UI conventions; shadcn config is `apps/web/components.json`, styles are `apps/web/src/styles/app.css`.

## Domain Guardrails

- **Ownership and usage:** Workspace ownership is the implemented boundary for new resources. Legacy `balances`, `keys`, and attribution fields remain during the staged migration and must not become new dependencies. BYOK usage and cost estimates are operational data, not prepaid billing or a charge; changes require a dependency inventory and widen-migrate-narrow plan, not a table rename.
- **Workspace scopes:** New resources must carry an explicit workspace owner. Owners manage provider configuration, credentials, API keys, MCP servers, workspace defaults, and telemetry. Members can use workspace models and workspace-scoped chats and can create personal chats; personal chats are private to their creator, including when the creator is the owner. Direct membership is the only implemented sharing policy; organization-derived access is future.
- **Upstreams:** distinguish provider/protocol adapter, model mapping, endpoint, credential/account, and schedulable upstream instance. The design must accommodate multiple ChatGPT accounts and multiple vLLM/Ollama servers, not one credential per brand. Pooling, weights, health, concurrency, cooldowns, and safe failover are planned. Never retry after emitted stream output or duplicate billable/side-effecting work without an explicit policy.
- **Secrets:** preserve write-only Secret Store storage and masked displays. Broader application-level encryption is future work. Never put credentials in browser state beyond necessary input, logs, task notes, or model metadata. Endpoint configuration is owner-only today; a separate [upstream endpoint task](docs/tasks/04_Upstream_Instances.md) must define SSRF/private-network policy and configurable egress while preserving deliberately configured local servers.
- **Observability:** operational logging, optional AI request capture, and analytics are separate purposes with separate privacy and retention policy. General Gateway telemetry reads are owner-only and filter other users' private chats. Explicit owner-auditing records are future work and must not bypass workspace or chat authorization. Core operation must work locally without PostHog or another hosted collector. Existing optional OTLP export is not a required service.
- **Logging now:** Convex code uses `packages/backend/src/logging/server.ts` (console only); the frontend uses `apps/web/src/lib/logging.ts` and the local logging Component through an authenticated app wrapper. Reuse the versioned contract, bounded metadata, and correlation fields. Do not log secrets, prompts, responses, or transcripts by default. Logging must not break the primary operation. See [logging guide](docs/logging.md) for limits, including missing retention.
- **Legacy code:** inspect references before deleting Authors or similar leftovers. Standalone author queries appear unused, but the author table still supports model imports and selectors. Remove proven dead surfaces separately from persisted-model migrations.

## Current Entry Points

- Gateway HTTP registration: `packages/backend/convex/http.ts`; handlers: `packages/backend/convex/http/`. Public routes include `POST /api/openai/v1/chat/completions` and `GET /api/openai/v1/models`, hosted on the Convex site, not Vite.
- Chatroom posts to `POST /api/aisdk/chat`; `packages/backend/convex/http/aisdk.chat.ts` uses AI SDK and the internal OpenAI-compatible completion flow.
- Better Auth: `apps/web/src/app/api/auth/$.ts`, `packages/backend/convex/auth.ts`, `packages/backend/convex/auth.config.ts`, and `packages/backend/convex/convex.config.ts`.
- Workspace ownership: `packages/backend/convex/workspaces.ts`, `packages/backend/convex/migrations.ts`, `packages/backend/convex/schema.ts` (`workspaces` and `workspace_members`), `packages/backend/src/workspaces/policy.ts`, `packages/backend/convex/chat_observability.ts`, and `docs/Radium_Gateway/Ownership.md`.
- Public env names include `VITE_CONVEX_URL`, `VITE_CONVEX_SITE_URL`, and `CONVEX_DEPLOYMENT`. Convex runtime configuration includes `SITE_URL`, `SECRET_STORE_KEYS`, `AISDK_MaxRetries`, and feature-specific `LWC_SECRET`. Verify usage before changes; keep the owning env example and deployment guide aligned. Never print real env values.
- Do not hand-edit `packages/backend/convex/_generated/` or `apps/web/src/routeTree.gen.ts`.

## Documentation As You Go

- Documentation is part of implementation, not an optional final-session cleanup. Update the owning guide alongside each meaningful behavior, contract, architecture, configuration, or operational change. Capture decisions and limitations while context is fresh; review docs in the same diff as code.
- Use product overviews such as `docs/Radium_Gateway.md`, `docs/Radium_Chatroom.md`, and `docs/Agent_Runner.md`; put detailed subsystem guides beneath matching directories, for example `docs/Radium_Gateway/LoadBalancer.md`. Create a guide when working on that product/subsystem, not empty placeholder trees.
- Each guide should distinguish **implemented**, **planned**, and **known limitations**; explain responsibility, entry points, data/auth flow, configuration, failure behavior, and verification as relevant. The workspace ownership guide is the detailed contract; product overviews should link to it. A design proposal must not read like an operational feature guide.
- Link new guides from `docs/README.md` and their product overview. Keep the root README concise: overview, quick start, commands, and links. Reuse existing guides or move them with link updates rather than maintaining duplicate explanations.
- Verify claims against package scripts, routes, schemas, container files, and workflows. Use package-qualified repository paths, relative links, and fenced examples with copy-pasteable Bun commands. Never include real credentials or deployment identifiers.
- Handoff tasks belong in `docs/tasks/`, with scope, non-goals, prerequisites, entry points, acceptance checks, documentation deliverables, and status. Task completion requires code and docs verification; leave unresolved issues explicit for the next session.

<!-- convex-ai-start -->

Before changing Convex code, read
`packages/backend/convex/_generated/ai/guidelines.md` when present. Its Convex rules override
generic knowledge. Load the relevant available Convex skill for component,
auth, migration, or performance work. Skills can be installed with
`bunx convex ai-files install` from the owning package when requested.

<!-- convex-ai-end -->
