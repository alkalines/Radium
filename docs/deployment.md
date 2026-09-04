# Deployment And Configuration

Radium can use Convex Cloud during local/hosted development, run as a full
self-hosted container, or run as a frontend-only container against an external
Convex deployment.

## Environment Variables

### Application And Convex

| Variable               | Required          | Scope         | Purpose                                                                |
| ---------------------- | ----------------- | ------------- | ---------------------------------------------------------------------- |
| `CONVEX_DEPLOYMENT`    | Cloud development | Local CLI     | Convex deployment selected by `convex dev`                             |
| `VITE_CONVEX_URL`      | Yes               | Build/public  | Convex client URL, normally `https://<deployment>.convex.cloud`        |
| `VITE_CONVEX_SITE_URL` | Yes               | Build/public  | Convex HTTP action origin, normally `https://<deployment>.convex.site` |
| `SITE_URL`             | Yes               | Convex        | Public web origin used by Better Auth, such as `http://localhost:3000` |
| `SECRET_STORE_KEYS`    | Yes               | Deploy/Convex | Versioned encryption keys used by Convex Secret Store                  |
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

Upstream provider credentials are normally added per balance in **Gateway >
Credentials**. They are not public application environment variables.

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

1. Copy `.env.example` to `.env.local` and set `SECRET_STORE_KEYS`.
2. Run `bun run convex:dev` and select or create a deployment.
3. Configure the Convex runtime values shown above.
4. Run `bun run vite:dev` in another terminal.

Convex writes deployment values such as `CONVEX_DEPLOYMENT`,
`VITE_CONVEX_URL`, and `VITE_CONVEX_SITE_URL` to the local environment file.

### Initial Balance Provisioning

Balance creation is not automated yet. After the first user signs up, provision
a `balances` record in the Convex dashboard with that Better Auth user ID and
an initial `credits` value. `organizationId` and `teamId` are optional. The
Gateway credentials, API key, chatroom, logs, and telemetry views use the
signed-in user's first balance.

This is a current setup limitation, not a production-ready account funding
workflow.

## Full Self-Hosted Image

`Dockerfile` packages the TanStack Start server, Convex backend, deployment
code, and startup orchestration in one image. Convex listens on port `3210`,
HTTP actions on `3211`, and the web app on `3000`.

```bash
SECRET_STORE_KEYS="1:$(openssl rand -base64 32)" \
docker compose up --build
```

The `convex-data` volume persists backend state and generated instance
credentials. Keep this volume across restarts.

On startup, the container:

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

## Frontend-Only Image

`Dockerfile.frontend` runs the built TanStack application and expects Convex to
be deployed separately.

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
bun run vite:build
bun run vite:start
```

The production server reads `.output/server/index.mjs` and defaults to port
`3000` unless `PORT` is set.

## Releases

`package.json` is the version source of truth. The release workflow accepts a
matching `v<version>` tag, a `releases/<version>` or `releases/v<version>`
branch, or a manual workflow version.

It publishes:

- `ghcr.io/alkalines/radium:<version>` and `latest` from `Dockerfile`
- `ghcr.io/alkalines/radium-frontend:<version>` and `latest` from
  `Dockerfile.frontend`

It also creates a GitHub release with generated notes. A release fails when
the requested version does not match `package.json`.
