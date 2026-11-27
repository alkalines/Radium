import { eq } from "drizzle-orm";
import { z } from "zod";
import { deferWorkspaceEvent, publishChatEvent, publishEvent, userEvents } from "../streams/events";
import { sealedBoxInput } from "../chatroom/sealing";
import { ownedWorkspaceProcedure, router, sessionProcedure, workerProcedure } from "../trpc/init";
import {
  agentDefinitionInput,
  deleteAgentDefinition,
  listAgentDefinitions,
  registryAgents,
  saveAgentDefinition,
  workerAgentDefinitions,
} from "./agents";
import {
  agentCommand,
  agentCommandInput,
  answer,
  answerInput,
  cancel,
  cancelInput,
  createSession,
  createSessionInput,
  fork,
  forkInput,
  generateTitle,
  getCommand,
  getSession,
  listAgents,
  listAgentSessionIndex,
  listUnopenedAgentSessions,
  openAgentSession,
  openAgentSessionInput,
  openInteractions,
  prompt,
  promptInput,
  publishBinding,
  publishBindingInput,
  requestHistory,
  requestHistoryInput,
  sendSessionChoice,
  sessionCursorInput,
  setFallbackTitle,
  signedChatCommandInput,
  startFork,
  startForkInput,
  syncAgentSessions,
  syncAgentSessionsInput,
  workerStatus,
} from "./browser";
import {
  answeredInteractions,
  assignedCommands,
  chatKey,
  claimCommand,
  finishCommand,
  finishCommandInput,
  knownAgentSessions,
  openInteraction,
  openInteractionInput,
  recoverWorker,
  reopenInteraction,
  reportAgents,
  reportAgentsInput,
  resolveInteraction,
  startEpoch,
  startEpochInput,
  syncAgentSessions as syncWorkerAgentSessions,
  syncAgentSessionsInput as syncWorkerAgentSessionsInput,
  updateSession,
  updateSessionInput,
  warmSessions,
} from "./machine";
import { watch, watchInput } from "./live";
import { acpCommands, acpInteractions } from "./schema";

const idInput = z.string().min(1).max(256);
const chatInput = z.object({ chat: idInput });
const pageInput = {
  cursor: sessionCursorInput.nullish(),
  limit: z.number().int().min(1).max(100).default(30),
};

