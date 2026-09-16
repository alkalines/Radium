# Deployment And Configuration

Radium can use Convex Cloud during local/hosted development. Intended full
self-hosted and frontend-only container paths are documented below, but both
container and release paths are currently blocked and unverified pending the
[workspace-layout audit](tasks/09_Workspace_Operations.md).

## Environment Variables

### Application And Convex

| Variable               | Required          | Scope         | Purpose                                                                |
| ---------------------- | ----------------- | ------------- | ---------------------------------------------------------------------- |
| `CONVEX_DEPLOYMENT`    | Cloud development | Local CLI     | Convex deployment selected by `convex dev`                             |
| `VITE_CONVEX_URL`      | Yes               | Build/public  | Convex client URL, normally `https://<deployment>.convex.cloud`        |
| `VITE_CONVEX_SITE_URL` | Yes               | Build/public  | Convex HTTP action origin, normally `https://<deployment>.convex.site` |
| `SITE_URL`             | Yes               | Convex        | Public web origin used by Better Auth, such as `http://localhost:3000` |
| `SECRET_STORE_KEYS`    | Yes               | Deploy/Convex | Versioned key material used by Convex Secret Store                     |
| `AISDK_MaxRetries`     | No                | Convex        | AI SDK retry count; defaults to `0`                                    |
| `LWC_SECRET`           | Feature-specific  | Convex        | Signs ChatGPT Subscription sessions                                    |

`VITE_*` values are public and embedded at build time. Never put provider API
keys or other secrets in a `VITE_*` variable.

Generate local secrets with:

```bash
openssl rand -base64 32
openssl rand -hex 32
```

`SECRET_STORE_KEYS` uses a versioned value such as `1:<base64-key>`.

For Convex Cloud, set runtime values with the dashboard or CLI:

```bash
bunx convex env set SITE_URL http://localhost:3000
bunx convex env set SECRET_STORE_KEYS '1:<base64-key>'
bunx convex env set AISDK_MaxRetries 0
```

Upstream provider credentials are normally added by the workspace owner in
**Gateway > Credentials**. They are stored through Convex Secret Store and are
not public application environment variables. Broader application-level
encryption is future work; `SECRET_STORE_KEYS` only configures the Secret Store
component.

### OpenTelemetry Export

| Variable                             | Required | Purpose                                             |
| ------------------------------------ | -------- | --------------------------------------------------- |
| `OTEL_EXPORTER_OTLP_ENDPOINT`        | No       | OTLP/HTTP collector base URL                        |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | No       | Trace-specific endpoint overriding the base URL     |
| `OTEL_EXPORTER_OTLP_HEADERS`         | No       | Comma-separated base exporter headers               |
| `OTEL_EXPORTER_OTLP_TRACES_HEADERS`  | No       | Trace-specific exporter headers                     |
| `OTEL_SERVICE_NAME`                  | No       | Service name; container default is `radium-gateway` |

Configuring an exporter does not by itself enable telemetry. A user must enable
telemetry, input recording, and output recording independently in the app.
The full container requires HTTPS for remote OTLP endpoints; plain HTTP is
accepted only for loopback addresses.

## Convex Cloud Development

1. Copy `packages/website/.env.example` to `packages/website/.env.local` and set
   `SECRET_STORE_KEYS`.
2. Run `bun run --cwd packages/website convex:dev` and select or create a deployment.
3. Configure the Convex runtime values shown above.
4. Run `bun run --cwd packages/website vite:dev` in another terminal.

Convex writes deployment values such as `CONVEX_DEPLOYMENT`,
`VITE_CONVEX_URL`, and `VITE_CONVEX_SITE_URL` to
`packages/website/.env.local`.

### Initial Workspace Provisioning

After the first user signs up, the application provisions a personal workspace
through `workspaces.ensurePersonalWorkspace`. Import a provider in **Gateway** to
create its workspace-local endpoint and model mapping, then configure credentials;
no balance record or initial credit value is required for new BYOK operation.

The owner can create additional personal workspaces and add any existing Better
Auth user directly by email as a member. Membership does not use Better Auth
organizations and has no invitation-acceptance step. Members can use the
workspace's configured models and shared chats, plus their own private chats;
workspace configuration, credentials, API keys, MCP servers, defaults, and
telemetry remain owner-managed.

Existing balance-owned records are mapped to personal workspaces by the
resumable migration in `convex/migrations.ts`. The migration runner has not been
executed automatically by this application setup and must be run only after
authorization, counts, and Secret Store recovery are verified in a controlled
environment.

