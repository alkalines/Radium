import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { requireAccessibleChat } from "./workspaces";
import {
  isGatewayCompletionWithoutChat,
  isOwnerManagedGatewayTrace,
} from "../src/utils/workspaces/policy";

type DatabaseCtx = QueryCtx | MutationCtx;

/** The attribution fields added to completions during the ownership rollout. */
export type AttributedCompletion = Doc<"chat_completions"> & {
  chatId?: Id<"aisdk_chats">;
  userId?: string;
};

type VisibilityCache = Map<string, boolean>;

function visibilityKey(workspaceId: Id<"workspaces">, chatId: Id<"aisdk_chats">) {
  return `${workspaceId}:${chatId}`;
}

/**
 * Resolve chat visibility through the same policy as Chatroom. Any missing,
 * deleted, cross-workspace, or malformed chat is intentionally invisible.
 */
export async function isChatVisibleToWorkspace(
  ctx: DatabaseCtx,
  workspaceId: Id<"workspaces">,
  chatId: Id<"aisdk_chats">,
  cache: VisibilityCache = new Map(),
): Promise<boolean> {
  const key = visibilityKey(workspaceId, chatId);
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  let visible = false;
  try {
    const result = await requireAccessibleChat(ctx, chatId);
    const { chat, workspace } = result;
    const belongsToWorkspace = chat.workspace
      ? chat.workspace === workspaceId &&
        (chat.balance === undefined || chat.balance === workspace.legacyBalance)
      : chat.balance !== undefined && chat.balance === workspace.legacyBalance;
    visible = workspace._id === workspaceId && belongsToWorkspace;
  } catch {
    // A deleted or inaccessible chat must not turn into an observable row.
  }

  cache.set(key, visible);
  return visible;
}

/** A no-chat completion is visible only when its key proves it came from Gateway. */
export async function isCompletionVisible(
  ctx: DatabaseCtx,
  workspace: Doc<"workspaces">,
  completion: AttributedCompletion,
  cache: VisibilityCache = new Map(),
): Promise<boolean> {
  if (
    (completion.bill.workspace !== undefined && completion.bill.workspace !== workspace._id) ||
    (completion.bill.balance !== undefined &&
      completion.bill.balance !== workspace.legacyBalance) ||
    (completion.bill.workspace === undefined && completion.bill.balance === undefined)
  ) {
    return false;
  }
  if (completion.chatId !== undefined) {
    return await isChatVisibleToWorkspace(ctx, workspace._id, completion.chatId, cache);
  }

  // Internal Chatroom completions historically had neither key nor chat
  // attribution. Treat those rows as unknown rather than exposing private data.
  return isGatewayCompletionWithoutChat(completion);
}

/** Filter before callers derive counts, truncation, or cost aggregates. */
export async function filterVisibleCompletions(
  ctx: DatabaseCtx,
  workspace: Doc<"workspaces">,
  completions: AttributedCompletion[],
): Promise<AttributedCompletion[]> {
  const cache = new Map<string, boolean>();
  const visible: AttributedCompletion[] = [];
  for (const completion of completions) {
    if (await isCompletionVisible(ctx, workspace, completion, cache)) {
      visible.push(completion);
    }
  }
  return visible;
}

/**
 * Filter telemetry rows without allowing an un-attributed Chatroom trace to
 * become visible as a Gateway trace. A hidden Chatroom sibling also hides a
 * no-chat nested Gateway trace with the same request id.
 */
export async function filterVisibleTraces(
  ctx: DatabaseCtx,
  workspace: Doc<"workspaces">,
  traces: Doc<"telemetry_traces">[],
): Promise<Doc<"telemetry_traces">[]> {
  const cache = new Map<string, boolean>();
  const chatroomVisibilityByRequest = new Map<string, boolean>();

  for (const trace of traces) {
    if (trace.source !== "chatroom") continue;
    const visible =
      trace.chatId !== undefined &&
      (await isChatVisibleToWorkspace(ctx, workspace._id, trace.chatId, cache)) &&
      (await isTraceCompletionVisible(ctx, workspace, trace, cache));
    const previous = chatroomVisibilityByRequest.get(trace.requestId);
    chatroomVisibilityByRequest.set(
      trace.requestId,
      previous === undefined ? visible : previous && visible,
    );
  }

  const visible: Doc<"telemetry_traces">[] = [];
  for (const trace of traces) {
    if (!traceBelongsToWorkspace(trace, workspace)) continue;
    if (!(await isTraceCompletionVisible(ctx, workspace, trace, cache))) continue;
    if (trace.chatId !== undefined) {
      if (await isChatVisibleToWorkspace(ctx, workspace._id, trace.chatId, cache)) {
        visible.push(trace);
      }
      continue;
    }

    if (
      isOwnerManagedGatewayTrace(trace, workspace.ownerId) &&
      chatroomVisibilityByRequest.get(trace.requestId) !== false
    ) {
      visible.push(trace);
    }
  }
  return visible;
}

async function isTraceCompletionVisible(
  ctx: DatabaseCtx,
  workspace: Doc<"workspaces">,
  trace: Doc<"telemetry_traces">,
  cache: VisibilityCache,
): Promise<boolean> {
  if (trace.chatCompletionId === undefined) return true;
  const completion = await ctx.db.get("chat_completions", trace.chatCompletionId);
  return (
    completion !== null &&
    (await isCompletionVisible(ctx, workspace, completion as AttributedCompletion, cache))
  );
}

function traceBelongsToWorkspace(trace: Doc<"telemetry_traces">, workspace: Doc<"workspaces">) {
  if (trace.workspace !== undefined && trace.workspace !== workspace._id) return false;
  if (trace.balance !== undefined && trace.balance !== workspace.legacyBalance) return false;
  return trace.workspace !== undefined || trace.balance !== undefined;
}

/**
 * Detail reads need the same sibling check as list reads, otherwise a direct
 * request for a nested no-chat Gateway trace could bypass the list filter.
 */
export async function isTraceVisible(
  ctx: DatabaseCtx,
  workspace: Doc<"workspaces">,
  trace: Doc<"telemetry_traces">,
): Promise<boolean> {
  if (trace.chatId !== undefined || trace.source !== "gateway") {
    return (await filterVisibleTraces(ctx, workspace, [trace])).length === 1;
  }

  const related = await tracesWithRequestId(ctx, workspace, trace.requestId);
  const candidates = new Map(related.map((item) => [item._id, item]));
  candidates.set(trace._id, trace);
  const visible = await filterVisibleTraces(ctx, workspace, [...candidates.values()]);
  return visible.some((item) => item._id === trace._id);
}

async function tracesWithRequestId(
  ctx: DatabaseCtx,
  workspace: Doc<"workspaces">,
  requestId: string,
) {
  const current = await ctx.db
    .query("telemetry_traces")
    .withIndex("by_workspace_and_requestId", (q) =>
      q.eq("workspace", workspace._id).eq("requestId", requestId),
    )
    .take(101);

  if (!workspace.legacyBalance) return current;

  const legacy = await ctx.db
    .query("telemetry_traces")
    .withIndex("by_balance_and_requestId", (q) =>
      q.eq("balance", workspace.legacyBalance!).eq("requestId", requestId),
    )
    .take(101);
  const byId = new Map(current.map((trace) => [trace._id, trace]));
  for (const trace of legacy) byId.set(trace._id, trace);
  return [...byId.values()];
}
