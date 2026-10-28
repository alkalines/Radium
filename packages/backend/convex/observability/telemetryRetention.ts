import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, mutation, type MutationCtx } from "../_generated/server";
import { isChatVisibleToWorkspace } from "../chatroom";
import { requireOwnedWorkspace } from "../workspaces";

const DAY_MS = 86_400_000;
/** Requests deleted per mutation; each one enqueues up to ~11 GC rows. */
const REQUEST_BATCH = 50;
const SESSION_BATCH = 25;
const SETTINGS_PAGE = 5;
/** GC rows processed per `collectGarbage` run; each row costs a handful of index reads. */
const GC_BATCH = 100;

/** Queue reference checks for everything a request pointed at, then delete the request. */
async function deleteRequestRow(ctx: MutationCtx, request: Doc<"telemetry_requests">) {
  const blobs = new Set<Id<"telemetry_blobs">>();
  for (const blob of [
    request.system,
    request.toolset,
    request.params,
    request.headers,
    request.legacy?.input,
    request.legacy?.output,
    request.legacy?.spans,
  ]) {
    if (blob) blobs.add(blob);
  }
  for (const blob of blobs) {
    await ctx.db.insert("telemetry_gc", { workspace: request.workspace, blob });
  }
  for (const node of new Set([request.input, request.output])) {
    if (node) await ctx.db.insert("telemetry_gc", { workspace: request.workspace, node });
  }
  await ctx.db.delete("telemetry_requests", request._id);
}

async function scheduleCollectGarbage(ctx: MutationCtx) {
  await ctx.scheduler.runAfter(0, internal.observability.telemetryRetention.collectGarbage, {});
}

/** Owner-only. Hidden-chat requests are indistinguishable from missing ones. */
export const deleteRequest = mutation({
  args: { request: v.id("telemetry_requests") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const request = await ctx.db.get("telemetry_requests", args.request);
    if (!request) throw new Error("Request not found.");
    await requireOwnedWorkspace(ctx, request.workspace);
    if (
      request.chatId &&
      !(await isChatVisibleToWorkspace(ctx, request.workspace, request.chatId))
    ) {
      throw new Error("Request not found.");
    }

    await deleteRequestRow(ctx, request);
    await scheduleCollectGarbage(ctx);
    return null;
  },
});

/**
 * Delete one page of a session's requests. Only requests without a chat or in the session's own
 * (already authorized) chat are removed, so continuations never need the caller's identity.
 */
async function deleteSessionPage(
  ctx: MutationCtx,
  session: Doc<"telemetry_sessions">,
  cursor: string | null,
) {
  const page = await ctx.db
    .query("telemetry_requests")
    .withIndex("by_session_and_startedAt", (q) => q.eq("session", session._id))
    .paginate({ numItems: REQUEST_BATCH, cursor });

  for (const request of page.page) {
    if (request.chatId && request.chatId !== session.chatId) continue;
    await deleteRequestRow(ctx, request);
  }

  if (!page.isDone) {
    await ctx.scheduler.runAfter(0, internal.observability.telemetryRetention.deleteSessionPages, {
      session: session._id,
      cursor: page.continueCursor,
    });
  } else {
    const remaining = await ctx.db
      .query("telemetry_requests")
      .withIndex("by_session_and_startedAt", (q) => q.eq("session", session._id))
      .first();
    if (!remaining) await ctx.db.delete("telemetry_sessions", session._id);
  }
  await scheduleCollectGarbage(ctx);
}

/** Owner-only. Large sessions are deleted in pages by scheduled continuations. */
export const deleteSession = mutation({
  args: { session: v.id("telemetry_sessions") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const session = await ctx.db.get("telemetry_sessions", args.session);
    if (!session) throw new Error("Session not found.");
    await requireOwnedWorkspace(ctx, session.workspace);
    if (
      session.chatId &&
      !(await isChatVisibleToWorkspace(ctx, session.workspace, session.chatId))
    ) {
      throw new Error("Session not found.");
    }

    await deleteSessionPage(ctx, session, null);
    return null;
  },
});

/** Continuation of `deleteSession`; authorization happened in the first page. */
export const deleteSessionPages = internalMutation({
  args: { session: v.id("telemetry_sessions"), cursor: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const session = await ctx.db.get("telemetry_sessions", args.session);
    if (session) await deleteSessionPage(ctx, session, args.cursor);
    return null;
  },
});

/**
 * Cron entry: apply each workspace's `retentionDays`. Pages over workspace settings and
 * reschedules itself while a workspace still has expired rows or settings pages remain.
 */