/** Browser ACP (Convex `api.acp.*`): agent definitions, sessions, commands, interactions. */
export const acpRouter = router({
  listAgents: ownedWorkspaceProcedure
    .input(z.object({ worker: idInput.optional() }))
    .query(({ ctx, input }) => listAgents(ctx.runtime.drivers.db, ctx.access, input)),
  listAgentDefinitions: ownedWorkspaceProcedure.query(({ ctx }) =>
    listAgentDefinitions(ctx.runtime.drivers.db, ctx.access.workspace.id),
  ),
  saveAgentDefinition: ownedWorkspaceProcedure
    .input(z.object({ id: idInput.optional(), definition: agentDefinitionInput }))
    .mutation(({ ctx, input }) =>
      saveAgentDefinition(ctx.runtime.drivers.db, ctx.access.workspace, input),
    ),
  deleteAgentDefinition: ownedWorkspaceProcedure
    .input(z.object({ id: idInput }))
    .mutation(async ({ ctx, input }) => {
      await deleteAgentDefinition(ctx.runtime.drivers.db, ctx.access.workspace.id, input.id);
      return null;
    }),
  registryAgents: ownedWorkspaceProcedure.query(({ ctx }) => registryAgents(ctx.runtime.fetch)),
  createSession: ownedWorkspaceProcedure
    .input(createSessionInput)
    .mutation(({ ctx, input }) => createSession(ctx.runtime, ctx.access, ctx.user.id, input)),
  openAgentSession: ownedWorkspaceProcedure
    .input(openAgentSessionInput)
    .mutation(({ ctx, input }) => openAgentSession(ctx.runtime, ctx.access, ctx.user.id, input)),
  listAgentSessionIndex: ownedWorkspaceProcedure
    .input(z.object({ agentId: z.string().max(64), ...pageInput }))
    .query(({ ctx, input }) =>
      listAgentSessionIndex(ctx.runtime.drivers.db, ctx.access, ctx.user.id, input),
    ),
  listUnopenedAgentSessions: ownedWorkspaceProcedure
    .input(z.object({ project: idInput.nullable().optional(), ...pageInput }))
    .query(({ ctx, input }) => listUnopenedAgentSessions(ctx.runtime.drivers.db, ctx.access, input)),
  syncAgentSessions: ownedWorkspaceProcedure
    .input(syncAgentSessionsInput)
    .mutation(({ ctx, input }) => syncAgentSessions(ctx.runtime, ctx.access, ctx.user.id, input)),
  authenticate: ownedWorkspaceProcedure
    .input(agentCommandInput.extend({ methodId: z.string().max(256) }))
    .mutation(({ ctx, input }) =>
      agentCommand(ctx.runtime.drivers.db, ctx.access, ctx.user.id, "authenticate", input),
    ),
  logout: ownedWorkspaceProcedure
    .input(agentCommandInput)
    .mutation(({ ctx, input }) =>
      agentCommand(ctx.runtime.drivers.db, ctx.access, ctx.user.id, "logout", input),
    ),
  publishBinding: sessionProcedure
    .input(publishBindingInput)
    .mutation(({ ctx, input }) => publishBinding(ctx.runtime.drivers.db, ctx.user.id, input)),
  prompt: sessionProcedure
    .input(promptInput)
    .mutation(({ ctx, input }) => prompt(ctx.runtime, ctx.user.id, input)),
  cancel: sessionProcedure
    .input(cancelInput)
    .mutation(({ ctx, input }) => cancel(ctx.runtime.drivers.db, ctx.user.id, input)),
  setConfig: sessionProcedure
    .input(signedChatCommandInput)
    .mutation(({ ctx, input }) =>
      sendSessionChoice(ctx.runtime.drivers.db, ctx.user.id, "set_config", input),
    ),
  setMode: sessionProcedure
    .input(signedChatCommandInput)
    .mutation(({ ctx, input }) =>
      sendSessionChoice(ctx.runtime.drivers.db, ctx.user.id, "set_mode", input),
    ),
  answer: sessionProcedure
    .input(answerInput)
    .mutation(({ ctx, input }) => answer(ctx.runtime.drivers.db, ctx.user.id, input)),
  requestHistory: sessionProcedure
    .input(requestHistoryInput)
    .mutation(({ ctx, input }) => requestHistory(ctx.runtime, ctx.user.id, input)),
  fork: sessionProcedure
    .input(forkInput)
    .mutation(({ ctx, input }) => fork(ctx.runtime, ctx.user.id, input)),
  startFork: sessionProcedure
    .input(startForkInput)
    .mutation(({ ctx, input }) => startFork(ctx.runtime.drivers.db, ctx.user.id, input)),
  setFallbackTitle: sessionProcedure
    .input(chatInput.extend({ sealedTitle: sealedBoxInput }))
    .mutation(({ ctx, input }) => setFallbackTitle(ctx.runtime.drivers.db, ctx.user.id, input)),
  generateTitle: sessionProcedure
    .input(chatInput.extend({ text: z.string().max(8000) }))
    .mutation(({ ctx, input }) => generateTitle(ctx.runtime, ctx.user.id, input)),
  getSession: sessionProcedure
    .input(chatInput)
    .query(({ ctx, input }) => getSession(ctx.runtime, ctx.user.id, input.chat)),
  getCommand: sessionProcedure
    .input(z.object({ command: idInput }))
    .query(({ ctx, input }) => getCommand(ctx.runtime.drivers.db, ctx.user.id, input.command)),
  workerStatus: sessionProcedure
    .input(chatInput)
    .query(({ ctx, input }) => workerStatus(ctx.runtime, ctx.user.id, input.chat)),
  openInteractions: sessionProcedure
    .input(chatInput)
    .query(({ ctx, input }) => openInteractions(ctx.runtime.drivers.db, ctx.user.id, input.chat)),
  watch: sessionProcedure
    .input(watchInput)
    .mutation(({ ctx, input }) => watch(ctx.runtime, ctx.user.id, input)),
});

/**
 * A Worker's ACP mutation, announced after it succeeds: a change to a chat's session,
 * interactions or commands tells the chat's viewers (`acp`, ids = the chat); a command without a
 * chat (agent sign-in) tells its issuer; catalog and index reports tell the workspace owner.
 */
