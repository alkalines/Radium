import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { internalQuery, query, type QueryCtx } from "../_generated/server";
import { ownedWorkspaceMutation, ownedWorkspaceQuery } from "../helpers";
import { loadWorkspaceSettings, requireOwnedWorkspace } from "../workspaces";
import {
  isChatVisibleToWorkspace,
  isCompletionVisible,
  isRequestVisible,
  type AttributedCompletion,
} from "../chatroom";
import {
  buildBranchLanes,
  diffTools,
  sharedPrefixDepth,
  summarizeRequests,
  type LineageParent,
} from "../../src/telemetry/reads";
import {
  blobValue,
  loadBlob,
  loadChain,
  loadToolset,
  type LoadedBlob,
} from "../../src/telemetry/store";
import {
  telemetryRequestStatusSchema,
  telemetrySettingsSchema,
  type TelemetrySettings,
} from "../../src/telemetry/validators";

const defaultSettings: TelemetrySettings = {
  enabled: false,
  recordInputs: false,
  recordOutputs: false,
};

const MAX_RETENTION_DAYS = 3650;
const MAX_PAGE_SIZE = 50;
const MESSAGE_PAGE_DEFAULT = 20;
const MESSAGE_PAGE_MAX = 50;
/** Per-session request scan used for list rows; keeps a page of sessions within read limits. */
const SESSION_REQUEST_SCAN = 100;
const SESSION_WINDOW_DEFAULT = 300;
const SESSION_WINDOW_MAX = 500;
/** One beyond the summary window so the result can report truncation. */
const SUMMARY_WINDOW = 2000;

type Workspace = Doc<"workspaces">;
type RequestChange = "system" | "toolset" | "params" | "model";

/** Per-query memo of chat visibility, session rows, and node depths. */
type Caches = {
  visibility: Map<string, boolean>;
  sessions: Map<Id<"telemetry_sessions">, Doc<"telemetry_sessions"> | null>;
  depths: Map<Id<"telemetry_nodes">, number>;
};

function newCaches(): Caches {
  return { visibility: new Map(), sessions: new Map(), depths: new Map() };
}

/** Read workspace telemetry capture preferences; owner-only. */
export const getSettings = ownedWorkspaceQuery({
  args: {},
  returns: telemetrySettingsSchema,
  handler: async (ctx) => ctx.workspace.settings.telemetry ?? defaultSettings,
});

/**
 * Configure owner-only capture. Disabling capture also clears the content flags so re-enabling
 * never silently resumes recording prompts. `retentionDays` is 1..3650, `null` clears it (keep
 * forever), and omitting it keeps the stored value.
 */
export const setSettings = ownedWorkspaceMutation({
  args: {
    enabled: v.boolean(),
    recordInputs: v.boolean(),
    recordOutputs: v.boolean(),
    retentionDays: v.optional(v.union(v.number(), v.null())),
  },
  returns: v.id("workspace_settings"),
  handler: async (ctx, args) => {
    const retentionDays =
      args.retentionDays === undefined
        ? ctx.workspace.settings.telemetry?.retentionDays
        : args.retentionDays;
    if (
      retentionDays !== undefined &&
      retentionDays !== null &&
      (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > MAX_RETENTION_DAYS)
    ) {
      throw new Error(`Retention must be a whole number of days from 1 to ${MAX_RETENTION_DAYS}.`);
    }

    const telemetry: TelemetrySettings = {
      enabled: args.enabled,
      recordInputs: args.enabled && args.recordInputs,
      recordOutputs: args.enabled && args.recordOutputs,
      ...(retentionDays != null ? { retentionDays } : {}),
    };
    return await ctx.workspace.updateSettings({ telemetry });
  },
});

/** Capture settings for server-side callers; archived or missing workspaces never capture. */
export const getSettingsForWorkspace = internalQuery({
  args: { workspace: v.id("workspaces") },
  returns: telemetrySettingsSchema,
  handler: async (ctx, args) => {
    const workspace = await ctx.db.get("workspaces", args.workspace);
    if (!workspace || workspace.archivedAt !== undefined) return defaultSettings;
    return (await loadWorkspaceSettings(ctx, workspace)).telemetry ?? defaultSettings;
  },
});

async function requireVisibleRequest(ctx: QueryCtx, requestId: Id<"telemetry_requests">) {
  const request = await ctx.db.get("telemetry_requests", requestId);
  if (!request) throw new Error("Request not found.");
  const workspace = await requireOwnedWorkspace(ctx, request.workspace);
  // Missing and policy-hidden requests are indistinguishable to the caller.
  if (!(await isRequestVisible(ctx, workspace, request))) throw new Error("Request not found.");
  return { request, workspace };
}

