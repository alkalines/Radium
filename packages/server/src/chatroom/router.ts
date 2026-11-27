import { z } from "zod";
import { codeModeInteractionResponseValidator } from "contracts/chatroom/code-mode";
import { chatWorkerToolValidator } from "contracts/worker/chat-config";
import { router, sessionProcedure, workspaceProcedure } from "../trpc/init";
import {
  chatCursorInput,
  chatWorkerGrantInput,
  createChat,
  createChatInput,
  deleteChat,
  deleteChatInput,
  forkChat,
  forkChatInput,
  getChat,
  getChatMessages,
  listChats,
  listPinnedChats,
  MAX_CHAT_PAGE,
  regenerateChatTitle,
  renameChat,
  setChatPinned,
  setChatProject,
  setChatScope,
  setChatScopeInput,
  setChatWorker,
  setChatWorkerGrant,
} from "./chats";
import { answerInteraction } from "./code-mode";
import { stopRun } from "./run";
import { sealedBoxInput } from "./sealing";

const idInput = z.string().min(1).max(256);
const chatInput = z.object({ chatId: idInput });
const projectFilterInput = idInput.nullable().optional();

/** Convex `aisdk.*` (chats) and `code_mode.answerInteraction`. */
export const chatsRouter = router({
  create: workspaceProcedure
    .input(createChatInput)
    .mutation(({ ctx, input }) => createChat(ctx.runtime, ctx.access, ctx.user.id, input)),
  fork: workspaceProcedure
    .input(forkChatInput)
    .mutation(({ ctx, input }) => forkChat(ctx.runtime, ctx.access, ctx.user.id, input)),
  get: sessionProcedure
    .input(chatInput)
    .query(({ ctx, input }) => getChat(ctx.runtime.drivers.db, ctx.user.id, input.chatId)),
  messages: sessionProcedure
    .input(chatInput)
    .query(({ ctx, input }) => getChatMessages(ctx.runtime.drivers.db, ctx.user.id, input.chatId)),
  list: workspaceProcedure
    .input(
      z.object({
        project: projectFilterInput,
        cursor: chatCursorInput.nullish(),
        limit: z.number().int().min(1).max(MAX_CHAT_PAGE).default(30),
      }),
    )
    .query(({ ctx, input }) => listChats(ctx.runtime.drivers.db, ctx.access, ctx.user.id, input)),
  listPinned: workspaceProcedure
    .input(z.object({ project: projectFilterInput }))
    .query(({ ctx, input }) =>
      listPinnedChats(ctx.runtime.drivers.db, ctx.access, ctx.user.id, input),
    ),
  rename: sessionProcedure
    .input(chatInput.extend({ sealedTitle: sealedBoxInput }))
    .mutation(({ ctx, input }) => renameChat(ctx.runtime.drivers.db, ctx.user.id, input)),
  setPinned: sessionProcedure
    .input(chatInput.extend({ pinned: z.boolean() }))
    .mutation(({ ctx, input }) => setChatPinned(ctx.runtime.drivers.db, ctx.user.id, input)),
  setProject: sessionProcedure
    .input(chatInput.extend({ project: idInput.nullable() }))
    .mutation(({ ctx, input }) =>
      setChatProject(ctx.runtime.drivers.db, ctx.runtime.drivers.kv, ctx.user.id, input),
    ),
  setScope: sessionProcedure
    .input(setChatScopeInput)
    .mutation(({ ctx, input }) => setChatScope(ctx.runtime.drivers.db, ctx.user.id, input)),
  setWorker: sessionProcedure
    .input(
      chatInput.extend({
        selection: z
          .object({ workerId: idInput.optional(), tools: z.array(chatWorkerToolValidator).max(8) })
          .nullable(),
      }),
    )
    .mutation(({ ctx, input }) =>
      setChatWorker(ctx.runtime.drivers.db, ctx.runtime.drivers.kv, ctx.user.id, input),
    ),
  setWorkerGrant: sessionProcedure
    .input(
      chatInput.extend({
        workerId: idInput,
        directory: z.string().max(4096),
        grant: chatWorkerGrantInput,
      }),
    )
    .mutation(({ ctx, input }) => setChatWorkerGrant(ctx.runtime.drivers.db, ctx.user.id, input)),
  regenerateTitle: sessionProcedure
    .input(chatInput.extend({ prompt: z.string().max(8000) }))
    .mutation(({ ctx, input }) => regenerateChatTitle(ctx.runtime, ctx.user.id, input)),
  delete: sessionProcedure
    .input(deleteChatInput)
    .mutation(({ ctx, input }) => deleteChat(ctx.runtime, ctx.user.id, input)),
  /** Stops the chat's running reply from any Tab or device (its sender or a chat manager). */
  stop: sessionProcedure
    .input(chatInput)
    .mutation(({ ctx, input }) => stopRun(ctx.runtime, ctx.user.id, input.chatId)),
  answerInteraction: sessionProcedure
    .input(z.object({ interaction: z.uuid(), response: codeModeInteractionResponseValidator }))
    .mutation(({ ctx, input }) => answerInteraction(ctx.runtime, ctx.user.id, input)),
});
