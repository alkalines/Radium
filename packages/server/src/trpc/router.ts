import { authRouter } from "../auth/router";
import { preferencesRouter, projectsRouter, workspacesRouter } from "../workspaces/router";
import { router } from "./init";

/** Root router: one sub-router per domain. The web app imports only its type. */
export const appRouter = router({
  auth: authRouter,
  workspaces: workspacesRouter,
  projects: projectsRouter,
  preferences: preferencesRouter,
});

export type AppRouter = typeof appRouter;
