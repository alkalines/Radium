import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import {
  getDefaultWorkspaceForUser,
  requireOwnedWorkspace,
  requireWorkspaceAccessForUser,
} from "./workspaces";
import { ownerMutation, ownerQuery, authenticatedMutation, authenticatedQuery, internalMemberMutation } from "./function_auth";
import { getEffectiveWorkspaceSettings, materializeWorkspaceSettings } from "./chatroom";
import { preferChatroomTraces, summarizeTraces } from "../src/telemetry/summary";
import {
  filterVisibleTraces,
  isCompletionVisible,
  isTraceVisible,
  type AttributedCompletion,
} from "./chat_observability";
import {
  telemetrySettingsSchema,
  telemetrySourceSchema,
  telemetrySpanKindSchema,
  telemetryStatusSchema,
  telemetryUsageSchema,
} from "../src/telemetry/validators";

const defaultSettings = {
  enabled: false,
  recordInputs: false,
  recordOutputs: false,
};

const traceFields = {
  status: v.optional(telemetryStatusSchema),
  endedAt: v.optional(v.number()),
  durationMs: v.optional(v.number()),
  finishReason: v.optional(v.string()),
  usage: v.optional(telemetryUsageSchema),
  stepCount: v.optional(v.number()),
  toolCallCount: v.optional(v.number()),
  error: v.optional(v.string()),
  outputJson: v.optional(v.string()),
};

const spanFields = {
  kind: telemetrySpanKindSchema,
  name: v.string(),
  status: telemetryStatusSchema,
  startedAt: v.number(),
  endedAt: v.number(),
  durationMs: v.number(),
  provider: v.optional(v.string()),
  model: v.optional(v.string()),
  stepNumber: v.optional(v.number()),
  toolName: v.optional(v.string()),
  toolCallId: v.optional(v.string()),
  finishReason: v.optional(v.string()),
  usage: v.optional(telemetryUsageSchema),
  error: v.optional(v.string()),
  inputJson: v.optional(v.string()),
  outputJson: v.optional(v.string()),
};

async function workspaceSettings(ctx: QueryCtxOrMutationCtx, workspace: Id<"workspaces">) {
  return await ctx.db
    .query("workspace_settings")
    .withIndex("by_workspace", (q) => q.eq("workspace", workspace))
    .first();
}

type QueryCtxOrMutationCtx = Parameters<typeof requireOwnedWorkspace>[0];

/** Read workspace AI SDK telemetry preferences; Gateway management is owner-only. */
export const getSettings = ownerQuery({
  args: { workspace: v.id("workspaces") },
  handler: async (ctx, args) => {
    const workspace = await requireOwnedWorkspace(ctx, args.workspace);
    return (await getEffectiveWorkspaceSettings(ctx, workspace)).telemetry ?? defaultSettings;
  },
});

/** Configure owner-only workspace AI SDK telemetry. Collection remains disabled by default. */
export const setSettings = ownerMutation({
  args: { workspace: v.id("workspaces"), ...telemetrySettingsSchema.fields },
  handler: async (ctx, args) => {
    const workspace = await requireOwnedWorkspace(ctx, args.workspace);
    const existing = await workspaceSettings(ctx, args.workspace);
    const telemetry = {
      enabled: args.enabled,
      recordInputs: args.enabled && args.recordInputs,
      recordOutputs: args.enabled && args.recordOutputs,
    };

    if (existing) {
      await ctx.db.patch("workspace_settings", existing._id, { telemetry });
      return existing._id;
    }
    return await ctx.db.insert(
      "workspace_settings",
      materializeWorkspaceSettings(await getEffectiveWorkspaceSettings(ctx, workspace), {
        telemetry,
      }),
    );
  },
});

async function tracesForWorkspace(
  ctx: QueryCtxOrMutationCtx,
  workspace: Doc<"workspaces">,
  since: number | undefined,
  readLimit: number,
  outputLimit = readLimit,
) {
  const traces =
    since !== undefined
      ? await ctx.db
          .query("telemetry_traces")
          .withIndex("by_workspace_and_startedAt", (q) =>
            q.eq("workspace", workspace._id).gte("startedAt", since),
          )
          .order("desc")
          .take(readLimit)
      : await ctx.db
          .query("telemetry_traces")
          .withIndex("by_workspace_and_startedAt", (q) => q.eq("workspace", workspace._id))
          .order("desc")
          .take(readLimit);

  const legacy = workspace.legacyBalance
    ? since !== undefined
      ? await ctx.db
          .query("telemetry_traces")
          .withIndex("by_balance_and_startedAt", (q) =>
            q.eq("balance", workspace.legacyBalance!).gte("startedAt", since),
          )
          .order("desc")
          .take(readLimit)
      : await ctx.db
          .query("telemetry_traces")
          .withIndex("by_balance_and_startedAt", (q) => q.eq("balance", workspace.legacyBalance!))
          .order("desc")
          .take(readLimit)
    : [];
  const byId = new Map(traces.map((trace) => [trace._id, trace]));
  for (const trace of legacy) byId.set(trace._id, trace);
  const visible = await filterVisibleTraces(ctx, workspace, [...byId.values()]);
  return visible.sort((a, b) => b.startedAt - a.startedAt).slice(0, outputLimit);
}

