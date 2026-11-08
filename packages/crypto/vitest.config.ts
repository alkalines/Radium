import { defineConfig } from "vitest/config";

// The same suite runs in Node and in the edge-runtime globals Convex functions resemble, so a
// primitive that only one runtime provides shows up as a failing project rather than a deploy error.
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
