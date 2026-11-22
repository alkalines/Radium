import { defineConfig } from "vitest/config";

// Contracts run in browsers, Bun and Convex functions, so the suite runs in Node and in the
// edge-runtime globals Convex functions resemble.
export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: { name: "node", environment: "node", include: ["src/**/*.test.ts"] },
      },
      {
        extends: true,
        test: { name: "edge-runtime", environment: "edge-runtime", include: ["src/**/*.test.ts"] },
      },
    ],
  },
});