async function requireVisibleSession(
  ctx: QueryCtx,
  sessionId: Id<"telemetry_sessions">,
  caches: Caches,
) {
  const session = await ctx.db.get("telemetry_sessions", sessionId);
  if (!session) throw new Error("Session not found.");
  const workspace = await requireOwnedWorkspace(ctx, session.workspace);
  if (!(await isSessionVisible(ctx, workspace, session, caches))) {
    throw new Error("Session not found.");
  }
  return { session, workspace };
}

async function isSessionVisible(
  ctx: QueryCtx,
  workspace: Workspace,
  session: Doc<"telemetry_sessions">,
  caches: Caches,
) {
  if (session.workspace !== workspace._id) return false;
  if (session.chatId === undefined) return true;
  return await isChatVisibleToWorkspace(ctx, workspace._id, session.chatId, caches.visibility);
}

async function nodeDepth(ctx: QueryCtx, caches: Caches, node: Id<"telemetry_nodes"> | undefined) {
  if (!node) return 0;
  const cached = caches.depths.get(node);
  if (cached !== undefined) return cached;
  const doc = await ctx.db.get("telemetry_nodes", node);
  const depth = doc?.depth ?? 0;
  caches.depths.set(node, depth);
  return depth;
}

async function sessionOf(ctx: QueryCtx, caches: Caches, id: Id<"telemetry_sessions"> | undefined) {
  if (!id) return null;
  if (!caches.sessions.has(id)) caches.sessions.set(id, await ctx.db.get("telemetry_sessions", id));
  return caches.sessions.get(id) ?? null;
}

function changedFields(request: Doc<"telemetry_requests">): RequestChange[] {
  const changes = request.changes;
  if (!changes) return [];
  const fields: RequestChange[] = [];
  if (changes.model) fields.push("model");
  if (changes.system) fields.push("system");
  if (changes.toolset) fields.push("toolset");
  if (changes.params) fields.push("params");
  return fields;
}

/** Cost estimate from the linked completion, only when that completion is itself visible. */
async function requestCost(
  ctx: QueryCtx,
  workspace: Workspace,
  request: Doc<"telemetry_requests">,
  caches: Caches,
) {
  if (!request.chatCompletion) return undefined;
  const completion = await ctx.db.get("chat_completions", request.chatCompletion);
  if (!completion) return undefined;
  const visible = await isCompletionVisible(
    ctx,
    workspace,
    completion as AttributedCompletion,
    caches.visibility,
  );
  return visible ? completion.response.pricing.cost : undefined;
}

/** Row fields shared by lists, session timelines, and the request header. */
async function summarizeRequest(
  ctx: QueryCtx,
  workspace: Workspace,
  request: Doc<"telemetry_requests">,
  caches: Caches,
  options: { cost: boolean },
) {
  const session = await sessionOf(ctx, caches, request.session);
  return {
    _id: request._id,
    startedAt: request.startedAt,
    endedAt: request.endedAt,
    durationMs: request.durationMs,
    ttftMs: request.ttftMs,
    model: request.model,
    provider: request.provider,
    source: request.source,
    status: request.status,
    stream: request.stream,
    finishReason: request.finishReason,
    usage: request.usage,
    error: request.error?.message,
    chatId: request.chatId,
    sessionId: request.session,
    sessionKey: session?.key,
    lineage: request.lineage,
    changedFields: changedFields(request),
    /** Message depth of the last client message; 0 when the request had none. */
    inputDepth: await nodeDepth(ctx, caches, request.input),
    attempts: request.attempts.length,
    recordsInputs: request.recordsInputs,
    recordsOutputs: request.recordsOutputs,
    imported: request.legacy !== undefined,
    cost: options.cost ? await requestCost(ctx, workspace, request, caches) : undefined,
  };
}

async function lineageParent(
  ctx: QueryCtx,
  workspace: Workspace,
  request: Doc<"telemetry_requests">,
  caches: Caches,
): Promise<{ parent: Doc<"telemetry_requests"> | null; info: LineageParent | null }> {
  if (!request.lineage.request) return { parent: null, info: null };
  const parent = await ctx.db.get("telemetry_requests", request.lineage.request);
  if (!parent || parent.workspace !== workspace._id) return { parent: null, info: null };
  return {
    parent,
    info: {
      inputDepth: await nodeDepth(ctx, caches, parent.input),
      hasOutput: parent.output !== undefined,
    },
  };
}

