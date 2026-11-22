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
} from "contracts/acp/contract";
import { applySessionPatch, enqueue, enqueueSigned, findAgent, findSession, relayFrozen } from "./policy";
import { verifySignedCommand, workspaceHasKeys } from "./sealed";
import { legacyPlaintextAllowed } from "../e2ee/migration-contract";
import { deleteRelayRow } from "../e2ee/migration-relay";
import type { AcpSignedCommand } from "contracts/acp/contract";
import { deferredCleanupKey, resumeDeferredCleanupReference } from "./deferred-contract";

const BATCH = 32;

type ParkedCleanup =
  | { kind: "clearColdChat"; chat: Id<"aisdk_chats">; epoch: number; cutoff: number }
  | { kind: "deleteStream"; chat: Id<"aisdk_chats">; epoch: number };

/**
 * One-shot cleanups (a cooled epoch's frames, a superseded stream) must not delete legacy relay frames
 * while the cutover is frozen, because the seal run has to capture them first, and must not be lost.
 * While frozen the operation is parked in the `acp_deferred_cleanups` journal (identifiers only, one
 * entry per kind, chat and epoch; the first cutoff wins, which is the more conservative) and nothing is
 * scheduled, so a long freeze costs no background work. `resumeDeferredCleanup` re-runs the parked
 * operations when the freeze lifts. Returns whether the caller must stop.
 */
async function parkWhileFrozen(ctx: MutationCtx, cleanup: ParkedCleanup): Promise<boolean> {
  if (!(await relayFrozen(ctx))) return false;
  const key = deferredCleanupKey(cleanup.kind, cleanup.chat, cleanup.epoch);
  const parked = await ctx.db
    .query("acp_deferred_cleanups")
    .withIndex("by_key", (q) => q.eq("key", key))
    .first();
  if (!parked) await ctx.db.insert("acp_deferred_cleanups", { ...cleanup, key });
  return true;
}

/**
 * Cutover unfreeze hook (`resumeDeferredCleanupReference`, scheduled by `setFrozen(false)` and
 * `finishCutover`): moves parked cleanups back into scheduled work, removing each journal entry in the
 * same transaction that schedules it, in bounded batches. Frozen again, it changes nothing, so entries
 * wait for the next unfreeze; a resumed operation that meets a new freeze parks itself again.
 */
export const resumeDeferredCleanup = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    if (await relayFrozen(ctx)) return null;
    const parked = await ctx.db.query("acp_deferred_cleanups").take(BATCH);
    for (const entry of parked) {
      await ctx.db.delete(entry._id);
      if (entry.kind === "clearColdChat")
        await ctx.scheduler.runAfter(0, internal.acp.clearColdChat, {
          chat: entry.chat,
          epoch: entry.epoch,
          cutoff: entry.cutoff,
        });
      else await ctx.scheduler.runAfter(0, internal.acp.deleteStream, { chat: entry.chat, epoch: entry.epoch });
    }
    if (parked.length === BATCH) await ctx.scheduler.runAfter(0, resumeDeferredCleanupReference, {});
    return null;
  },
});

