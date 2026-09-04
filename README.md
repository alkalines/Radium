# Radium

**One gateway for your models, providers, and AI applications.**

Radium is an open-source AI gateway and chat platform designed to run on your
own infrastructure. It combines an OpenAI-compatible API, a capable AI
chatroom, and detailed generation telemetry in one deployable system.

> Radium is under active development. The Chat Completions compatibility layer
> is available today, but it does not yet cover every OpenAI API or parameter.

## The Radium Platform

### Radium Gateway

Connect AI applications to a single OpenAI-compatible endpoint while Radium
handles the providers behind it.

- Route streaming and non-streaming chat completions across configured models
  and providers.
- Bring your own provider credentials and keep them encrypted with Convex
  Secret Store.
- Manage a shared model catalogue, provider availability, pricing, context
  limits, and supported parameters.
- Issue hashed `rad-sk-...` API keys with optional credit limits.
- Record token usage, generation cost, time to first token, and completion
  duration.

Radium currently exposes:

```text
POST /api/openai/v1/chat/completions
GET  /api/openai/v1/models
```

[Explore the Gateway API](docs/api.md)

### Radium Chatroom

Use the same gateway through Radium's built-in chat experience. The Chatroom
supports persistent conversations, model and provider selection, reasoning
controls, configurable tools, and user-connected MCP servers.

The Chatroom and public Gateway API share the same provider catalogue,
credentials, billing records, and internal completion pipeline. This makes it
useful both as a daily AI workspace and as a direct way to verify a gateway
configuration.

[See how requests move through Radium](docs/architecture.md)

### Radium Telemetry

The new telemetry system gives each generation an inspectable execution trace.
It records request status, provider and model selection, timing, token usage,
generation steps, and tool calls. Traces and spans can be explored in the
Gateway UI.

Telemetry is opt-in per user. Input recording and output recording are separate
controls, and deployments can optionally export traces to an OTLP/HTTP
collector.

[Configure telemetry export](docs/deployment.md#opentelemetry-export)

### Self-Hosted By Design

Radium ships as a full self-hosted image containing the TanStack Start app and
a local Convex backend. A frontend-only image is also available for deployments
using Convex Cloud or a separately operated Convex backend.

Start the full stack with Docker Compose:

```bash
SECRET_STORE_KEYS="1:$(openssl rand -base64 32)" \
docker compose up --build
```

The full image deploys the bundled Convex functions at startup and persists its
backend state in a Docker volume.

[Read the deployment guide](docs/deployment.md)

## Future Direction

The following offerings are planned and are not available yet:

- **Radium Membership:** a program for people and teams operating their own
  Radium deployments, with a simpler path from setup to ongoing use.
- **Radium Enterprise:** an enterprise-grade offering focused on larger
  organizations, operational requirements, and managed deployment needs.

The open-source, self-hostable foundation remains central to Radium.

## Technology

Radium is built with TanStack Start, React 19, Convex, AI SDK, Better Auth,
Tailwind CSS, shadcn/ui, and Bun.

## Local Development

### Prerequisites

- [Bun](https://bun.sh)
- A Convex account and deployment
- Credentials for at least one supported AI provider

### Quick Start

1. Install dependencies and create a local environment file.

   ```bash
   bun install
   cp .env.example .env.local
   ```

2. Set the secret placeholders in `.env.local`, then link or create a Convex
   development deployment.

   ```bash
   bun run convex:dev
   ```

3. Configure the required Convex runtime values described in the
   [deployment guide](docs/deployment.md#convex-cloud-development).

4. In another terminal, start the web application.

   ```bash
   bun run vite:dev
   ```

5. Open <http://localhost:3000> and create an account.

Fresh deployments do not yet provision balances automatically. Create a
balance for the Better Auth user in the Convex dashboard before configuring
providers, credentials, and API keys under **Gateway**.

After initial configuration, `bun run dev` starts Vite and Convex together.

## Try The API

OpenAI-compatible endpoints are served from `VITE_CONVEX_SITE_URL`:

```bash
curl "$VITE_CONVEX_SITE_URL/api/openai/v1/chat/completions" \
  -H "Authorization: Bearer $RADIUM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "your-model-slug",
    "messages": [{ "role": "user", "content": "Hello" }],
    "stream": false
  }'
```

## Documentation

- [Documentation index](docs/README.md)
- [Architecture](docs/architecture.md)
- [API reference](docs/api.md)
- [Deployment and configuration](docs/deployment.md)

## Commands

| Command                | Purpose                                  |
| ---------------------- | ---------------------------------------- |
| `bun run dev`          | Start Vite and Convex together           |
| `bun run vite:dev`     | Start only the web app on port 3000      |
| `bun run convex:dev`   | Start and develop against Convex         |
| `bun run vite:build`   | Build the production application         |
| `bun run vite:start`   | Run the built application                |
| `bun run lint`         | Run ESLint                               |
| `bun run format`       | Format supported files with oxfmt        |
| `bun run format:check` | Check formatting without writing changes |

## Contributing

Use Bun and run the relevant checks before opening a pull request:

```bash
bun run lint
bun run format:check
bun run vite:build
```

There is currently no configured automated test script. Update the relevant
documentation whenever behavior, configuration, commands, or public APIs
change.