/** Newest-first request rows, optionally narrowed to a session, status, or requested model. */
export const listRequests = ownedWorkspaceQuery({
  args: {
    paginationOpts: paginationOptsValidator,
    session: v.optional(v.id("telemetry_sessions")),
    status: v.optional(telemetryRequestStatusSchema),
    model: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const workspace = ctx.workspace;
    const caches = newCaches();
    const { session, status, model } = args;

    if (session !== undefined) {
      const row = await ctx.db.get("telemetry_sessions", session);
      if (!row || !(await isSessionVisible(ctx, workspace, row, caches))) {
        throw new Error("Session not found.");
      }
    }

    let requests =
      session !== undefined
        ? ctx.db
            .query("telemetry_requests")
            .withIndex("by_session_and_startedAt", (q) => q.eq("session", session))
            .order("desc")
        : ctx.db
            .query("telemetry_requests")
            .withIndex("by_workspace_and_startedAt", (q) => q.eq("workspace", workspace._id))
            .order("desc");
    if (status !== undefined) requests = requests.filter((q) => q.eq(q.field("status"), status));
    if (model !== undefined) requests = requests.filter((q) => q.eq(q.field("model"), model));

    const result = await requests.paginate({
      ...args.paginationOpts,
      numItems: Math.min(args.paginationOpts.numItems, MAX_PAGE_SIZE),
    });

    // Visibility is applied after paging, so a page can be shorter than requested.
    const page = [];
    for (const request of result.page) {
      if (!(await isRequestVisible(ctx, workspace, request, caches.visibility))) continue;
      page.push(await summarizeRequest(ctx, workspace, request, caches, { cost: true }));
    }
    return { ...result, page };
  },
});

function toolName(tool: LoadedBlob): string {
  if (tool.meta?.names?.[0]) return tool.meta.names[0];
  const value = blobValue(tool) as { function?: { name?: unknown }; name?: unknown } | undefined;
  const name = value?.function?.name ?? value?.name;
  return typeof name === "string" ? name : tool.hash.slice(0, 12);
}

async function loadNamedToolset(
  ctx: QueryCtx,
  workspace: Id<"workspaces">,
  toolset: Id<"telemetry_blobs"> | undefined,
) {
  const tools = await loadToolset(ctx, workspace, toolset);
  return tools.map((blob) => ({ name: toolName(blob), blob }));
}

async function loadNode(
  ctx: QueryCtx,
  workspace: Id<"workspaces">,
  id: Id<"telemetry_nodes"> | undefined,
) {
  if (!id) return null;
  const node = await ctx.db.get("telemetry_nodes", id);
  if (!node || node.workspace !== workspace) return null;
  const message = await loadBlob(ctx, workspace, node.blob);
  return message ? { id: node._id, depth: node.depth, origin: node.origin, message } : null;
}

async function resolveChange(
  ctx: QueryCtx,
  workspace: Id<"workspaces">,
  change: { from?: Id<"telemetry_blobs">; to?: Id<"telemetry_blobs"> } | undefined,
) {
  if (!change) return undefined;
  return {
    from: await loadBlob(ctx, workspace, change.from),
    to: await loadBlob(ctx, workspace, change.to),
  };
}

async function resolveToolChange(
  ctx: QueryCtx,
  workspace: Id<"workspaces">,
  change: { from?: Id<"telemetry_blobs">; to?: Id<"telemetry_blobs"> } | undefined,
) {
  if (!change) return undefined;
  const before = await loadNamedToolset(ctx, workspace, change.from);
  const after = await loadNamedToolset(ctx, workspace, change.to);
  const diff = diffTools(
    before.map((tool) => ({ name: tool.name, hash: tool.blob.hash })),
    after.map((tool) => ({ name: tool.name, hash: tool.blob.hash })),
  );
  const beforeByName = new Map(before.map((tool) => [tool.name, tool.blob]));
  const afterByName = new Map(after.map((tool) => [tool.name, tool.blob]));
  return {
    reordered: diff.reordered,
    added: diff.added.map((tool) => ({ name: tool.name, blob: afterByName.get(tool.name)! })),
    removed: diff.removed.map((tool) => ({ name: tool.name, blob: beforeByName.get(tool.name)! })),
    changed: diff.changed.map((tool) => ({
      name: tool.name,
      before: beforeByName.get(tool.name)!,
      after: afterByName.get(tool.name)!,
    })),
  };
}

/**
 * One request with its configuration blobs, tools, attempts, output, and the differences from
 * the previous request in its session resolved to before/after values.
 */
