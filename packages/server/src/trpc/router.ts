import { systemRouter } from "../system/router";
import { router } from "./init";

/**
 * The root router. Domains mount their routers here; every first-party client imports
 * `AppRouter` from `server/trpc` with `import type` only.
 */
export const appRouter = router({
  system: systemRouter,
});

export type AppRouter = typeof appRouter;
