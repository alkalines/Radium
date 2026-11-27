import { defineConfig } from "nitro";

export default defineConfig({
  // Bun is the reference self-host runtime; `build:node` overrides this with `--preset node_server`.
  preset: "bun",
  serverEntry: "./server.ts",
  features: { websocket: true },
  // The Bun adapter (`src/ports/bun.ts`) imports `bun`. Node builds keep that import unresolved:
  // the adapter is only loaded when the process actually runs on Bun.
  builtinModules: ["bun"],
  // File routes win over the server entry's catch-all, so the socket route is served by crossws
  // and every other path reaches Hono.
  routes: {
    "/api/ws": "./src/http/ws.ts",
  },
  plugins: ["./src/http/lifecycle.ts"],
});
