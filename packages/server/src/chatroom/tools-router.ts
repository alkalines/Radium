import { z } from "zod";
import { chatWorkerToolValidator } from "contracts/worker/chat-config";
import {
  ownedWorkspaceProcedure,
  router,
  sessionProcedure,
  workspaceProcedure,
} from "../trpc/init";
import {
  getChainOfThoughtEnabled,
  getChatTools,
  getModelDefault,
  getSystemPromptSettings,
  getTitleModelDefault,
  getToolDefaults,
  getWorkerToolDefaults,
  setChainOfThoughtEnabled,
  setChatTools,
  setModelDefault,
  setSystemPromptSettings,
  setTitleModelDefault,
  setToolDefaults,
  setWorkerToolDefaults,
} from "./settings";
import { systemPromptSettingsInput } from "./system-prompt";
import { toolSelectionInput } from "./tool-selection";
import {
  createMcpServer,
  createMcpServerInput,
  deleteExaApiKey,
  deleteMcpServer,
  exaApiKeyInput,
  getExaApiKey,
  listMcpServers,
  setExaApiKey,
  updateMcpServer,
  updateMcpServerInput,
} from "./tools";

const idInput = z.string().min(1).max(256);
const modelInput = z.object({ model: z.string().min(1).max(200).nullish() });

/** MCP servers and the Exa key (Convex `aisdk_tools.*`). Reads: members, except the Exa key. */
export const toolsRouter = router({
  listMcpServers: workspaceProcedure.query(({ ctx }) =>
    listMcpServers(ctx.runtime, ctx.access.workspace.id),
  ),
  createMcpServer: ownedWorkspaceProcedure
    .input(createMcpServerInput)
    .mutation(({ ctx, input }) => createMcpServer(ctx.runtime, ctx.access.workspace, input)),
  updateMcpServer: ownedWorkspaceProcedure
    .input(updateMcpServerInput)
    .mutation(({ ctx, input }) => updateMcpServer(ctx.runtime, ctx.access.workspace.id, input)),
  deleteMcpServer: ownedWorkspaceProcedure
    .input(z.object({ server: idInput }))
    .mutation(({ ctx, input }) =>
      deleteMcpServer(ctx.runtime, ctx.access.workspace.id, input.server),
    ),
  getExaApiKey: ownedWorkspaceProcedure.query(({ ctx }) =>
    getExaApiKey(ctx.runtime, ctx.access.workspace.id),
  ),
  setExaApiKey: ownedWorkspaceProcedure
    .input(exaApiKeyInput)
    .mutation(({ ctx, input }) =>
      setExaApiKey(ctx.runtime, ctx.access.workspace.id, input.apiKey),
    ),
  deleteExaApiKey: ownedWorkspaceProcedure.mutation(({ ctx }) =>
    deleteExaApiKey(ctx.runtime, ctx.access.workspace.id),
  ),
});

/** Workspace Chatroom settings and chat tool overrides (Convex `chatroom.*`, minus Phase 4). */
export const chatroomSettingsRouter = router({
  getToolDefaults: workspaceProcedure.query(({ ctx }) =>
    getToolDefaults(ctx.runtime.drivers.db, ctx.access.workspace.id),
  ),
  setToolDefaults: ownedWorkspaceProcedure
    .input(z.object({ selection: toolSelectionInput }))
    .mutation(({ ctx, input }) =>
      setToolDefaults(ctx.runtime.drivers.db, ctx.access.workspace.id, input.selection),
    ),
  getWorkerToolDefaults: workspaceProcedure.query(({ ctx }) =>
    getWorkerToolDefaults(ctx.runtime.drivers.db, ctx.access.workspace.id),
  ),
  setWorkerToolDefaults: ownedWorkspaceProcedure
    .input(z.object({ tools: z.array(chatWorkerToolValidator).max(32) }))
    .mutation(({ ctx, input }) =>
      setWorkerToolDefaults(ctx.runtime.drivers.db, ctx.access.workspace.id, input.tools),
    ),
  getModelDefault: workspaceProcedure.query(({ ctx }) =>
    getModelDefault(ctx.runtime.drivers.db, ctx.access.workspace.id),
  ),
  setModelDefault: ownedWorkspaceProcedure
    .input(modelInput)
    .mutation(({ ctx, input }) =>
      setModelDefault(ctx.runtime.drivers.db, ctx.access.workspace.id, input.model ?? null),
    ),
  getTitleModelDefault: workspaceProcedure.query(({ ctx }) =>
    getTitleModelDefault(ctx.runtime.drivers.db, ctx.access.workspace.id),
  ),
  setTitleModelDefault: ownedWorkspaceProcedure
    .input(modelInput)
    .mutation(({ ctx, input }) =>
      setTitleModelDefault(ctx.runtime.drivers.db, ctx.access.workspace.id, input.model ?? null),
    ),
  getChainOfThoughtEnabled: workspaceProcedure.query(({ ctx }) =>
    getChainOfThoughtEnabled(ctx.runtime.drivers.db, ctx.access.workspace.id),
  ),
  setChainOfThoughtEnabled: ownedWorkspaceProcedure
    .input(z.object({ enabled: z.boolean() }))
    .mutation(({ ctx, input }) =>
      setChainOfThoughtEnabled(ctx.runtime.drivers.db, ctx.access.workspace.id, input.enabled),
    ),
  getSystemPromptSettings: workspaceProcedure.query(({ ctx }) =>
    getSystemPromptSettings(ctx.runtime.drivers.db, ctx.access.workspace.id),
  ),
  setSystemPromptSettings: ownedWorkspaceProcedure
    .input(systemPromptSettingsInput)
    .mutation(({ ctx, input }) =>
      setSystemPromptSettings(ctx.runtime.drivers.db, ctx.access.workspace.id, input),
    ),
  getChatTools: sessionProcedure
    .input(z.object({ chatId: idInput }))
    .query(({ ctx, input }) =>
      getChatTools(ctx.runtime.drivers.db, ctx.user.id, input.chatId),
    ),
  setChatTools: sessionProcedure
    .input(z.object({ chatId: idInput, selection: toolSelectionInput }))
    .mutation(({ ctx, input }) =>
      setChatTools(ctx.runtime.drivers.db, ctx.user.id, input.chatId, input.selection),
    ),
});
