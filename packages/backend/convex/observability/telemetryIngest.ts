import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "../_generated/server";
import { authorizeChatRecord, requireWorkspaceAccessForUser } from "../workspaces";
import {
  telemetryAttemptSchema,
  telemetryBlobKindSchema,
  telemetryBlobMetaSchema,
  telemetryRequestStatusSchema,
  telemetrySourceSchema,
  telemetryUsageSchema,
  type TelemetryChanges,
  type TelemetryLineage,
} from "../../src/telemetry/validators";

// Capture writes arrive from `src/telemetry/capture.ts` in bounded batches. Every function here
// is internal: arguments are server-derived, but ownership claims (API key, chat) are still
// re-checked against app-owned records before anything is attributed to a workspace.

type NodeLookupCtx = Pick<QueryCtx, "db">;

function blobByHash(ctx: NodeLookupCtx, workspace: Id<"workspaces">, hash: string) {
  return ctx.db
    .query("telemetry_blobs")
    .withIndex("by_workspace_and_hash", (q) => q.eq("workspace", workspace).eq("hash", hash))
    .first();
}

function nodeByHash(ctx: NodeLookupCtx, workspace: Id<"workspaces">, hash: string) {
  return ctx.db
    .query("telemetry_nodes")
    .withIndex("by_workspace_and_hash", (q) => q.eq("workspace", workspace).eq("hash", hash))
    .first();
}

/**
 * Longest prefix of a chain whose nodes already exist. `hashes[i]` is the node hash at depth
 * `i + 1`. Nodes are only ever inserted after their parent, so existence is monotone in prefix
 * length and a binary search needs O(log n) index lookups.
 */
export const deepestExistingPrefix = internalQuery({
  args: { workspace: v.id("workspaces"), hashes: v.array(v.string()) },
  returns: v.object({ depth: v.number(), node: v.optional(v.id("telemetry_nodes")) }),
  handler: async (ctx, args) => {
    let low = 0;
    let high = args.hashes.length;
    let node: Id<"telemetry_nodes"> | undefined;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      const found = await nodeByHash(ctx, args.workspace, args.hashes[middle - 1]!);
      if (found) {
        low = middle;
        node = found._id;
      } else {
        high = middle - 1;
      }
    }
    return { depth: low, node };
  },
});

/**
 * Which blob hashes are already stored, and whether their content is. Lets the action skip
 * sending content the workspace already has. Reads blob documents, so callers keep batches small.
 */
export const existingBlobs = internalQuery({
  args: { workspace: v.id("workspaces"), hashes: v.array(v.string()) },
  returns: v.array(
    v.object({ hash: v.string(), id: v.id("telemetry_blobs"), recorded: v.boolean() }),
  ),
  handler: async (ctx, args) => {
    const found: Array<{ hash: string; id: Id<"telemetry_blobs">; recorded: boolean }> = [];
    for (const hash of args.hashes) {
      const blob = await blobByHash(ctx, args.workspace, hash);
      if (!blob) continue;
      found.push({
        hash,
        id: blob._id,
        recorded: blob.content !== undefined || blob.storage !== undefined,
      });
    }
    return found;
  },
});

const blobInput = v.object({
  hash: v.string(),
  kind: telemetryBlobKindSchema,
  /** UTF-8 byte length of the canonical JSON, even when the content is not stored. */
  size: v.number(),
  content: v.optional(v.string()),
  /** File-storage copy of content above the inline limit, uploaded by the caller. */
  storage: v.optional(v.id("_storage")),
  meta: v.optional(telemetryBlobMetaSchema),
  /** Tool blobs of a `toolset`, in request order; they must already exist. */
  members: v.optional(v.array(v.id("telemetry_blobs"))),
});

/**
 * Upsert blobs by `(workspace, hash)`. A blob first stored without content is upgraded when
 * content arrives later; an upload that lost the race to an existing recorded blob is deleted.
 * Toolset member rows are written once, when the toolset blob is first inserted.
 */
