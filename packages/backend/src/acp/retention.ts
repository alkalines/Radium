import { v } from "convex/values";
import { internalMutation, type MutationCtx } from "../../convex/_generated/server";
import { internal } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import {
  ACP_COLD_AFTER_MS,
  ACP_COMMAND_EXPIRY_MS,
  ACP_COMMAND_RETENTION_MS,
  ACP_INTERACTION_RETENTION_MS,
  acpStream,
} from "./contract";
import { applySessionPatch, enqueue, findAgent, findSession } from "./policy";

const BATCH = 32;

/** Delete one superseded epoch in bounded batches, leaving any newer stream untouched. */
export const deleteStream = internalMutation({
  args: { chat: v.id("aisdk_chats"), epoch: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const frames = await ctx.db
      .query("chat_frames")
      .withIndex("by_chat_and_stream_and_seqFrom", (q) =>
        q.eq("chat", args.chat).eq("stream", acpStream(args.epoch)),
      )
      .take(BATCH);
    for (const row of frames) await ctx.db.delete(row._id);
    if (frames.length === BATCH) await ctx.scheduler.runAfter(0, internal.acp.deleteStream, args);
    else {
      const streams = await ctx.db
        .query("acp_streams")
        .withIndex("by_chat_and_epoch", (q) => q.eq("chat", args.chat).eq("epoch", args.epoch))
        .take(BATCH);
      for (const row of streams) await ctx.db.delete(row._id);
    }
    return null;
  },
});

/** Cooling cleanup captures the epoch and heartbeat cutoff so a concurrent re-warm is safe. */
export const clearColdChat = internalMutation({
  args: { chat: v.id("aisdk_chats"), epoch: v.number(), cutoff: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    // One epoch per transaction caps frame reads even when many epochs accumulated offline.
    const streams = await ctx.db
      .query("acp_streams")
      .withIndex("by_chat_and_epoch", (q) => q.eq("chat", args.chat).lte("epoch", args.epoch))
      .take(1);
    let more = streams.length > 0;
    for (const stream of streams) {
      const frames = await ctx.db
        .query("chat_frames")
        .withIndex("by_chat_and_stream_and_seqFrom", (q) =>
          q.eq("chat", args.chat).eq("stream", acpStream(stream.epoch)),
        )
        .take(BATCH);
      for (const row of frames) await ctx.db.delete(row._id);
      if (frames.length === BATCH) more = true;
      else await ctx.db.delete(stream._id);
    }
    const viewers = await ctx.db
      .query("chat_viewers")
      .withIndex("by_chat_and_lastSeenAt", (q) =>
        q.eq("chat", args.chat).lte("lastSeenAt", args.cutoff),
      )
      .take(BATCH);
    for (const row of viewers) await ctx.db.delete(row._id);
    if (viewers.length === BATCH) more = true;
    if (more) await ctx.scheduler.runAfter(0, internal.acp.clearColdChat, args);
    return null;
  },
});

/** Minute sweep pages warm metadata and cools only after both warming and the last viewer expire. */
export const coolSessions = internalMutation({
  args: { cursor: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("acp_sessions")
      .withIndex("by_warm", (q) => q.eq("warm", true))
      .paginate({ cursor: args.cursor ?? null, numItems: BATCH });
    const cutoff = Date.now() - ACP_COLD_AFTER_MS;
    for (const session of page.page) {
      const newest = (
        await ctx.db
          .query("chat_viewers")
          .withIndex("by_chat_and_lastSeenAt", (q) => q.eq("chat", session.chat))
          .order("desc")
          .take(1)
      )[0];
      if (
        (session.warmSince ?? session.updatedAt) > cutoff ||
        (newest && newest.lastSeenAt > cutoff)
      )
        continue;
      await ctx.db.patch(session._id, { warm: false, updatedAt: Date.now() });
      await ctx.scheduler.runAfter(0, internal.acp.clearColdChat, {
        chat: session.chat,
        epoch: session.epoch,
        cutoff,
      });
    }
    if (!page.isDone)
      await ctx.scheduler.runAfter(0, internal.acp.coolSessions, { cursor: page.continueCursor });
    return null;
  },
});