const machineMutation = workerProcedure.use(async ({ ctx, next, getRawInput }) => {
  const result = await next();
  if (!result.ok) return result;
  const raw = (await getRawInput()) as Record<string, unknown>;
  const { runtime } = ctx;
  const { db } = runtime.drivers;
  runtime.defer(
    (async () => {
      if (typeof raw.chat === "string") {
        await publishChatEvent(runtime, raw.chat, "acp");
      } else if (typeof raw.interaction === "string") {
        const [row] = await db
          .select({ chat: acpInteractions.chat })
          .from(acpInteractions)
          .where(eq(acpInteractions.id, raw.interaction));
        if (row) await publishChatEvent(runtime, row.chat, "acp");
      } else if (typeof raw.command === "string") {
        const [row] = await db
          .select({ chat: acpCommands.chat, issuedBy: acpCommands.issuedBy })
          .from(acpCommands)
          .where(eq(acpCommands.id, raw.command));
        if (row?.chat) await publishChatEvent(runtime, row.chat, "acp");
        else if (row?.issuedBy) await publishEvent(runtime, [userEvents(row.issuedBy)], { topic: "acp" });
      } else {
        deferWorkspaceEvent(runtime, ctx.worker.workspaceId, "acp");
      }
    })(),
  );
  return result;
});

/** The bound Worker's ACP (Convex `api.acp.*` machine functions); mounted as `worker.acp`. */
export const acpMachineRouter = router({
  agentDefinitions: workerProcedure.query(({ ctx }) =>
    workerAgentDefinitions(ctx.runtime.drivers.db, ctx.worker),
  ),
  assignedCommands: workerProcedure.query(({ ctx }) =>
    assignedCommands(ctx.runtime.drivers.db, ctx.worker),
  ),
  claimCommand: machineMutation
    .input(z.object({ command: idInput }))
    .mutation(({ ctx, input }) => claimCommand(ctx.runtime, ctx.worker, input.command)),
  finishCommand: machineMutation
    .input(finishCommandInput)
    .mutation(({ ctx, input }) => finishCommand(ctx.runtime.drivers.db, ctx.worker, input)),
  warmSessions: workerProcedure.query(({ ctx }) => warmSessions(ctx.runtime, ctx.worker)),
  answeredInteractions: workerProcedure.query(({ ctx }) =>
    answeredInteractions(ctx.runtime.drivers.db, ctx.worker),
  ),
  openInteraction: machineMutation
    .input(openInteractionInput)
    .mutation(({ ctx, input }) => openInteraction(ctx.runtime, ctx.worker, input)),
  resolveInteraction: machineMutation
    .input(z.object({ interaction: idInput, status: z.enum(["resolved", "cancelled"]) }))
    .mutation(({ ctx, input }) => resolveInteraction(ctx.runtime.drivers.db, ctx.worker, input)),
  reopenInteraction: machineMutation
    .input(z.object({ interaction: idInput }))
    .mutation(({ ctx, input }) =>
      reopenInteraction(ctx.runtime.drivers.db, ctx.worker, input.interaction),
    ),
  startEpoch: machineMutation
    .input(startEpochInput)
    .mutation(({ ctx, input }) => startEpoch(ctx.runtime, ctx.worker, input)),
  updateSession: machineMutation
    .input(updateSessionInput)
    .mutation(({ ctx, input }) => updateSession(ctx.runtime, ctx.worker, input)),
  chatKey: workerProcedure
    .input(chatInput)
    .query(({ ctx, input }) => chatKey(ctx.runtime.drivers.db, ctx.worker, input.chat)),
  reportAgents: machineMutation
    .input(reportAgentsInput)
    .mutation(({ ctx, input }) => reportAgents(ctx.runtime.drivers.db, ctx.worker, input.agents)),
  knownAgentSessions: workerProcedure
    .input(z.object({ agentId: z.string().max(64) }))
    .query(({ ctx, input }) =>
      knownAgentSessions(ctx.runtime.drivers.db, ctx.worker, input.agentId),
    ),
  syncAgentSessions: machineMutation
    .input(syncWorkerAgentSessionsInput)
    .mutation(({ ctx, input }) =>
      syncWorkerAgentSessions(ctx.runtime.drivers.db, ctx.worker, input),
    ),
  recoverWorker: workerProcedure.mutation(({ ctx }) => recoverWorker(ctx.runtime, ctx.worker)),
});