export const getRequest = query({
  args: { request: v.id("telemetry_requests") },
  handler: async (ctx, args) => {
    const { request, workspace } = await requireVisibleRequest(ctx, args.request);
    const caches = newCaches();
    const summary = await summarizeRequest(ctx, workspace, request, caches, { cost: true });
    const session = await sessionOf(ctx, caches, request.session);

    const { parent, info } = await lineageParent(ctx, workspace, request, caches);
    const related =
      parent && (await isRequestVisible(ctx, workspace, parent, caches.visibility))
        ? {
            _id: parent._id,
            startedAt: parent.startedAt,
            model: parent.model,
            status: parent.status,
          }
        : null;

    const changes = request.changes
      ? {
          previous: request.changes.previous,
          model: request.changes.model,
          system: await resolveChange(ctx, workspace._id, request.changes.system),
          params: await resolveChange(ctx, workspace._id, request.changes.params),
          tools: await resolveToolChange(ctx, workspace._id, request.changes.toolset),
        }
      : null;

    const legacy = request.legacy
      ? {
          traceId: request.legacy.traceId,
          input: await loadBlob(ctx, workspace._id, request.legacy.input),
          output: await loadBlob(ctx, workspace._id, request.legacy.output),
          spans: await loadBlob(ctx, workspace._id, request.legacy.spans),
        }
      : null;

    return {
      request,
      summary,
      session: session
        ? { _id: session._id, key: session.key, parentKey: session.parentKey }
        : null,
      related,
      /** Messages deeper than this depth are new in this request. */
      prefixDepth: sharedPrefixDepth(request.lineage, info),
      system: await loadBlob(ctx, workspace._id, request.system),
      params: await loadBlob(ctx, workspace._id, request.params),
      headers: await loadBlob(ctx, workspace._id, request.headers),
      tools: await loadNamedToolset(ctx, workspace._id, request.toolset),
      output: await loadNode(ctx, workspace._id, request.output),
      changes,
      legacy,
    };
  },
});

/** Prove `ancestor` lies on the chain below `leaf` so a cursor cannot read another branch. */
async function isChainAncestor(
  ctx: QueryCtx,
  workspace: Id<"workspaces">,
  leaf: Id<"telemetry_nodes">,
  ancestor: Id<"telemetry_nodes">,
) {
  const target = await ctx.db.get("telemetry_nodes", ancestor);
  if (!target || target.workspace !== workspace) return false;
  let cursor: Id<"telemetry_nodes"> | undefined = leaf;
  while (cursor) {
    const node: Doc<"telemetry_nodes"> | null = await ctx.db.get("telemetry_nodes", cursor);
    if (!node || node.workspace !== workspace || node.depth < target.depth) return false;
    if (node.depth === target.depth) return node._id === ancestor;
    cursor = node.parent;
  }
  return false;
}

/**
 * The request's input chain, newest page first. Pass the returned `nextCursor` to read older
 * messages. Each page is oldest-first; `isNew` marks messages first seen in this request.
 */
export const getRequestMessages = query({
  args: {
    request: v.id("telemetry_requests"),
    cursor: v.optional(v.id("telemetry_nodes")),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { request, workspace } = await requireVisibleRequest(ctx, args.request);
    const caches = newCaches();
    const limit = Math.min(
      Math.max(Math.floor(args.limit ?? MESSAGE_PAGE_DEFAULT), 1),
      MESSAGE_PAGE_MAX,
    );

    let leaf = request.input;
    if (args.cursor !== undefined) {
      if (
        !request.input ||
        !(await isChainAncestor(ctx, workspace._id, request.input, args.cursor))
      ) {
        throw new Error("Invalid message cursor.");
      }
      leaf = args.cursor;
    }

    const { info } = await lineageParent(ctx, workspace, request, caches);
    const prefixDepth = sharedPrefixDepth(request.lineage, info);
    const chain = await loadChain(ctx, workspace._id, leaf, limit);
    return {
      nodes: chain.nodes.map((node) => ({ ...node, isNew: node.depth > prefixDepth })),
      prefixDepth,
      total: await nodeDepth(ctx, caches, request.input),
      more: chain.more,
      nextCursor: chain.nextLeaf,
    };
  },
});