The migration is forward-only after new workspace-only writes exist: the parent
schema cannot be redeployed because those writes omit legacy required fields.
Legacy tables, fields, keys, and Secret Store namespaces are retained during the
staged cutover rather than literally deleted. See the [ownership guide](Radium_Gateway/Ownership.md)
for the ordered run and verification procedure.

No remote migration has been run. Narrowing or removing legacy fields is not
ready until every paginated verification query is exhausted with zero issues and
the deployment readiness evidence is recorded. A successful component status or
local test run is not migration-readiness evidence.

### Offline API Binding Codegen

The checked-in root API declaration can be refreshed without a deployment or
function upload. Run this from the repository root:

```bash
node \
  --require ./packages/website/scripts/convex-offline-network-guard.cjs \
  --experimental-loader ./packages/website/scripts/convex-offline-bindings-loader.mjs \
  ./packages/website/scripts/generate-convex-api-bindings.mjs \
  --write
```

This narrow generator writes only `packages/website/convex/_generated/api.d.ts`.
It uses the installed Convex `componentApiDTS` template and local static analysis
of the root component mounts, then formats the result with the installed Convex
formatter. The network guard is an additional check; it must remain enabled.

The driver is audited against the lockfile's Convex `1.45.0` installation and
uses an internal CLI export, not a stable public API. Review the generated diff
after Convex or component dependency updates. It supports the current static
`convex.config.ts` form and fails closed for dynamic imports, unsupported
statements, mount options, or component config syntax. It does not generate
schema, data model, server, or component files, perform remote component
analysis, or verify a deployment. Do not hand-edit `convex/_generated/` or use
normal `convex codegen` solely for this offline refresh.

## Full Self-Hosted Image (Blocked Pending Audit)

The full-image path is currently blocked and unverified. The existing workspace
layout audit found container build-context and dependency-path drift; this
session documents the intended path but does not repair broad container
infrastructure. Do not present the commands below as a working quickstart.

The intended `Dockerfile` path packages the TanStack Start server, Convex backend,
deployment code, and startup orchestration in one image. The intended ports are
Convex `3210`, HTTP actions `3211`, and the web app `3000`.

```bash
SECRET_STORE_KEYS="1:$(openssl rand -base64 32)" \
docker compose up --build
```

The `convex-data` volume persists backend state and generated instance
credentials. Keep this volume across restarts.

The intended startup orchestration:

1. Starts the local Convex backend.
2. Generates an admin key when one was not supplied.
3. Applies supported environment values to Convex.
4. Deploys the bundled `convex/` functions.
5. Starts the TanStack server.

For externally reachable deployments, set the public origins consistently:

```bash
CONVEX_CLOUD_ORIGIN=https://convex.example.com \
CONVEX_SITE_ORIGIN=https://api.example.com \
CONVEX_URL=https://convex.example.com \
CONVEX_SITE_URL=https://api.example.com \
VITE_CONVEX_URL=https://convex.example.com \
VITE_CONVEX_SITE_URL=https://api.example.com \
SITE_URL=https://radium.example.com \
SECRET_STORE_KEYS='1:<base64-key>' \
docker compose up --build
```

Because the `VITE_*` origins are build arguments, changing them requires an
image rebuild.

## Frontend-Only Image (Blocked Pending Audit)

The frontend-only container path is subject to the same unresolved workspace
layout audit. Treat the example as intended configuration, not verified release
behavior.

The intended `Dockerfile.frontend` path runs the built TanStack application and
expects Convex to be deployed separately.

```bash
VITE_CONVEX_URL=https://your-deployment.convex.cloud \
VITE_CONVEX_SITE_URL=https://your-deployment.convex.site \
docker compose -f docker-compose.frontend.yml up --build
```

Configure `SITE_URL`, Secret Store, provider credentials, and any optional
telemetry values on the external Convex deployment rather than in this
frontend container.

## Production Build Without Containers

Build-time Convex URLs must be present before building:

```bash
bun install --frozen-lockfile
bun run --cwd packages/website vite:build
bun run --cwd packages/website vite:start
```

The production server reads `.output/server/index.mjs` and defaults to port
`3000` unless `PORT` is set.

## Releases (Blocked Pending Audit)

The release workflow is not currently a verified path. Existing workflow and
Docker path references require the workspace-layout audit before publishing is
safe. No release or container repair is included in this documentation change.

`package.json` is the version source of truth. The release workflow accepts a
matching `v<version>` tag, a `releases/<version>` or `releases/v<version>`
branch, or a manual workflow version.

It publishes:

- `ghcr.io/alkalines/radium:<version>` and `latest` from `Dockerfile`
- `ghcr.io/alkalines/radium-frontend:<version>` and `latest` from
  `Dockerfile.frontend`

It also creates a GitHub release with generated notes. A release fails when
the requested version does not match `package.json`.
