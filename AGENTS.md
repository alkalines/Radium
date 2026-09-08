# AGENTS.md - Radium

## Product Direction

- **Radium** is the whole project, not a synonym for its gateway or chat UI. The current product target is self-hosted, bring-your-own-key/account/endpoint operation. Do not introduce required hosted services, prepaid credits, or SaaS billing assumptions.
- **Radium Gateway** is the OpenRouter-replacement routing product. It currently exposes OpenAI-compatible Chat Completions and model listing. OpenAI Responses, Anthropic Messages, Gemini, and Grok protocol support are future work, not implemented compatibility claims. Optional request capture serves audits and debugging; it is distinct from operational logs and analytics.
- **Radium Chatroom** is the user-facing home for conversations and agents. It owns chat state, configuration, approvals, and agent UX; it uses Gateway for model routing rather than implementing a second router.
- **Agent Runner** is the external execution service for agent filesystem access, commands, coding, and other privileged work. `packages/agent-runner` and `packages/agent-runner-client` are currently health-check skeletons, not a functioning execution platform. Do not implement arbitrary shell/file execution in Convex or claim runner integration exists.
- Convex owns durable state, authorization, reactive queries, and coordination. Its default runtime is constrained, not a general-purpose host OS; external execution belongs in the Runner even though Convex also supports Node actions.
- Current debt is not the target architecture: `balances` mixes ownership with credits, provider credentials are not a general upstream pool, and routing is random. Do not extend these assumptions into new cross-product contracts. Do not remove persisted behavior without a migration either.

## Repository And Commands

- This is a Bun workspace. The TanStack Start/Vite frontend **and** Convex app live in `packages/website`. Routes are `packages/website/src/app`, configured with `routesDirectory: "app"` in its `vite.config.mts`.
- `packages/website/src/router.tsx` wires TanStack Router, React Query, and `@convex-dev/react-query`. `@/*` resolves to the website's `src/*`.
- Run `bun install` at the root. `bun run dev` starts website Vite and Convex, not the Runner.
- Website commands from the root: `bun run --cwd packages/website vite:dev`, `bun run --cwd packages/website convex:dev`, `bun run --cwd packages/website vite:build`, and `bun run --cwd packages/website vite:start`.
- Root scripts include `bun run lint`, `bun run format`, and `bun run format:check`. There is no configured test or typecheck script; use explicit, scoped commands and report their results. Do not run repository-wide formatting for an unrelated change.
- Check each package's `package.json` before documenting or running commands. Container and release paths still need a workspace-layout audit; see [task queue](docs/tasks/README.md).

## Work Method

