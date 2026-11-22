import { authRouter } from "../auth/router";
import { router } from "./init";

/** Root router: one sub-router per domain. The web app imports only its type. */
export const appRouter = router({
  auth: authRouter,
});

export type AppRouter = typeof appRouter;
