# Deployment And Configuration

Radium can use Convex Cloud during local/hosted development. Intended full
self-hosted and frontend-only container paths are documented below, but both
container and release paths are currently blocked and unverified pending the
[workspace-layout audit](tasks/09_Workspace_Operations.md).

## Environment Variables

### Application And Convex

| Variable                  | Required          | Scope              | Purpose                                                                |
| ------------------------- | ----------------- | ------------------ | ---------------------------------------------------------------------- |
| `CONVEX_DEPLOYMENT`       | Cloud development | Local CLI          | Convex deployment selected by `convex dev`                             |
| `VITE_CONVEX_URL`         | Yes               | Build/public       | Convex client URL, normally `https://<deployment>.convex.cloud`        |
| `VITE_CONVEX_SITE_URL`    | Yes               | Build/public       | Convex HTTP action origin, normally `https://<deployment>.convex.site` |
| `SITE_URL`                | Yes               | Convex             | Public web origin used by Better Auth, such as `http://localhost:3000` |
| `SECRET_STORE_KEYS`       | Yes               | Deploy/Convex      | Versioned key material used by Convex Secret Store                     |
| `AISDK_MaxRetries`        | No                | Convex             | AI SDK retry count; defaults to `0`                                    |
| `LWC_SECRET`              | Feature-specific  | Convex             | Signs ChatGPT Subscription sessions                                    |
| `WORKER_AUTH_PRIVATE_JWK` | Worker auth       | Convex secret      | Private ES256 machine-token issuer JWK with `kid`                      |
| `WORKER_AUTH_JWKS`        | Worker auth       | Convex/auth config | Matching public JWKS for the optional custom JWT verifier              |

`VITE_*` values are public and embedded at build time. Never put provider API
keys or other secrets in a `VITE_*` variable.

`packages/backend/convex/convex.config.ts` declares the custom backend runtime
environment contract with Convex validators. `SITE_URL` and `SECRET_STORE_KEYS`
are required; `AISDK_MaxRetries`, `LWC_SECRET`, the Worker issuer keys, and the
OTLP variables below are optional. `CONVEX_CLOUD_URL` and `CONVEX_SITE_URL` are
Convex-provided system variables, not custom app settings. Declarations do not
set values: configure deployment values through the dashboard or `convex env`.
The app passes `SECRET_STORE_KEYS` to the Secret Store component by typed env
reference. The Worker identity component has no env inputs; its issuer keys stay
in app-owned signing and auth-verifier code.

Convex 1.46.0 exposes declared values through the generated `env` export in
`_generated/server`; the installed declarations mark app/component env support as
beta and unstable, so review it after Convex upgrades. Those generated bindings
have not been refreshed in this change, so backend runtime code still reads these
values through `process.env`.

Worker setup uses the backend's built-in `CONVEX_SITE_URL` and `CONVEX_CLOUD_URL`
for reachable HTTP/client origins. See [Worker machine authentication](Worker/Machine_Authentication.md)
for issuer-key generation, configuration application, setup codes and verification limits.

The frontend server also reads `VITE_CONVEX_SITE_URL` for its generic
`/api/backend/*` proxy, forwarding to the Convex site's `/api/*` routes. See the
[subscription provider guide](Radium_Gateway/Subscriptions.md) for the Hono
subscription routes and device-auth flow.

Generate local secrets with:

```bash
openssl rand -base64 32
openssl rand -hex 32
```

`SECRET_STORE_KEYS` uses a versioned value such as `1:<base64-key>`.

For Convex Cloud, set runtime values with the dashboard or run the CLI from
`packages/backend`:

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

The backend CLI selector, Convex deployment runtime values, and public frontend
build values are configured independently:

1. Run `bun run --cwd packages/backend dev` and select or create a Convex Cloud
   development deployment. The CLI stores its deployment selector in the
   ignored `packages/backend/.env.local` file.
2. In another terminal, set runtime values on the selected deployment:

   ```bash
   cd packages/backend
   bunx convex env set SITE_URL http://localhost:3000
   bunx convex env set SECRET_STORE_KEYS '1:<base64-key>'
   ```

   Generate a unique Secret Store key as shown above. Optional values belong on
   the deployment only when their feature is enabled; see
   [`packages/backend/.env.example`](../packages/backend/.env.example). If the
   initial `convex dev` process exited because required values were missing,
   rerun it now.

3. Copy `apps/web/.env.example` to `apps/web/.env.local`, then copy the selected
   deployment's `CONVEX_CLOUD_URL` and `CONVEX_SITE_URL` into `VITE_CONVEX_URL`
   and `VITE_CONVEX_SITE_URL`. These public values are copied independently;
   Convex CLI does not write them into the frontend file.
4. Keep the backend `convex dev` process running and start the frontend in a
   separate terminal with `bun run --cwd apps/web vite:dev`.

The `CONVEX_DEPLOYMENT` selector and any local CLI credentials select a target;
they do not set `SITE_URL`, `SECRET_STORE_KEYS`, or other Convex runtime values.
The backend example file documents those runtime values, while the frontend
example contains only the public `VITE_*` values.

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

### Standard Binding Codegen

Run from the repository root to generate Worker component bindings, build the
package, then generate backend bindings with the standard Convex CLI:

```bash
bun run codegen
```

The command first builds from checked-in bindings so the app's package import is
resolvable during component codegen. Both codegen steps run in `packages/backend`
using its configured deployment. The Worker step passes
`--component-dir ../worker-component/src/component`, then rebuilds the package;
the backend step runs `convex codegen`. Each step requires the previous one to
succeed. Standard codegen requires deployment access for component analysis and
does not deploy the generated functions. Review the generated diff before committing.

For a fresh checkout without deployment access, `bun run build:components` builds
the local workspace package from checked-in bindings. `bun run dev` builds it
first and runs a TypeScript build watcher alongside Vite and Convex. Source API
or schema changes still require the explicit codegen sequence above. Tests use
the built package too; `bun run test` builds before running backend tests. See the
[Worker component guide](Worker/Component.md) for package exports and scope.

### Offline API Binding Codegen

The checked-in root API declaration can be refreshed without a deployment or
function upload. Run this from the repository root:

```bash
node \
  --require ./apps/web/scripts/convex-offline-network-guard.cjs \
  --experimental-loader ./apps/web/scripts/convex-offline-bindings-loader.mjs \
  ./apps/web/scripts/generate-convex-api-bindings.mjs \
  --write
```

This narrow generator writes only `packages/backend/convex/_generated/api.d.ts`.
It uses the installed Convex `componentApiDTS` template and local static analysis
of the root component mounts, then formats the result with the installed Convex
formatter. The network guard is an additional check; it must remain enabled.

The driver is checked against the installed Convex `1.46.0` template and
uses an internal CLI export, not a stable public API. Review the generated diff
after Convex or component dependency updates. It supports the current static
`convex.config.ts` form and fails closed for dynamic imports, unsupported
statements, mount options, or component config syntax. It does not generate
schema, data model, server, or component files, perform remote component
analysis, or verify a deployment. Do not hand-edit `convex/_generated/` or use
normal `convex codegen` solely for this offline refresh.

The offline parser supports typed app environment declarations and literal
`app.env` references passed through component mounts. It validates the supported
string, literal, union, and optional validator forms without evaluating config
expressions or reading deployment values. Unsupported app options, env
expressions, and validator syntax still fail closed. Parser regressions are
covered by `node --test apps/web/scripts/convex-config-parser.test.mjs`.

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
bun run --cwd apps/web vite:build
bun run --cwd apps/web vite:start
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
