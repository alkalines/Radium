import { v } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { requireOwnedBalance, requireUserId } from "./keys";
import {
  telemetrySettingsSchema,
  telemetrySourceSchema,
  telemetrySpanKindSchema,
  telemetryStatusSchema,
  telemetryUsageSchema,
} from "./telemetry_schemas";

const defaultSettings = {
  enabled: false,
  recordInputs: false,
  recordOutputs: false,
};

function preferChatroomTraces<Trace extends { requestId: string; source: "chatroom" | "gateway" }>(
  traces: Trace[],
): Trace[] {
  const byRequest = new Map<string, Trace>();
  for (const trace of traces) {
    const current = byRequest.get(trace.requestId);
    if (!current || (trace.source === "chatroom" && current.source !== "chatroom")) {
      byRequest.set(trace.requestId, trace);
    }
  }
  return [...byRequest.values()];
}

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

/** Read the signed-in user's AI SDK telemetry preferences. */
export const getSettings = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    const settings = await ctx.db
      .query("chatroom_settings")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .unique();
    return settings?.telemetry ?? defaultSettings;
  },
});

/** Configure AI SDK telemetry. All collection remains disabled until explicitly enabled. */
export const setSettings = mutation({
  args: telemetrySettingsSchema.fields,
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const existing = await ctx.db
      .query("chatroom_settings")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .unique();
    const telemetry = {
      enabled: args.enabled,
      recordInputs: args.enabled && args.recordInputs,
      recordOutputs: args.enabled && args.recordOutputs,
    };

    if (existing) {
      await ctx.db.patch("chatroom_settings", existing._id, { telemetry });
      return existing._id;
    }
    return await ctx.db.insert("chatroom_settings", {
      userId,
      telemetry,
      builtinToolSets: [],
      mcpServers: [],
    });
  },
});

/** List recent requests, preferring the parent chatroom trace over its nested gateway trace. */
export const listTraces = query({
  args: {
    balance: v.id("balances"),
    since: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireOwnedBalance(ctx, args.balance);
    const limit = Math.min(Math.max(args.limit ?? 100, 1), 200);
    const traces = args.since
      ? await ctx.db
          .query("telemetry_traces")
          .withIndex("by_balance_and_startedAt", (q) =>
            q.eq("balance", args.balance).gte("startedAt", args.since!),
          )
          .order("desc")
          .take(limit * 2)
      : await ctx.db
          .query("telemetry_traces")
          .withIndex("by_balance_and_startedAt", (q) => q.eq("balance", args.balance))
          .order("desc")
          .take(limit * 2);

    return preferChatroomTraces(traces).slice(0, limit);
  },
});

/** Return one trace and its ordered child spans. */
export const getTrace = query({
  args: { traceId: v.id("telemetry_traces") },
  handler: async (ctx, args) => {
    const trace = await ctx.db.get("telemetry_traces", args.traceId);
    if (!trace) return null;
    await requireOwnedBalance(ctx, trace.balance);
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
    const completion = trace.chatCompletionId
      ? await ctx.db.get("chat_completions", trace.chatCompletionId)
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

/** Aggregate bounded telemetry metrics for a future reporting panel. */
export const getSummary = query({
  args: { balance: v.id("balances"), since: v.number() },
  handler: async (ctx, args) => {
    await requireOwnedBalance(ctx, args.balance);
    const limit = 2000;
    const traces = await ctx.db
      .query("telemetry_traces")
      .withIndex("by_balance_and_startedAt", (q) =>
        q.eq("balance", args.balance).gte("startedAt", args.since),
      )
      .order("desc")
      .take(limit + 1);
    const windowed = preferChatroomTraces(traces.slice(0, limit));
    const summary = {
      traces: windowed.length,
      successful: 0,
      errors: 0,
      aborted: 0,
      running: 0,
      averageDurationMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      steps: 0,
      toolCalls: 0,
    };
    const daily = new Map<
      string,
      { date: string; traces: number; errors: number; durationMs: number; tokens: number }
    >();
    let durationTotal = 0;
    let durationCount = 0;

    for (const trace of windowed) {
      if (trace.status === "ok") summary.successful++;
      else if (trace.status === "error") summary.errors++;
      else if (trace.status === "aborted") summary.aborted++;
      else summary.running++;
      if (trace.durationMs !== undefined) {
        durationTotal += trace.durationMs;
        durationCount++;
      }
      summary.inputTokens += trace.usage?.inputTokens ?? 0;
      summary.outputTokens += trace.usage?.outputTokens ?? 0;
      summary.totalTokens += trace.usage?.totalTokens ?? 0;
      summary.steps += trace.stepCount ?? 0;
      summary.toolCalls += trace.toolCallCount ?? 0;

      const date = new Date(trace.startedAt).toISOString().slice(0, 10);
      const day = daily.get(date) ?? {
        date,
        traces: 0,
        errors: 0,
        durationMs: 0,
        tokens: 0,
      };
      day.traces++;
      if (trace.status === "error") day.errors++;
      day.durationMs += trace.durationMs ?? 0;
      day.tokens += trace.usage?.totalTokens ?? 0;
      daily.set(date, day);
    }
    summary.averageDurationMs = durationCount ? durationTotal / durationCount : 0;

    return {
      summary,
      daily: [...daily.values()].sort((a, b) => a.date.localeCompare(b.date)),
      truncated: traces.length > limit,
    };
  },
});

/** Delete one owned trace and all of its spans. */
export const deleteTrace = mutation({
  args: { traceId: v.id("telemetry_traces") },
  handler: async (ctx, args) => {
    const trace = await ctx.db.get("telemetry_traces", args.traceId);
    if (!trace) return;
    await requireOwnedBalance(ctx, trace.balance);
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
    const settings = await ctx.db
      .query("chatroom_settings")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .unique();
    return settings?.telemetry ?? defaultSettings;
  },
});

export const startTrace = internalMutation({
  args: {
    balance: v.id("balances"),
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
    const balance = await ctx.db.get("balances", args.balance);
    if (!balance || balance.userId !== args.userId) throw new Error("Telemetry owner mismatch.");
    if (args.key) {
      const key = await ctx.db.get("keys", args.key);
      if (!key || key.balance !== args.balance) throw new Error("Telemetry key mismatch.");
    }
    if (args.chatId) {
      const chat = await ctx.db.get("aisdk_chats", args.chatId);
      if (!chat || chat.userId !== args.userId || chat.balance !== args.balance) {
        throw new Error("Telemetry chat mismatch.");
      }
    }

    const trace = await ctx.db.insert("telemetry_traces", { ...args, status: "running" });
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
        balance: trace.balance,
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
