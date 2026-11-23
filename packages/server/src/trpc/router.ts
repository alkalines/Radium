import { chatFilesRouter } from "../chatroom/files-router";
import { chatsRouter } from "../chatroom/router";
import { chatroomSettingsRouter, toolsRouter } from "../chatroom/tools-router";
import { authRouter } from "../auth/router";
import { e2eeRouter } from "../e2ee/router";
import { limitsRouter } from "../gateway/limits/router";
import { keysRouter, modelsRouter, providersRouter, routingRouter } from "../gateway/router";
import { preferencesRouter, projectsRouter, workspacesRouter } from "../workspaces/router";
import { router } from "./init";

/** Root router: one sub-router per domain. The web app imports only its type. */
export const appRouter = router({
  auth: authRouter,
  workspaces: workspacesRouter,
  projects: projectsRouter,
  preferences: preferencesRouter,
  providers: providersRouter,
  models: modelsRouter,
  keys: keysRouter,
  routing: routingRouter,
  limits: limitsRouter,
  tools: toolsRouter,
  chatroom: chatroomSettingsRouter,
  chatFiles: chatFilesRouter,
  chats: chatsRouter,
  e2ee: e2eeRouter,
});

export type AppRouter = typeof appRouter;
