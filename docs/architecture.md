# Architecture

Radium has two application runtimes: a TanStack Start web server and a Convex
backend. The browser uses both of them.

## Runtime Boundaries

### TanStack Start

The Vite-built TanStack Start application owns page rendering and frontend
server routes. File routes live in `src/app/`, with the route directory set in
`vite.config.mts`. `src/router.tsx` connects TanStack Router, React Query, and
Convex React Query.

The auth proxy at `src/app/api/auth/$.ts` connects the web origin to Better
Auth. It is separate from the gateway API.

### Convex

Convex owns persistent data, authenticated functions, billing, provider
selection, and public HTTP APIs. `convex/http.ts` registers the HTTP routes;
the OpenAI-compatible implementations are in `convex/http/`.

Consequently, gateway clients call the Convex site origin from
`VITE_CONVEX_SITE_URL`. They do not call the Vite server on port 3000.

## Completion Flow

```mermaid
sequenceDiagram
    participant Client
    participant HTTP as Convex HTTP action
    participant Gateway as Radium gateway
    participant Provider as AI provider
    participant DB as Convex database

    Client->>HTTP: POST /api/openai/v1/chat/completions
    HTTP->>DB: Hash and validate API key
    HTTP->>DB: Check available credits
    HTTP->>Gateway: Resolve model and eligible provider
    Gateway->>Provider: AI SDK request
    Provider-->>Gateway: Completion or stream
    Gateway-->>Client: OpenAI-compatible JSON or SSE
    Gateway->>DB: Record usage and debit credits
```

The built-in chatroom uses `POST /api/aisdk/chat`. That handler calls the same
internal completion flow and translates it to an AI SDK UI message stream.

## Provider And Model Data

Global model metadata is stored in `models`. Provider records contain routing
configuration, supported models, pricing, and supported parameters. A model is
routable only when:

- its global model record exists;
- an enabled provider offers that model slug; and
- the active balance has credentials for that provider.

Provider credentials are scoped to a balance and stored through the Convex
Secret Store component. The regular Convex tables contain only non-secret
metadata and masked previews.

The current gateway is BYOK-oriented: users configure upstream provider
credentials in the Gateway UI. The billing pipeline records upstream token
cost and applies the configured Radium credit calculation after a completion.

## Authentication And Keys

Better Auth protects the application UI and user-owned Convex functions.
Gateway HTTP clients authenticate separately with a `rad-sk-...` bearer token.
Only a SHA-512 hash and masked preview of each gateway key are persisted; the
plaintext key is returned once when created.

Balances own gateway keys, provider credentials, completions, and telemetry.
Code handling those records must verify ownership from the server-side auth
identity rather than trusting a client-provided user identifier.

## Telemetry

Internal telemetry is opt-in per user. Input and output recording are separate
settings. Trace records are stored in Convex and may also be exported to an
OTLP/HTTP collector when an exporter endpoint is configured.

## Generated Files

Do not manually edit:

- `convex/_generated/`
- `src/routeTree.gen.ts`

Run Convex development/code generation and TanStack Router generation through
the normal project commands instead.