/** List recent owner-visible workspace requests, preferring the parent Chatroom trace. */
export const listTraces = ownerQuery({
  args: {
    workspace: v.id("workspaces"),
    since: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const workspace = await requireOwnedWorkspace(ctx, args.workspace);
    const limit = Math.min(Math.max(args.limit ?? 100, 1), 200);
    const traces = await tracesForWorkspace(ctx, workspace, args.since, limit * 2);
    return preferChatroomTraces(traces).slice(0, limit);
  },
});

async function requireOwnedTrace(ctx: QueryCtxOrMutationCtx, traceId: Id<"telemetry_traces">) {
  const trace = await ctx.db.get("telemetry_traces", traceId);
  if (!trace) throw new Error("Trace not found.");

  const workspace = trace.workspace
    ? await ctx.db.get("workspaces", trace.workspace)
    : trace.balance
      ? await ctx.db
          .query("workspaces")
          .withIndex("by_legacyBalance", (q) => q.eq("legacyBalance", trace.balance!))
          .first()
      : null;
  if (!workspace) {
    throw new Error("Trace not found.");
  }
  await requireOwnedWorkspace(ctx, workspace._id);
  if (!(await isTraceVisible(ctx, workspace, trace))) throw new Error("Trace not found.");
  return { trace, workspace };
}

/** Return one owner-visible trace and its ordered child spans; members have no general Gateway access. */
export const getTrace = authenticatedQuery({
  args: { traceId: v.id("telemetry_traces") },
  handler: async (ctx, args) => {
    const { trace, workspace } = await requireOwnedTrace(ctx, args.traceId);
    const spans = await ctx.db
      .query("telemetry_spans")
      .withIndex("by_trace_and_startedAt", (q) => q.eq("trace", trace._id))
      .take(101);
    const payloads = await ctx.db
      .query("telemetry_payloads")
      .withIndex("by_trace", (q) => q.eq("trace", trace._id))
      .take(102);
    const truncated = spans.length > 100 || payloads.length > 101;
    const windowedSpans = spans.slice(0, 100);
    const windowedPayloads = payloads.slice(0, 101);
    const rootPayload = windowedPayloads.find((payload) => payload.span === undefined);
    const payloadsBySpan = new Map(
      windowedPayloads.filter((payload) => payload.span).map((payload) => [payload.span!, payload]),
    );
    const storedCompletion = trace.chatCompletionId
      ? await ctx.db.get("chat_completions", trace.chatCompletionId)
      : null;
    const completion =
      storedCompletion &&
      (await isCompletionVisible(ctx, workspace, storedCompletion as AttributedCompletion))
        ? storedCompletion
        : null;
    const completionModel = completion
      ? await ctx.db.get("models", completion.request.model)
      : null;
    return {
      trace,
      spans: windowedSpans.map((span) => ({
        ...span,
        inputJson: payloadsBySpan.get(span._id)?.inputJson,
        outputJson: payloadsBySpan.get(span._id)?.outputJson,
      })),
      inputJson: rootPayload?.inputJson,
      outputJson: rootPayload?.outputJson,
      completion: completion
        ? {
            ...completion,
            model: completionModel
              ? { _id: completionModel._id, name: completionModel.name, slug: completionModel.slug }
              : null,
          }
        : null,
      truncated,
    };
  },
});

/** Aggregate bounded telemetry metrics for the owner only; members have no general Gateway access. */
export const getSummary = ownerQuery({
  args: { workspace: v.id("workspaces"), since: v.number() },
  handler: async (ctx, args) => {
    const workspace = await requireOwnedWorkspace(ctx, args.workspace);
    const traces = await tracesForWorkspace(ctx, workspace, args.since, 2001);
    return {
      ...summarizeTraces(traces.slice(0, 2000)),
      truncated: traces.length > 2000,
    };
  },
});

/** Delete one owner-visible trace and its bounded child payloads/spans; members have no general Gateway access. */
export const deleteTrace = authenticatedMutation({
  args: { traceId: v.id("telemetry_traces") },
  handler: async (ctx, args) => {
    const { trace } = await requireOwnedTrace(ctx, args.traceId);
    const spans = await ctx.db
      .query("telemetry_spans")
      .withIndex("by_trace_and_startedAt", (q) => q.eq("trace", trace._id))
      .take(101);
    const payloads = await ctx.db
      .query("telemetry_payloads")
      .withIndex("by_trace", (q) => q.eq("trace", trace._id))
      .take(102);
    await Promise.all(payloads.map((payload) => ctx.db.delete("telemetry_payloads", payload._id)));
    await Promise.all(spans.map((span) => ctx.db.delete("telemetry_spans", span._id)));
    await ctx.db.delete("telemetry_traces", trace._id);
  },
});

