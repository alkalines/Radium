#!/usr/bin/env bash
set -euo pipefail

cleanup() {
  if [ -n "${CONVEX_PID:-}" ] && kill -0 "$CONVEX_PID" 2>/dev/null; then
    kill -INT "$CONVEX_PID"
    wait "$CONVEX_PID" || true
  fi
  if [ -n "${FRONTEND_PID:-}" ] && kill -0 "$FRONTEND_PID" 2>/dev/null; then
    kill -TERM "$FRONTEND_PID"
    wait "$FRONTEND_PID" || true
  fi
}
trap cleanup EXIT INT TERM

cd /convex
./run_backend.sh &
CONVEX_PID=$!

until bun --silent -e "await fetch(process.env.CONVEX_SELF_HOSTED_URL + '/version').then((response) => { if (!response.ok) process.exit(1) })"; do
  if ! kill -0 "$CONVEX_PID" 2>/dev/null; then
    wait "$CONVEX_PID"
  fi
  sleep 1
done

export CONVEX_SELF_HOSTED_ADMIN_KEY="${CONVEX_SELF_HOSTED_ADMIN_KEY:-$(./generate_admin_key.sh)}"

: "${SECRET_STORE_KEYS:?SECRET_STORE_KEYS is required for the Convex secretStore component}"

cd /app
for name in SECRET_STORE_KEYS SITE_URL Openrouter_API_Key AISDK_MaxRetries; do
  value="${!name:-}"
  if [ -n "$value" ]; then
    bunx convex env set "$name" "$value"
  fi
done

for name in OTEL_EXPORTER_OTLP_ENDPOINT OTEL_EXPORTER_OTLP_TRACES_ENDPOINT OTEL_EXPORTER_OTLP_HEADERS OTEL_EXPORTER_OTLP_TRACES_HEADERS OTEL_SERVICE_NAME; do
  value="${!name:-}"
  if [ -n "$value" ]; then
    bunx convex env set "$name" "$value"
  else
    bunx convex env remove "$name" >/dev/null 2>&1 || true
  fi
done

bunx convex deploy --typecheck disable --codegen disable --message "Container startup deploy"

bun .output/server/index.mjs &
FRONTEND_PID=$!

wait -n "$CONVEX_PID" "$FRONTEND_PID"
