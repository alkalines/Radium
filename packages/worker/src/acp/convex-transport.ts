import type { ConvexClient } from "convex/browser";
import { api } from "backend/convex/_generated/api";
import type { Id } from "backend/convex/_generated/dataModel";
import type { AcpTransport } from "./transport.js";

/** Bind the runtime-neutral host boundary to machine-authorized Convex functions. */
export function convexAcpTransport(client: ConvexClient): AcpTransport {
  return {
    assignedCommands: (receive, failed) =>
      client.onUpdate(api.acp.assignedCommands, {}, receive, failed),
    warmSessions: (receive, failed) => client.onUpdate(api.acp.warmSessions, {}, receive, failed),
    answeredInteractions: (receive, failed) =>
      client.onUpdate(api.acp.answeredInteractions, {}, receive, failed),
    claimCommand: ({ command }) =>
      client.mutation(api.acp.claimCommand, { command: command as Id<"acp_commands"> }),
    finishCommand: ({ command, ...args }) =>
      client.mutation(api.acp.finishCommand, { ...args, command: command as Id<"acp_commands"> }),
    openInteraction: ({ chat, ...args }) =>
      client.mutation(api.acp.openInteraction, { ...args, chat: chat as Id<"aisdk_chats"> }),
    resolveInteraction: ({ interaction, ...args }) =>
      client.mutation(api.acp.resolveInteraction, {
        ...args,
        interaction: interaction as Id<"acp_interactions">,
      }),
    startEpoch: ({ chat, ...args }) =>
      client.mutation(api.acp.startEpoch, { ...args, chat: chat as Id<"aisdk_chats"> }),
    appendFrames: ({ chat, ...args }) =>
      client.mutation(api.acp.appendFrames, { ...args, chat: chat as Id<"aisdk_chats"> }),
    updateSession: ({ chat, ...args }) =>
      client.mutation(api.acp.updateSession, { ...args, chat: chat as Id<"aisdk_chats"> }),
    reportAgents: (args) => client.mutation(api.acp.reportAgents, args),
    recoverWorker: (args) => client.mutation(api.acp.recoverWorker, args),
  };
}