export const getSettingsForUser = internalQuery({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    const workspace = await getDefaultWorkspaceForUser(ctx, args.userId);
    if (!workspace) return defaultSettings;
    return (await getEffectiveWorkspaceSettings(ctx, workspace)).telemetry ?? defaultSettings;
  },
});

export const getSettingsForWorkspace = internalQuery({
  args: { workspace: v.id("workspaces") },
  handler: async (ctx, args) => {
    const workspace = await ctx.db.get("workspaces", args.workspace);
    if (!workspace || workspace.archivedAt !== undefined) return defaultSettings;
    return (await getEffectiveWorkspaceSettings(ctx, workspace)).telemetry ?? defaultSettings;
  },
});

export const startTrace = internalMemberMutation({
  args: {
    workspace: v.id("workspaces"),
    apiKey: v.optional(v.id("api_keys")),
    /** Transitional attribution for traces emitted before migration. */
    balance: v.optional(v.id("balances")),
    key: v.optional(v.id("keys")),
    userId: v.string(),
    chatId: v.optional(v.id("aisdk_chats")),
    source: telemetrySourceSchema,
    requestId: v.string(),
    callId: v.string(),
    operationId: v.string(),
    functionId: v.string(),
    provider: v.string(),
    model: v.string(),
    startedAt: v.number(),
    recordsInputs: v.boolean(),
    recordsOutputs: v.boolean(),
    inputJson: v.optional(v.string()),
  },
  handler: async (ctx, { inputJson, ...args }) => {
    const workspace = await requireWorkspaceAccessForUser(ctx, args.workspace, args.userId);
    if (args.apiKey) {
      const apiKey = await ctx.db.get("api_keys", args.apiKey);
      if (!apiKey || apiKey.workspace !== args.workspace) {
        throw new Error("Telemetry key mismatch.");
      }
    }
    if (args.balance) {
      const balance = await ctx.db.get("balances", args.balance);
      if (!balance || workspace.legacyBalance !== args.balance) {
        throw new Error("Legacy telemetry owner mismatch.");
      }
    }
    if (args.key) {
      const key = await ctx.db.get("keys", args.key);
      if (!key || !args.balance || key.balance !== args.balance) {
        throw new Error("Telemetry legacy key mismatch.");
      }
    }
    if (args.chatId) {
      const chat: { workspace: Doc<"workspaces"> } | null = await ctx.runQuery(
        internal.workspaces.authorizeChatForUser,
        { chatId: args.chatId, userId: args.userId },
      );
      if (!chat || chat.workspace._id !== args.workspace) {
        throw new Error("Telemetry chat mismatch.");
      }
    } else if (args.source === "chatroom") {
      throw new Error("Chatroom telemetry requires chat attribution.");
    }

    const trace = await ctx.db.insert("telemetry_traces", {
      ...args,
      status: "running",
    });
    if (inputJson !== undefined) {
      await ctx.db.insert("telemetry_payloads", { trace, inputJson });
    }
    return trace;
  },
});

export const finishTrace = internalMutation({
  args: {
    traceId: v.id("telemetry_traces"),
    spans: v.array(v.object(spanFields)),
    ...traceFields,
  },
  handler: async (ctx, { traceId, spans, outputJson, ...fields }) => {
    const trace = await ctx.db.get("telemetry_traces", traceId);
    if (!trace) return;
    await ctx.db.patch("telemetry_traces", traceId, fields);

    const rootPayload = await ctx.db
      .query("telemetry_payloads")
      .withIndex("by_trace", (q) => q.eq("trace", traceId))
      .filter((q) => q.eq(q.field("span"), undefined))
      .unique();
    if (outputJson !== undefined) {
      if (rootPayload) await ctx.db.patch("telemetry_payloads", rootPayload._id, { outputJson });
      else await ctx.db.insert("telemetry_payloads", { trace: traceId, outputJson });
    }

    for (const { inputJson, outputJson: spanOutputJson, ...span } of spans) {
      const spanId = await ctx.db.insert("telemetry_spans", {
        trace: traceId,
        ...(trace.balance ? { balance: trace.balance } : {}),
        ...(trace.workspace ? { workspace: trace.workspace } : {}),
        ...span,
      });
      if (inputJson !== undefined || spanOutputJson !== undefined) {
        await ctx.db.insert("telemetry_payloads", {
          trace: traceId,
          span: spanId,
          inputJson,
          outputJson: spanOutputJson,
        });
      }
    }
  },
});
