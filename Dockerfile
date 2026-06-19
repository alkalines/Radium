# syntax=docker/dockerfile:1.7

FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM deps AS builder
ARG VITE_CONVEX_URL=http://localhost:3210
ARG VITE_CONVEX_SITE_URL=http://localhost:3211
ENV VITE_CONVEX_URL=$VITE_CONVEX_URL
ENV VITE_CONVEX_SITE_URL=$VITE_CONVEX_SITE_URL
COPY . .
RUN bun run vite:build

FROM ghcr.io/get-convex/convex-backend:latest AS convex-backend

FROM oven/bun:1 AS runner
WORKDIR /app
ARG VITE_CONVEX_URL=http://localhost:3210
ARG VITE_CONVEX_SITE_URL=http://localhost:3211
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates openssl \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
ENV PORT=3000
ENV CONVEX_SELF_HOSTED_URL=http://127.0.0.1:3210
ENV CONVEX_CLOUD_ORIGIN=$VITE_CONVEX_URL
ENV CONVEX_SITE_ORIGIN=$VITE_CONVEX_SITE_URL
ENV CONVEX_URL=$VITE_CONVEX_URL
ENV CONVEX_SITE_URL=$VITE_CONVEX_SITE_URL
ENV VITE_CONVEX_URL=$VITE_CONVEX_URL
ENV VITE_CONVEX_SITE_URL=$VITE_CONVEX_SITE_URL
ENV DO_NOT_REQUIRE_SSL=1

COPY --from=convex-backend /convex /convex
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/.output ./.output
COPY --from=builder /app/convex ./convex
COPY --from=builder /app/src/utils ./src/utils
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/tsconfig.json ./tsconfig.json
COPY docker/full-entrypoint.sh /usr/local/bin/radium-full-entrypoint

RUN chmod +x /usr/local/bin/radium-full-entrypoint /convex/*.sh /convex/convex-local-backend /convex/generate_key

VOLUME ["/convex/data"]
EXPOSE 3000 3210 3211
ENTRYPOINT ["radium-full-entrypoint"]