export const ingestBlobs = internalMutation({
  args: { workspace: v.id("workspaces"), blobs: v.array(blobInput) },
  returns: v.array(v.object({ hash: v.string(), id: v.id("telemetry_blobs") })),
  handler: async (ctx, args) => {
    const ids: Array<{ hash: string; id: Id<"telemetry_blobs"> }> = [];
    for (const blob of args.blobs) {
      const existing = await blobByHash(ctx, args.workspace, blob.hash);
      const hasContent = blob.content !== undefined || blob.storage !== undefined;

      if (existing) {
        const existingRecorded = existing.content !== undefined || existing.storage !== undefined;
        if (!existingRecorded && hasContent) {
          await ctx.db.patch("telemetry_blobs", existing._id, {
            content: blob.content,
            storage: blob.storage,
          });
        } else if (blob.storage) {
          await ctx.storage.delete(blob.storage);
        }
        ids.push({ hash: blob.hash, id: existing._id });
        continue;
      }

      const id = await ctx.db.insert("telemetry_blobs", {
        workspace: args.workspace,
        hash: blob.hash,
        kind: blob.kind,
        size: blob.size,
        content: blob.content,
        storage: blob.storage,
        meta: blob.meta,
      });
      for (const [position, tool] of (blob.members ?? []).entries()) {
        await ctx.db.insert("telemetry_toolset_tools", {
          workspace: args.workspace,
          toolset: id,
          tool,
          position,
        });
      }
      ids.push({ hash: blob.hash, id });
    }
    return ids;
  },
});

/**
 * Append a run of messages below the node with `parentHash` (or at the root when absent) and
 * return the last node of the run. Existing nodes are kept as they are, so replays and
 * concurrent requests that share a prefix converge on the same rows; the first writer's
 * `origin` wins. `forked` reports whether the first node this run inserted joined a parent
 * that already had another child, i.e. the conversation diverged from stored history there.
 */
export const ingestNodes = internalMutation({
  args: {
    workspace: v.id("workspaces"),
    parentHash: v.optional(v.string()),
    nodes: v.array(
      v.object({
        hash: v.string(),
        blob: v.id("telemetry_blobs"),
        origin: v.union(v.literal("input"), v.literal("output")),
      }),
    ),
  },
  returns: v.object({ node: v.id("telemetry_nodes"), forked: v.boolean() }),
  handler: async (ctx, args) => {
    let last: { id: Id<"telemetry_nodes">; depth: number } | undefined;
    if (args.parentHash !== undefined) {
      const parent = await nodeByHash(ctx, args.workspace, args.parentHash);
      if (!parent) throw new Error("Telemetry parent node not found.");
      last = { id: parent._id, depth: parent.depth };
    }

    let inserted = false;
    let forked = false;
    for (const node of args.nodes) {
      const existing = await nodeByHash(ctx, args.workspace, node.hash);
      if (existing) {
        last = { id: existing._id, depth: existing.depth };
        continue;
      }
      // Only the first insertion can join existing history; later nodes hang off new ones.
      if (!inserted && last) {
        const parent = last.id;
        forked =
          (await ctx.db
            .query("telemetry_nodes")
            .withIndex("by_parent", (q) => q.eq("parent", parent))
            .first()) !== null;
      }
      inserted = true;
      const depth = (last?.depth ?? 0) + 1;
      const id = await ctx.db.insert("telemetry_nodes", {
        workspace: args.workspace,
        hash: node.hash,
        parent: last?.id,
        blob: node.blob,
        depth,
        origin: node.origin,
      });
      last = { id, depth };
    }
    if (!last) throw new Error("Telemetry node run is empty.");
    return { node: last.id, forked };
  },
});

async function requireWorkspaceNode(
  ctx: MutationCtx,
  workspace: Id<"workspaces">,
  id: Id<"telemetry_nodes"> | undefined,
) {
  if (!id) return null;
  const node = await ctx.db.get("telemetry_nodes", id);
  if (!node || node.workspace !== workspace) throw new Error("Telemetry node mismatch.");
  return node;
}