/** Expire abandoned intent and prune terminal receipts; each indexed branch has a fixed budget. */
export const prune = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    let more = false;
    for (const status of ["done", "failed"] as const) {
      const rows = await ctx.db
        .query("acp_commands")
        .withIndex("by_status_and_finishedAt", (q) =>
          q.eq("status", status).lt("finishedAt", Date.now() - ACP_COMMAND_RETENTION_MS),
        )
        .take(BATCH);
      for (const row of rows) await ctx.db.delete(row._id);
      if (rows.length === BATCH) more = true;
    }
    const pending = await ctx.db
      .query("acp_commands")
      .withIndex("by_status", (q) =>
        q.eq("status", "pending").lt("_creationTime", Date.now() - ACP_COMMAND_EXPIRY_MS),
      )
      .take(BATCH);
    for (const row of pending) {
      await ctx.db.delete(row._id);
      if ((row.kind === "prompt" || row.kind === "fork") && row.chat) {
        const target =
          row.kind === "fork" && row.payload?.kind === "fork"
            ? ctx.db.normalizeId("aisdk_chats", row.payload.targetChat)
            : row.chat;
        const session = target ? await findSession(ctx, target) : null;
        if (session?.status === "starting") {
          if (await ctx.db.get(session.chat))
            await applySessionPatch(ctx, session, { status: "failed", error: "Command expired" });
        }
      }
    }
    if (pending.length === BATCH) more = true;
    for (const status of ["resolved", "cancelled"] as const) {
      const rows = await ctx.db
        .query("acp_interactions")
        .withIndex("by_status_and_resolvedAt", (q) =>
          q.eq("status", status).lt("resolvedAt", Date.now() - ACP_INTERACTION_RETENTION_MS),
        )
        .take(BATCH);
      for (const row of rows) await ctx.db.delete(row._id);
      if (rows.length === BATCH) more = true;
    }
    if (more) await ctx.scheduler.runAfter(0, internal.acp.prune, {});
    return null;
  },
});

/** Queue a binding-only command before deleting a chat; no transcript survives deletion. */
export async function queueChatDeletion(
  ctx: MutationCtx,
  chat: {
    _id: Id<"aisdk_chats">;
    workspace?: Id<"workspaces">;
    agent?: { worker: string; agentId: string; sessionId?: string; cwd: string };
  },
  by: string,
  deleteInAgent?: boolean,
) {
  if (!chat.agent || !chat.workspace) return;
  const session = await findSession(ctx, chat._id);
  const sessionId = chat.agent.sessionId ?? session?.sessionId;
  if (sessionId) {
    const agent = await findAgent(ctx, chat.workspace, chat.agent.worker, chat.agent.agentId);
    const kind = deleteInAgent && agent?.capabilities.delete ? "delete" : "close";
    await enqueue(ctx, { workspace: chat.workspace, worker: chat.agent.worker }, by, {
      kind,
      agentId: chat.agent.agentId,
      cwd: chat.agent.cwd,
      sessionId,
    });
  }
  await ctx.scheduler.runAfter(0, internal.acp.cleanupChat, { chatId: chat._id });
}

/** Remove ACP metadata and transient content after an authorized chat deletion, in fixed batches. */
export const cleanupChat = internalMutation({
  args: { chatId: v.id("aisdk_chats") },
  returns: v.null(),
  handler: async (ctx, { chatId }) => {
    let more = false;
    const sessions = await ctx.db
      .query("acp_sessions")
      .withIndex("by_chat", (q) => q.eq("chat", chatId))
      .take(BATCH);
    const streams = await ctx.db
      .query("acp_streams")
      .withIndex("by_chat_and_epoch", (q) => q.eq("chat", chatId))
      .take(BATCH);
    const frames = await ctx.db
      .query("chat_frames")
      .withIndex("by_chat", (q) => q.eq("chat", chatId))
      .take(BATCH);
    const viewers = await ctx.db
      .query("chat_viewers")
      .withIndex("by_chat_and_tab", (q) => q.eq("chat", chatId))
      .take(BATCH);
    const commands = await ctx.db
      .query("acp_commands")
      .withIndex("by_chat_and_status", (q) => q.eq("chat", chatId).eq("status", "pending"))
      .take(BATCH);
    const interactions = await ctx.db
      .query("acp_interactions")
      .withIndex("by_chat_and_status", (q) => q.eq("chat", chatId))
      .take(BATCH);
    for (const rows of [sessions, streams, frames, viewers, commands, interactions]) {
      for (const row of rows) await ctx.db.delete(row._id);
      if (rows.length === BATCH) more = true;
    }
    if (more) await ctx.scheduler.runAfter(0, internal.acp.cleanupChat, { chatId });
    return null;
  },
});
