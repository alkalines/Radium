import { createFileRoute } from "@tanstack/react-router";

import { proxyToServer } from "@/lib/server-proxy";

/**
 * Every `/api/*` HTTP request goes to packages/server (tRPC, health, later Gateway, chat streams and
 * files). More specific `/api/*` routes in this directory still win until their owners move.
 * WebSocket upgrades on `/api/ws` are relayed by the Nitro route `src/server/api-ws.ts`.
 */
export const Route = createFileRoute("/api/$")({
  server: {
    handlers: {
      GET: ({ request }) => proxyToServer(request),
      POST: ({ request }) => proxyToServer(request),
      PUT: ({ request }) => proxyToServer(request),
      PATCH: ({ request }) => proxyToServer(request),
      DELETE: ({ request }) => proxyToServer(request),
      HEAD: ({ request }) => proxyToServer(request),
      OPTIONS: ({ request }) => proxyToServer(request),
    },
  },
});