/** Prefer a request from the same session, else the most recent one. */
function preferSession(
  rows: Doc<"telemetry_requests">[],
  session: Id<"telemetry_sessions"> | undefined,
) {
  return rows.find((row) => session !== undefined && row.session === session) ?? rows[0];
}

/**
 * Relate this request's conversation to earlier requests. `prefix` is the deepest chain node
 * that existed before this request inserted its own, so it marks where the conversation
 * rejoined stored history.
 */
async function classifyLineage(
  ctx: MutationCtx,
  args: {
    workspace: Id<"workspaces">;
    session: Id<"telemetry_sessions"> | undefined;
    sessionHasRequests: boolean;
    previous: Doc<"telemetry_requests"> | undefined;
    input: Doc<"telemetry_nodes"> | null;
    prefix: Doc<"telemetry_nodes"> | null;
    /** The request's first new node joined `prefix` while it already had another child. */
    forked: boolean;
  },
): Promise<TelemetryLineage> {
  if (!args.input) return { kind: "root" };
  if (!args.prefix) return { kind: args.sessionHasRequests ? "compacted" : "root" };

  const prefix = args.prefix;
  const atLeaf = prefix._id === args.input._id;

  if (atLeaf) {
    const resent = preferSession(
      await ctx.db
        .query("telemetry_requests")
        .withIndex("by_input", (q) => q.eq("input", prefix._id))
        .order("desc")
        .take(20),
      args.session,
    );
    if (resent) return { kind: "retry", request: resent._id, depth: prefix.depth };
  }

  const produced = preferSession(
    await ctx.db
      .query("telemetry_requests")
      .withIndex("by_output", (q) => q.eq("output", prefix._id))
      .order("desc")
      .take(20),
    args.session,
  );
  if (produced) {
    // Continuing from an output that another request already continued is a rollback/edit.
    return {
      kind: args.forked ? "branch" : "continue",
      request: produced._id,
      depth: prefix.depth,
    };
  }

  if (!atLeaf) {
    const extended = preferSession(
      await ctx.db
        .query("telemetry_requests")
        .withIndex("by_input", (q) => q.eq("input", prefix._id))
        .order("desc")
        .take(20),
      args.session,
    );
    if (extended) {
      return {
        kind: extended.output ? "rewrite" : args.forked ? "branch" : "continue",
        request: extended._id,
        depth: prefix.depth,
      };
    }
  }

  return { kind: "branch", request: args.previous?._id, depth: prefix.depth };
}

function classifyChanges(
  previous: Doc<"telemetry_requests"> | undefined,
  current: {
    system?: Id<"telemetry_blobs">;
    toolset?: Id<"telemetry_blobs">;
    params?: Id<"telemetry_blobs">;
    model: string;
  },
): TelemetryChanges | undefined {
  if (!previous) return undefined;

  const changes: Omit<TelemetryChanges, "previous"> = {};
  for (const field of ["system", "toolset", "params"] as const) {
    if (previous[field] !== current[field]) {
      changes[field] = { from: previous[field], to: current[field] };
    }
  }
  if (previous.model !== current.model) {
    changes.model = { from: previous.model, to: current.model };
  }
  return Object.keys(changes).length > 0 ? { previous: previous._id, ...changes } : undefined;
}

/**
 * Record one finished Gateway request, idempotent by `(workspace, requestId)`: a retried
 * call returns the existing row. The caller ingests blobs and nodes first; `prefix` is the
 * deepest chain node found before its own nodes were inserted. Schedules export delivery.
 */
