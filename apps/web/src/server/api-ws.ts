import { createWebSocketProxy } from "crossws";
import { defineWebSocketHandler } from "nitro";

import { serverOrigin } from "../lib/server-origin";

/**
 * `/api/ws`: relays the Tab's WebSocket to packages/server, so subscriptions use the page's origin
 * like every other `/api` call. TanStack Start routes cannot upgrade, so this is a Nitro route
 * (`nitro({ routes })` in `vite.config.mts`). It costs one extra hop per frame; a reverse proxy that
 * routes `/api/*` to the server directly skips it.
 */
export default defineWebSocketHandler(
  createWebSocketProxy({
    target: () => {
      const target = new URL("/api/ws", serverOrigin());
      target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
      return target;
    },
    // The proxy forwards no request headers by itself. The server authenticates the socket from the
    // session cookie and checks the browser's Origin against X-Forwarded-Host.
    headers: (peer) => {
      const incoming = peer.request.headers;
      const url = new URL(peer.request.url);
      const headers: Record<string, string> = {
        "x-forwarded-host": incoming.get("host") ?? url.host,
        "x-forwarded-proto": url.protocol === "https:" ? "https" : "http",
      };
      for (const name of ["origin", "cookie", "user-agent"]) {
        const value = incoming.get(name);
        if (value) headers[name] = value;
      }
      if (peer.remoteAddress) headers["x-forwarded-for"] = peer.remoteAddress;
      return headers;
    },
  }),
);
