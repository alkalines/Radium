# AGENTS.md - Radium

## Stack Reality
- This is a TanStack Start/Vite app. Routes live in `src/app` and are configured by `vite.config.mts` with `routesDirectory: "app"`.
- The frontend router is created in `src/router.tsx`; it wires TanStack Router, React Query, and `@convex-dev/react-query` with `VITE_CONVEX_URL`.
- Convex is the backend. HTTP endpoints are registered in `convex/http.ts`; OpenAI-compatible routes are Convex site routes, not Vite server routes.
- Better Auth is integrated through `@convex-dev/better-auth`: frontend auth handler route is `src/app/api/auth/$.ts`, Convex auth setup is `convex/auth.ts`, `convex/auth.config.ts`, and `convex/convex.config.ts`.

## Commands
- Use Bun. Install with `bun install`.
- `bun run dev` starts both `vite dev --clearScreen false` and `convex dev` via `concurrently`.
- `bun run vite:dev` starts only the Vite/TanStack Start dev server on port 3000.
- `bun run convex:dev` starts only Convex dev and generates Convex env values/files.
- `bun run vite:build` is the production build; `bun run vite:start` runs `.output/server/index.mjs` after a build.
- `bun run lint` runs ESLint. There is no configured test or typecheck script.

## Env Gotchas
- The app expects Vite-style public env names: `VITE_CONVEX_URL` and `VITE_CONVEX_SITE_URL`, plus `CONVEX_DEPLOYMENT`.
- Convex/provider envs include `Openrouter_API_Key` and `AISDK_MaxRetries` as shown in `.env.example`.
- `convex/auth.ts` reads `SITE_URL` for Better Auth `baseURL`; keep that available in the Convex environment when auth routes are involved.

## Generated And Configured Files
- Do not edit generated Convex files under `convex/_generated/` or generated TanStack Router file `src/routeTree.gen.ts` by hand.
- Before changing Convex code, read `convex/_generated/ai/guidelines.md`; its Convex rules override generic knowledge.
- shadcn is configured by `components.json` with `rsc: false`, aliases under `@/*`, Tailwind CSS at `src/styles/app.css`, and an `@ai-elements` registry.

## API And Chat Flow
- OpenAI-compatible API: `POST /api/openai/v1/chat/completions` and `GET /api/openai/v1/models` are registered in `convex/http.ts` and implemented under `convex/http/`.
- Built-in chat UI posts to Convex HTTP route `POST /api/aisdk/chat`; `convex/http/aisdk.chat.ts` wraps the internal OpenAI-compatible completion flow with `createOpenAICompatible` and AI SDK `streamText`.
- API-key auth and billing are tied to Convex tables `balances`, `keys`, and `chat_completions` in `convex/schema.ts`.

## Code Conventions Worth Preserving
- `@/*` resolves to `src/*` in both `vite.config.mts` and `tsconfig.json`.
- ESLint allows explicit `any` but warns on unused vars, empty object types, and non-`const` bindings.
- Convex public/internal functions should use validators; HTTP handlers are `httpAction`s mounted from `convex/http.ts`.
- Keep code at the layer that owns the policy. Router-level behavior belongs with route registration, endpoint behavior belongs with endpoint implementations, persistence rules belong near Convex data access, and UI behavior belongs near the relevant component or route.
- Avoid extracting single-use helpers or constants just to make code look organized. Prefer local control flow until an abstraction removes real duplication, clarifies a complex block, or defines a cross-module contract.
- Do not let repeated values or logic drift across files. When the same constant, header set, validation rule, auth pattern, provider option, or response shape appears in more than one place, promote it to the nearest shared owner instead of copying it again.
- Use TSDoc (`/** ... */`) as the standard documentation format when documentation is useful, especially for exported functions, non-obvious helpers, public APIs, and cross-module contracts. Do not add redundant comments for self-explanatory code.

<!-- convex-ai-start -->

This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, **always read
`convex/_generated/ai/guidelines.md` first** for important guidelines on
how to correctly use Convex APIs and patterns. The file contains rules that
override what you may have learned about Convex from training data.

Convex agent skills for common tasks can be installed by running
`bunx convex ai-files install`.

<!-- convex-ai-end -->