export const finishRequest = internalMutation({
  args: {
    workspace: v.id("workspaces"),
    requestId: v.string(),
    source: telemetrySourceSchema,
    apiKey: v.optional(v.id("api_keys")),
    userId: v.string(),
    chatId: v.optional(v.id("aisdk_chats")),
    session: v.optional(v.object({ key: v.string(), parentKey: v.optional(v.string()) })),
    model: v.string(),
    provider: v.optional(v.string()),
    credential: v.optional(v.id("workspace_credentials")),
    stream: v.boolean(),
    status: telemetryRequestStatusSchema,
    startedAt: v.number(),
    endedAt: v.number(),
    durationMs: v.number(),
    ttftMs: v.optional(v.number()),
    generationMs: v.optional(v.number()),
    finishReason: v.optional(v.string()),
    usage: v.optional(telemetryUsageSchema),
    providerGenerationId: v.optional(v.string()),
    chatCompletion: v.optional(v.id("chat_completions")),
    error: v.optional(v.object({ message: v.string(), status: v.optional(v.number()) })),
    canceled: v.optional(v.boolean()),
    attempts: v.array(telemetryAttemptSchema),
    input: v.optional(v.id("telemetry_nodes")),
    output: v.optional(v.id("telemetry_nodes")),
    prefix: v.optional(v.id("telemetry_nodes")),
    /** Whether the first inserted input node forked from existing history at `prefix`. */
    forked: v.optional(v.boolean()),
    system: v.optional(v.id("telemetry_blobs")),
    toolset: v.optional(v.id("telemetry_blobs")),
    params: v.optional(v.id("telemetry_blobs")),
    headers: v.optional(v.id("telemetry_blobs")),
    recordsInputs: v.boolean(),
    recordsOutputs: v.boolean(),
  },
  returns: v.id("telemetry_requests"),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("telemetry_requests")
      .withIndex("by_workspace_and_requestId", (q) =>
        q.eq("workspace", args.workspace).eq("requestId", args.requestId),
      )
      .first();
    if (existing) return existing._id;

    // The claims below arrive as action arguments; they must match app-owned records.
    await requireWorkspaceAccessForUser(ctx, args.workspace, args.userId);
    if (args.apiKey) {
      const apiKey = await ctx.db.get("api_keys", args.apiKey);
      if (!apiKey || apiKey.workspace !== args.workspace) {
        throw new Error("Telemetry key mismatch.");
      }
    }
    if (args.chatId) {
      const chat = await authorizeChatRecord(ctx, args.chatId, args.userId);
      if (!chat || chat.workspace._id !== args.workspace) {
        throw new Error("Telemetry chat mismatch.");
      }
    } else if (args.source === "chatroom") {
      throw new Error("Chatroom telemetry requires chat attribution.");
    }
    const [input, prefix] = await Promise.all([
      requireWorkspaceNode(ctx, args.workspace, args.input),
      requireWorkspaceNode(ctx, args.workspace, args.prefix),
      requireWorkspaceNode(ctx, args.workspace, args.output),
    ]);

    let session: Id<"telemetry_sessions"> | undefined;
    if (args.session) {
      const key = args.session.key;
      const found = await ctx.db
        .query("telemetry_sessions")
        .withIndex("by_workspace_and_key", (q) => q.eq("workspace", args.workspace).eq("key", key))
        .first();
      session =
        found?._id ??
        (await ctx.db.insert("telemetry_sessions", {
          workspace: args.workspace,
          key,
          parentKey: args.session.parentKey,
          chatId: args.chatId,
          startedAt: args.startedAt,
        }));
    }

    const previous = session
      ? ((await ctx.db
          .query("telemetry_requests")
          .withIndex("by_session_and_startedAt", (q) =>
            q.eq("session", session).lte("startedAt", args.startedAt),
          )
          .order("desc")
          .first()) ?? undefined)
      : undefined;
    const sessionHasRequests =
      previous !== undefined ||
      (session !== undefined &&
        (await ctx.db
          .query("telemetry_requests")
          .withIndex("by_session_and_startedAt", (q) => q.eq("session", session))
          .first()) !== null);

    const lineage = await classifyLineage(ctx, {
      workspace: args.workspace,
      session,
      sessionHasRequests,
      previous,
      input,
      prefix,
      forked: args.forked ?? false,
    });
    const changes = classifyChanges(previous, args);

    const { session: _session, prefix: _prefix, forked: _forked, ...fields } = args;
    const request = await ctx.db.insert("telemetry_requests", {
      ...fields,
      session,
      lineage,
      changes,
    });
    await ctx.scheduler.runAfter(0, internal.observability.telemetryExport.deliver, { request });
    return request;
  },
});