/** Newest-first sessions with their latest activity and a capped request count. */
export const listSessions = ownedWorkspaceQuery({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    const caches = newCaches();
    const result = await ctx.db
      .query("telemetry_sessions")
      .withIndex("by_workspace_and_startedAt", (q) => q.eq("workspace", ctx.workspace._id))
      .order("desc")
      .paginate({
        ...args.paginationOpts,
        numItems: Math.min(args.paginationOpts.numItems, MAX_PAGE_SIZE / 2),
      });

    const page = [];
    for (const session of result.page) {
      if (!(await isSessionVisible(ctx, ctx.workspace, session, caches))) continue;
      const requests = await ctx.db
        .query("telemetry_requests")
        .withIndex("by_session_and_startedAt", (q) => q.eq("session", session._id))
        .order("desc")
        .take(SESSION_REQUEST_SCAN + 1);
      page.push({
        _id: session._id,
        key: session.key,
        parentKey: session.parentKey,
        chatId: session.chatId,
        startedAt: session.startedAt,
        lastRequestAt: requests[0]?.startedAt ?? session.startedAt,
        requestCount: Math.min(requests.length, SESSION_REQUEST_SCAN),
        requestCountCapped: requests.length > SESSION_REQUEST_SCAN,
      });
    }
    return { ...result, page };
  },
});

/**
 * A session's chronological request timeline and branch lanes over its newest `limit`
 * requests. Lanes are flat (`parentLane` links) because Convex values nest at most 16 deep.
 */
export const getSession = query({
  args: { session: v.id("telemetry_sessions"), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const caches = newCaches();
    const { session, workspace } = await requireVisibleSession(ctx, args.session, caches);
    const limit = Math.min(
      Math.max(Math.floor(args.limit ?? SESSION_WINDOW_DEFAULT), 1),
      SESSION_WINDOW_MAX,
    );

    const newest = await ctx.db
      .query("telemetry_requests")
      .withIndex("by_session_and_startedAt", (q) => q.eq("session", session._id))
      .order("desc")
      .take(limit + 1);
    const window = newest.slice(0, limit).reverse();
    const byId = new Map(window.map((request) => [request._id, request]));

    const timeline = [];
    for (const request of window) {
      if (!(await isRequestVisible(ctx, workspace, request, caches.visibility))) continue;

      const parent = request.lineage.request ? byId.get(request.lineage.request) : undefined;
      const info = parent
        ? {
            inputDepth: await nodeDepth(ctx, caches, parent.input),
            hasOutput: parent.output !== undefined,
          }
        : (await lineageParent(ctx, workspace, request, caches)).info;
      const prefixDepth = sharedPrefixDepth(request.lineage, info);
      const summary = await summarizeRequest(ctx, workspace, request, caches, { cost: false });
      timeline.push({
        ...summary,
        prefixDepth,
        newMessages: Math.max(0, summary.inputDepth - prefixDepth),
      });
    }

    const lanes = buildBranchLanes(
      timeline.map((entry) => ({
        id: entry._id,
        lineage: entry.lineage,
        forkDepth: entry.prefixDepth,
      })),
    );
    const parentSession = session.parentKey
      ? await ctx.db
          .query("telemetry_sessions")
          .withIndex("by_workspace_and_key", (q) =>
            q.eq("workspace", workspace._id).eq("key", session.parentKey!),
          )
          .first()
      : null;
    const children = await ctx.db
      .query("telemetry_sessions")
      .withIndex("by_workspace_and_parentKey", (q) =>
        q.eq("workspace", workspace._id).eq("parentKey", session.key),
      )
      .take(25);

    return {
      session: {
        _id: session._id,
        key: session.key,
        parentKey: session.parentKey,
        chatId: session.chatId,
        startedAt: session.startedAt,
      },
      parentSession: parentSession ? { _id: parentSession._id, key: parentSession.key } : null,
      children: children.map((child) => ({ _id: child._id, key: child.key })),
      requests: timeline,
      lanes,
      truncated: newest.length > limit,
    };
  },
});

/** Bounded workspace aggregates for requests since a timestamp; owner-visible requests only. */
export const getSummary = ownedWorkspaceQuery({
  args: { since: v.number() },
  handler: async (ctx, args) => {
    const scanned = await ctx.db
      .query("telemetry_requests")
      .withIndex("by_workspace_and_startedAt", (q) =>
        q.eq("workspace", ctx.workspace._id).gte("startedAt", args.since),
      )
      .order("desc")
      .take(SUMMARY_WINDOW + 1);

    const caches = newCaches();
    const visible = [];
    for (const request of scanned.slice(0, SUMMARY_WINDOW)) {
      if (await isRequestVisible(ctx, ctx.workspace, request, caches.visibility)) {
        visible.push(request);
      }
    }
    return { ...summarizeRequests(visible), truncated: scanned.length > SUMMARY_WINDOW };
  },
});
