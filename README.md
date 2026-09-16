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
- Configure workspace-local provider endpoints, model mappings, and bring-your-own
  provider credentials through Convex Secret Store.
- Use the shared model catalogue while each workspace controls provider
  availability, pricing, context limits, and supported parameters.
- Issue hashed, workspace-scoped `rad-sk-...` API keys.
- Record token usage, generation cost, time to first token, and completion
  duration as operational estimates; Radium does not charge or require prepaid
  credits.

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

Each signed-in user can own multiple personal workspaces. Owners manage the
workspace configuration and credentials; explicit members can use its configured
models and shared chats while their personal chats remain private. The Chatroom
and public Gateway API share workspace configuration, credentials, usage records,
and the internal completion pipeline.

[See how requests move through Radium](docs/architecture.md)
[Read the Chatroom ownership model](docs/Radium_Chatroom.md)

### Radium Telemetry

The new telemetry system gives each generation an inspectable execution trace.
It records request status, provider and model selection, timing, token usage,
generation steps, and tool calls. Traces and spans can be explored in the
Gateway UI.

Telemetry is opt-in per workspace. Input recording and output recording are
separate controls, general Gateway telemetry is owner-only, and private chat
records are filtered from owner views. Deployments can optionally export traces
to an OTLP/HTTP collector.

[Configure telemetry export](docs/deployment.md#opentelemetry-export)

### Self-Hosted By Design

The repository contains intended full-image and frontend-only container paths for
self-hosting. Those container and release paths are currently blocked and
unverified pending the [workspace-layout audit](docs/tasks/09_Workspace_Operations.md);
do not treat the command below as a working quickstart until that task is
resolved. The verified development path uses the website package and Convex
Cloud described below.

Intended full-image invocation (currently blocked/unverified):

```bash
SECRET_STORE_KEYS="1:$(openssl rand -base64 32)" \
docker compose up --build
```

The intended full image would deploy the bundled Convex functions at startup and
persist backend state in a Docker volume; this behavior is not currently a
verified release path.

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
   cp packages/website/.env.example packages/website/.env.local
   ```

2. Set the secret placeholders in `.env.local`, then link or create a Convex
   development deployment.

   ```bash
    bun run --cwd packages/website convex:dev
   ```

3. Configure the required Convex runtime values described in the
   [deployment guide](docs/deployment.md#convex-cloud-development).

4. In another terminal, start the web application.

   ```bash
    bun run --cwd packages/website vite:dev
   ```

5. Open <http://localhost:3000> and create an account.

The application provisions a personal workspace after sign-in. The workspace
owner can import a provider, configure its credentials, and issue API keys under
**Gateway**. No balance record or initial credit value is required for new BYOK
operation. Owners can add existing Better Auth users directly as workspace
members; there is no invitation-acceptance flow.

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
- [Gateway ownership](docs/Radium_Gateway/Ownership.md)
- [Chatroom](docs/Radium_Chatroom.md)
- [Offline API binding codegen](docs/deployment.md#offline-api-binding-codegen)

## Commands

| Command                                                               | Purpose                                  |
| --------------------------------------------------------------------- | ---------------------------------------- |
| `bun run dev`                                                         | Start Vite and Convex together           |
| `bun run --cwd packages/website vite:dev`                             | Start only the web app on port 3000      |
| `bun run --cwd packages/website convex:dev`                           | Start and develop against Convex         |
| `bun run --cwd packages/website vite:build`                           | Build the production application         |
| `bun run --cwd packages/website vite:start`                           | Run the built application                |
| `bun run lint`                                                        | Run ESLint                               |
| `bun run format`                                                      | Format supported files with oxfmt        |
| `bun run format:check`                                                | Check formatting without writing changes |
| `bun test ./packages/website/src/test.ts`                             | Run the website unit suite               |
| `bun run --cwd packages/website vitest run --config vitest.config.ts` | Run Convex backend regressions           |

## Contributing

Use Bun and run the relevant checks before opening a pull request:

```bash
bun run lint
bun run format:check
bun run --cwd packages/website vite:build
bun test ./packages/website/src/test.ts
bun run --cwd packages/website vitest run --config vitest.config.ts
```

There is no root `test` script, but the website unit suite is available through
the explicit command above. Update the relevant documentation whenever behavior,
configuration, commands, or public APIs change.