export const pruneExpired = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();
    const page = await ctx.db
      .query("workspace_settings")
      .paginate({ numItems: SETTINGS_PAGE, cursor: args.cursor ?? null });

    let more = false;
    for (const settings of page.page) {
      const days = settings.telemetry?.retentionDays;
      if (days === undefined) continue;
      const cutoff = now - days * DAY_MS;

      const expired = await ctx.db
        .query("telemetry_requests")
        .withIndex("by_workspace_and_startedAt", (q) =>
          q.eq("workspace", settings.workspace).lt("startedAt", cutoff),
        )
        .take(REQUEST_BATCH);
      for (const request of expired) await deleteRequestRow(ctx, request);
      if (expired.length === REQUEST_BATCH) {
        more = true;
        continue;
      }

      // A session is removable once it is past the cutoff and has no requests left.
      const sessions = await ctx.db
        .query("telemetry_sessions")
        .withIndex("by_workspace_and_startedAt", (q) =>
          q.eq("workspace", settings.workspace).lt("startedAt", cutoff),
        )
        .take(SESSION_BATCH);
      let removed = 0;
      for (const session of sessions) {
        const remaining = await ctx.db
          .query("telemetry_requests")
          .withIndex("by_session_and_startedAt", (q) => q.eq("session", session._id))
          .first();
        if (remaining) continue;
        await ctx.db.delete("telemetry_sessions", session._id);
        removed++;
      }
      if (removed === SESSION_BATCH) more = true;
    }

    // Re-run the same page while a workspace has more; otherwise move to the next page.
    if (more) {
      await ctx.scheduler.runAfter(0, internal.observability.telemetryRetention.pruneExpired, {
        cursor: args.cursor ?? null,
      });
    } else if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.observability.telemetryRetention.pruneExpired, {
        cursor: page.continueCursor,
      });
    }
    await scheduleCollectGarbage(ctx);
    return null;
  },
});

/** Delete a node nothing references; queue its parent and blob for the same check. */
async function collectNode(ctx: MutationCtx, node: Doc<"telemetry_nodes">) {
  const child = await ctx.db
    .query("telemetry_nodes")
    .withIndex("by_parent", (q) => q.eq("parent", node._id))
    .first();
  if (child) return;
  const asInput = await ctx.db
    .query("telemetry_requests")
    .withIndex("by_input", (q) => q.eq("input", node._id))
    .first();
  if (asInput) return;
  const asOutput = await ctx.db
    .query("telemetry_requests")
    .withIndex("by_output", (q) => q.eq("output", node._id))
    .first();
  if (asOutput) return;

  await ctx.db.delete("telemetry_nodes", node._id);
  if (node.parent) {
    await ctx.db.insert("telemetry_gc", { workspace: node.workspace, node: node.parent });
  }
  await ctx.db.insert("telemetry_gc", { workspace: node.workspace, blob: node.blob });
}

async function isBlobReferenced(ctx: MutationCtx, blob: Doc<"telemetry_blobs">) {
  const id = blob._id;
  const checks = [
    ctx.db
      .query("telemetry_nodes")
      .withIndex("by_blob", (q) => q.eq("blob", id))
      .first(),
    ctx.db
      .query("telemetry_requests")
      .withIndex("by_system", (q) => q.eq("system", id))
      .first(),
    ctx.db
      .query("telemetry_requests")
      .withIndex("by_toolset", (q) => q.eq("toolset", id))
      .first(),
    ctx.db
      .query("telemetry_requests")
      .withIndex("by_params", (q) => q.eq("params", id))
      .first(),
    ctx.db
      .query("telemetry_requests")
      .withIndex("by_headers", (q) => q.eq("headers", id))
      .first(),
    ctx.db
      .query("telemetry_requests")
      .withIndex("by_legacy_input", (q) => q.eq("legacy.input", id))
      .first(),
    ctx.db
      .query("telemetry_requests")
      .withIndex("by_legacy_output", (q) => q.eq("legacy.output", id))
      .first(),
    ctx.db
      .query("telemetry_requests")
      .withIndex("by_legacy_spans", (q) => q.eq("legacy.spans", id))
      .first(),
    ctx.db
      .query("telemetry_toolset_tools")
      .withIndex("by_tool", (q) => q.eq("tool", id))
      .first(),
  ];
  for (const check of checks) {
    if (await check) return true;
  }
  return false;
}

/** Delete an unreferenced blob, its file, and (for toolsets) its membership rows. */
async function collectBlob(ctx: MutationCtx, blob: Doc<"telemetry_blobs">) {
  if (await isBlobReferenced(ctx, blob)) return;

  if (blob.kind === "toolset") {
    const members = await ctx.db
      .query("telemetry_toolset_tools")
      .withIndex("by_toolset_and_position", (q) => q.eq("toolset", blob._id))
      .collect();
    for (const member of members) {
      await ctx.db.delete("telemetry_toolset_tools", member._id);
      await ctx.db.insert("telemetry_gc", { workspace: blob.workspace, blob: member.tool });
    }
  }
  if (blob.storage) await ctx.storage.delete(blob.storage);
  await ctx.db.delete("telemetry_blobs", blob._id);
}

/**
 * Process queued reference checks. Idempotent: rows whose target is gone or still referenced are
 * simply removed. Reschedules itself while the queue is non-empty.
 */
export const collectGarbage = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const rows = await ctx.db.query("telemetry_gc").take(GC_BATCH);
    for (const row of rows) {
      if (row.node) {
        const node = await ctx.db.get("telemetry_nodes", row.node);
        if (node) await collectNode(ctx, node);
      }
      if (row.blob) {
        const blob = await ctx.db.get("telemetry_blobs", row.blob);
        if (blob) await collectBlob(ctx, blob);
      }
      await ctx.db.delete("telemetry_gc", row._id);
    }

    if (await ctx.db.query("telemetry_gc").first()) await scheduleCollectGarbage(ctx);
    return null;
  },
});