/** Delete one superseded epoch in bounded batches, leaving any newer stream untouched. */
export const deleteStream = internalMutation({
  args: { chat: v.id("aisdk_chats"), epoch: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    // Frames of a superseded epoch may still be unsealed legacy history; park until the freeze lifts.
    if (await parkWhileFrozen(ctx, { kind: "deleteStream", chat: args.chat, epoch: args.epoch })) return null;
    const frames = await ctx.db
      .query("chat_frames")
      .withIndex("by_chat_and_stream_and_seqFrom", (q) =>
        q.eq("chat", args.chat).eq("stream", acpStream(args.epoch)),
      )
      .take(BATCH);
    for (const row of frames) await deleteRelayRow(ctx, "chat_frames", row);
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

/**
 * Cooling cleanup captures the epoch and heartbeat cutoff so a concurrent re-warm is safe: the
 * session's `cooledEpoch` fence keeps the Worker from writing to a cleared epoch again, so a
 * re-warm always opens a newer epoch with a fresh snapshot that this cleanup never touches.
 */
export const clearColdChat = internalMutation({
  args: { chat: v.id("aisdk_chats"), epoch: v.number(), cutoff: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (await parkWhileFrozen(ctx, { kind: "clearColdChat", chat: args.chat, epoch: args.epoch, cutoff: args.cutoff }))
      return null;
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
      for (const row of frames) await deleteRelayRow(ctx, "chat_frames", row);
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
    // Cooling flips sessions and queues frame cleanup, which would race the seal run. The minute
    // cron starts a fresh sweep after the freeze, so skipped pages are not lost.
    if (await relayFrozen(ctx)) return null;
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
      await ctx.db.patch(session._id, {
        warm: false,
        cooledEpoch: session.epoch,
        updatedAt: Date.now(),
      });
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
    // The recurring cron resumes the sweep after the freeze; nothing is queued for it.
    if (await relayFrozen(ctx)) return null;
    let more = false;
    for (const status of ["done", "failed"] as const) {
      const rows = await ctx.db
        .query("acp_commands")
        .withIndex("by_status_and_finishedAt", (q) =>
          q.eq("status", status).lt("finishedAt", Date.now() - ACP_COMMAND_RETENTION_MS),
        )
        .take(BATCH);
      for (const row of rows) await deleteRelayRow(ctx, "acp_commands", row);
      if (rows.length === BATCH) more = true;
    }
    const pending = await ctx.db
      .query("acp_commands")
      .withIndex("by_status", (q) =>
        q.eq("status", "pending").lt("_creationTime", Date.now() - ACP_COMMAND_EXPIRY_MS),
      )
      .take(BATCH);
    for (const row of pending) {
      await deleteRelayRow(ctx, "acp_commands", row);
      if ((row.kind === "prompt" || row.kind === "fork") && row.chat) {
        // A signed fork has no readable payload; its receipt names the target chat.
        const target =
          row.kind === "fork"
            ? ctx.db.normalizeId(
                "aisdk_chats",
                row.payload?.kind === "fork" ? row.payload.targetChat : (row.result ?? ""),
              )
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
      for (const row of rows) await deleteRelayRow(ctx, "acp_interactions", row);
      if (rows.length === BATCH) more = true;
    }
    if (more) await ctx.scheduler.runAfter(0, internal.acp.prune, {});
    return null;
  },
});

/**
 * Queue a binding-only command before deleting a chat; no transcript survives deletion. In a keyed
 * workspace the command must be the caller's signed `close`/`delete` (`signed`, statement chat =
 * this chat), stored with the chat's binding snapshot so the Worker can authorize it after the chat
 * is gone; without one (or for a chat that never got a binding) nothing is queued, since a paired
 * Worker ignores unsigned commands anyway.
 */
export async function queueChatDeletion(
  ctx: MutationCtx,
  chat: {
    _id: Id<"aisdk_chats">;
    userId: string;
    e2eeId?: string;
    workspace?: Id<"workspaces">;
    agent?: {
      worker: string;
      agentId: string;
      sessionId?: string;
      cwd: string;
      profile?: "native" | "gateway";
    };
  },
  by: string,
  deleteInAgent?: boolean,
  signed?: AcpSignedCommand,
) {
  if (!chat.agent || !chat.workspace) return;
  const session = await findSession(ctx, chat._id);
  const sessionId = chat.agent.sessionId ?? session?.sessionId;
  if (sessionId) {
    const agent = await findAgent(ctx, chat.workspace, chat.agent.worker, chat.agent.agentId);
    const kind = deleteInAgent && agent?.capabilities.delete ? "delete" : "close";
    const indexed = await ctx.db
      .query("acp_agent_sessions")
      .withIndex("by_worker_and_agentId_and_sessionId", (q) =>
        q
          .eq("workspace", chat.workspace!)
          .eq("worker", chat.agent!.worker)
          .eq("agentId", chat.agent!.agentId)
          .eq("sessionId", sessionId),
      )
      .first();
    if (indexed) {
      if (kind === "delete") await deleteRelayRow(ctx, "acp_agent_sessions", indexed);
      else await ctx.db.patch(indexed._id, { chat: undefined });
    }
    const binding = { workspace: chat.workspace, worker: chat.agent.worker };
    const profile = chat.agent.profile ?? session?.profile ?? "native";
    if (await workspaceHasKeys(ctx, chat.workspace)) {
      if (signed && session?.binding && session.sessionProof && chat.e2eeId) {
        await verifySignedCommand(ctx, { ...binding, chat: chat._id, kind, userId: by, signed });
        await enqueueSigned(ctx, binding, by, {
          kind,
          signed,
          agentId: chat.agent.agentId,
          target: {
            chat: chat._id,
            e2eeId: chat.e2eeId,
            creatorUserId: chat.userId,
            agentId: chat.agent.agentId,
            profile,
            cwd: chat.agent.cwd,
            sessionId,
            binding: session.binding,
            sessionProof: session.sessionProof,
          },
        });
      }
    } else if (await legacyPlaintextAllowed(ctx)) {
      await enqueue(ctx, binding, by, {
        kind,
        agentId: chat.agent.agentId,
        profile,
        cwd: chat.agent.cwd,
        sessionId,
      });
    }
  }
  await ctx.scheduler.runAfter(0, internal.acp.cleanupChat, { chatId: chat._id });
}

/**
 * Remove ACP metadata and transient content after an authorized chat deletion, in fixed batches.
 * Deliberately not deferred by the cutover freeze, unlike the other cleanups: the user deleted the
 * chat, so its remains are not history to preserve (sealing them would only create orphan custody),
 * and a queued deletion is a privacy request that must not wait behind the migration.
 */
export const cleanupChat = internalMutation({
  args: { chatId: v.id("aisdk_chats") },
  returns: v.null(),
  handler: async (ctx, { chatId }) => {
    let more = false;
    const indexed = await ctx.db
      .query("acp_agent_sessions")
      .withIndex("by_chat", (q) => q.eq("chat", chatId))
      .take(BATCH);
    for (const row of indexed) await ctx.db.patch(row._id, { chat: undefined });
    if (indexed.length === BATCH) more = true;
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
    for (const row of sessions) await deleteRelayRow(ctx, "acp_sessions", row);
    for (const row of frames) await deleteRelayRow(ctx, "chat_frames", row);
    for (const row of commands) await deleteRelayRow(ctx, "acp_commands", row);
    for (const row of interactions) await deleteRelayRow(ctx, "acp_interactions", row);
    for (const row of streams) await ctx.db.delete(row._id);
    for (const row of viewers) await ctx.db.delete(row._id);
    for (const rows of [sessions, streams, frames, viewers, commands, interactions]) {
      if (rows.length === BATCH) more = true;
    }
    if (more) await ctx.scheduler.runAfter(0, internal.acp.cleanupChat, { chatId });
    return null;
  },
});
