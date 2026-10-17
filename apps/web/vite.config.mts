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
    nitro(),
  ],
  ssr: {
    noExternal: ["@convex-dev/better-auth"],
  },
});