1. Read relevant source, documentation, skills, and the worktree diff before proposing abstractions. Trace callers and persisted data, not just filenames. Search for an existing helper, validator, component, or policy before adding another.
2. For nontrivial library work, consult current official documentation (Context7 when available). Before building generic backend infrastructure, search the [Convex Components directory](https://www.convex.dev/components) and [convex-helpers](https://github.com/get-convex/convex-helpers). Record the relevant candidate and why it fits or does not fit. Do not install a dependency just because it exists.
3. Use subagents for bounded research, independent implementation, and review when useful. Give each a clear scope, owned files, constraints, and verification expectations; do not have parallel agents edit the same files. The coordinating agent reviews and integrates their results.
4. Keep a session to one coherent, verifiable change. Cross-cutting redesigns should become separate handoff tasks, not a speculative rewrite in one session. Use [docs/tasks](docs/tasks/README.md), record dependencies and outcomes, and do not mark plans as implemented.
5. Make the smallest correct change, update its documentation as you go, add regression coverage for changed behavior, and run relevant checks. Report exact commands, pre-existing failures, skipped checks, and side effects. Never substitute a passing build for authorization or behavior tests.
6. Preserve unrelated work. Do not commit, deploy, upload functions, run remote migrations, or mutate deployment data without explicit authorization. Some Convex codegen modes upload functions: inspect command behavior and target first; use local/offline generation where supported or report the blocker.

## Boundaries And Reuse

- Keep application `packages/website/convex/` focused on registered queries, mutations, actions, HTTP entry points, schema, configuration, and database/auth policy. Component implementations have their own schema and functions under `packages/website/convex/components/`.
- Put reusable runtime-neutral contracts, formatting, serialization, routing decisions, and instrumentation helpers **outside** `convex/`. Use the nearest existing domain module; `packages/website/logging/` is the shared logging example. Browser-specific helpers belong under `src/`. Shared backend helpers must not import browser state or bundler-only modules.
- Keep database access and ownership checks near the Convex function that owns them. Small local helpers are fine; do not scatter one feature into `*_schemas`, `*_integration`, and utility modules with duplicate definitions. File count alone is not the problem: establish one owner per contract or policy.
- Promote genuinely repeated validators, auth checks, provider options, error mappings, and header sets to their nearest shared owner. Avoid copied branches, one-use abstraction layers, generic frameworks, and parallel implementations of the same feature.
- Prefer a Convex Component for reusable isolated persistence or durable infrastructure; prefer `convex-helpers` for appropriate function wrappers and stateless conveniences. Evaluate maintenance, license, peer versions, self-hosted operation, auth boundaries, idempotency, migrations, and tests before adoption. Do not depend on transitive packages directly.
- `convex-helpers` is not an auth provider. An app auth wrapper must preserve Better Auth session validation via `authComponent.getAuthUser(ctx)`. Keep browser-session auth, Gateway API-key auth, internal jobs, and upstream credentials distinct. See [research notes](docs/research/Convex_Reuse.md) before adopting wrappers or RLS.
- Components do not inherit application auth or table access. Authenticate and authorize in the app wrapper, then pass server-derived identity into the component. Never trust browser-supplied ownership identifiers.
- Use argument and return validators on new Convex functions, bounded/indexed reads, explicit ownership checks, and tested retry/idempotency behavior. Preserve authorization when consolidating code.
- Use TSDoc for useful public contracts and non-obvious behavior, not narration of obvious code. Follow existing formatting and UI conventions; shadcn config is `packages/website/components.json`, styles are `packages/website/src/styles/app.css`.

## Domain Guardrails

- **Ownership and usage:** `balances`, `keys`, and `chat_completions` currently couple identity, credentials, accounting, and access. The future ownership model must work without credits or payment. Usage/cost estimation can remain useful for BYOK, but is not prepaid billing. Changes require dependency inventory and a widen-migrate-narrow plan, not a table rename.
- **Upstreams:** distinguish provider/protocol adapter, model mapping, endpoint, credential/account, and schedulable upstream instance. The design must accommodate multiple ChatGPT accounts and multiple vLLM/Ollama servers, not one credential per brand. Pooling, weights, health, concurrency, cooldowns, and safe failover are planned. Never retry after emitted stream output or duplicate billable/side-effecting work without an explicit policy.
- **Secrets:** preserve write-only secret storage and masked displays. Never put credentials in browser state beyond necessary input, logs, task notes, or model metadata. Endpoint configuration needs an explicit SSRF/private-network policy that still supports deliberately configured local servers.
- **Observability:** operational logging, optional AI request/audit capture, and analytics are separate purposes with separate privacy and retention policy. Core operation must work locally without PostHog or another hosted collector. Existing optional OTLP export is not a required service.
- **Logging now:** Convex code uses `packages/website/logging/server.ts` (console only); the frontend uses `packages/website/src/lib/logging.ts` and the local logging Component through an authenticated app wrapper. Reuse the versioned contract, bounded metadata, and correlation fields. Do not log secrets, prompts, responses, or transcripts by default. Logging must not break the primary operation. See [logging guide](docs/logging.md) for limits, including missing retention.
- **Legacy code:** inspect references before deleting Authors or similar leftovers. Standalone author queries appear unused, but the author table still supports model imports and selectors. Remove proven dead surfaces separately from persisted-model migrations.

## Current Entry Points

- Gateway HTTP registration: `packages/website/convex/http.ts`; handlers: `packages/website/convex/http/`. Public routes include `POST /api/openai/v1/chat/completions` and `GET /api/openai/v1/models`, hosted on the Convex site, not Vite.
- Chatroom posts to `POST /api/aisdk/chat`; `packages/website/convex/http/aisdk.chat.ts` uses AI SDK and the internal OpenAI-compatible completion flow.
- Better Auth: `packages/website/src/app/api/auth/$.ts`, `packages/website/convex/auth.ts`, `packages/website/convex/auth.config.ts`, and `packages/website/convex/convex.config.ts`.
- Public env names include `VITE_CONVEX_URL`, `VITE_CONVEX_SITE_URL`, and `CONVEX_DEPLOYMENT`. Convex runtime configuration includes `SITE_URL`, `SECRET_STORE_KEYS`, `AISDK_MaxRetries`, and feature-specific `LWC_SECRET`. Verify usage before changes; keep the owning env example and deployment guide aligned. Never print real env values.
- Do not hand-edit `packages/website/convex/_generated/` or `packages/website/src/routeTree.gen.ts`.

## Documentation As You Go

- Documentation is part of implementation, not an optional final-session cleanup. Update the owning guide alongside each meaningful behavior, contract, architecture, configuration, or operational change. Capture decisions and limitations while context is fresh; review docs in the same diff as code.
- Use product overviews such as `docs/Radium_Gateway.md`, `docs/Radium_Chatroom.md`, and `docs/Agent_Runner.md`; put detailed subsystem guides beneath matching directories, for example `docs/Radium_Gateway/LoadBalancer.md`. Create a guide when working on that product/subsystem, not empty placeholder trees.
- Each guide should distinguish **implemented**, **planned**, and **known limitations**; explain responsibility, entry points, data/auth flow, configuration, failure behavior, and verification as relevant. A design proposal must not read like an operational feature guide.
- Link new guides from `docs/README.md` and their product overview. Keep the root README concise: overview, quick start, commands, and links. Reuse existing guides or move them with link updates rather than maintaining duplicate explanations.
- Verify claims against package scripts, routes, schemas, container files, and workflows. Use package-qualified repository paths, relative links, and fenced examples with copy-pasteable Bun commands. Never include real credentials or deployment identifiers.
- Handoff tasks belong in `docs/tasks/`, with scope, non-goals, prerequisites, entry points, acceptance checks, documentation deliverables, and status. Task completion requires code and docs verification; leave unresolved issues explicit for the next session.

<!-- convex-ai-start -->

Before changing Convex code, read
`packages/website/convex/_generated/ai/guidelines.md`. Its Convex rules override
generic knowledge. Load the relevant available Convex skill for component,
auth, migration, or performance work. Skills can be installed with
`bunx convex ai-files install` from the owning package when requested.

<!-- convex-ai-end -->
