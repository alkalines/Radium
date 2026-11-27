import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { nitro } from "nitro/vite";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  server: {
    port: 3000,
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  plugins: [
    tailwindcss(),
    tanstackStart({
      srcDirectory: "src",
      router: {
        routesDirectory: "app",
      },
    }),
    viteReact(),
    // `/api/*` HTTP is forwarded by the TanStack Start route `src/app/api/$.ts`. Route handlers
    // cannot upgrade, so the WebSocket relay is a Nitro route.
    nitro({
      // Every start script and image runs the output on Bun. With WebSockets enabled the default
      // node_server preset loads crossws's Node adapter, which refuses to run on Bun.
      preset: "bun",
      features: { websocket: true },
      routes: { "/api/ws": "./src/server/api-ws.ts" },
    }),
  ],
  ssr: {
    noExternal: ["@convex-dev/better-auth"],
  },
});
