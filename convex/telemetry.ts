import { v } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { requireOwnedBalance, requireUserId } from "./keys";
import { completionTelemetrySchema, telemetrySettingsSchema } from "./telemetry_schemas";

const defaultSettings = {
  enabled: false,
  recordInputs: false,
  recordOutputs: false,
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

/** List recent completions that include AI SDK chat context. */
export const listTraces = query({
  args: {
    balance: v.id("balances"),
    since: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireOwnedBalance(ctx, args.balance);
    const limit = Math.min(Math.max(args.limit ?? 100, 1), 200);
    return await ctx.db
      .query("chat_completions")
      .withIndex("by_balance_and_telemetry_startedAt", (q) =>
        q.eq("bill.balance", args.balance).gte("telemetry.startedAt", args.since ?? 0),
      )
      .order("desc")
      .take(limit);
  },
});

/** Return one completion with its optional AI SDK chat context. */
export const getTrace = query({
  args: { traceId: v.id("chat_completions") },
  handler: async (ctx, args) => {
    const completion = await ctx.db.get("chat_completions", args.traceId);
    if (!completion) return null;
    await requireOwnedBalance(ctx, completion.bill.balance);
    return completion;
  },
});

/** Aggregate bounded metrics from canonical completion fields. */
export const getSummary = query({
  args: { balance: v.id("balances"), since: v.number() },
  handler: async (ctx, args) => {
    await requireOwnedBalance(ctx, args.balance);
    const limit = 2000;
    const completions = await ctx.db
      .query("chat_completions")
      .withIndex("by_balance", (q) =>
        q.eq("bill.balance", args.balance).gte("_creationTime", args.since),
      )
      .order("desc")
      .take(limit + 1);
    const windowed = completions.slice(0, limit);
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

    for (const completion of windowed) {
      if (completion.request.canceled) summary.aborted++;
      else summary.successful++;
      const usage = completion.response.usage;
      const durationMs = completion.telemetry?.durationMs ?? completion.response.gen_time;
      const totalTokens = usage.prompt_tokens + usage.completion_tokens;
      durationTotal += durationMs;
      summary.inputTokens += usage.prompt_tokens;
      summary.outputTokens += usage.completion_tokens;
      summary.totalTokens += totalTokens;
      summary.steps += completion.telemetry ? 1 : 0;
      summary.toolCalls += completion.telemetry?.tools.length ?? 0;

      const date = new Date(completion._creationTime).toISOString().slice(0, 10);
      const day = daily.get(date) ?? {
        date,
        traces: 0,
        errors: 0,
        durationMs: 0,
        tokens: 0,
      };
      day.traces++;
      day.durationMs += durationMs;
      day.tokens += totalTokens;
      daily.set(date, day);
    }
    summary.averageDurationMs = windowed.length ? durationTotal / windowed.length : 0;

    return {
      summary,
      daily: [...daily.values()].sort((a, b) => a.date.localeCompare(b.date)),
      truncated: completions.length > limit,
    };
  },
});

/** Remove optional AI SDK context without deleting the completion. */
export const deleteTrace = mutation({
  args: { traceId: v.id("chat_completions") },
  handler: async (ctx, args) => {
    const completion = await ctx.db.get("chat_completions", args.traceId);
    if (!completion) return;
    await requireOwnedBalance(ctx, completion.bill.balance);
    await ctx.db.patch("chat_completions", completion._id, { telemetry: undefined });
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

export const attachChatSteps = internalMutation({
  args: {
    chatId: v.id("aisdk_chats"),
    contexts: v.array(
      v.object({
        completionId: v.id("chat_completions"),
        telemetry: completionTelemetrySchema,
      }),
    ),
  },
  handler: async (ctx, args) => {
    const chat = await ctx.db.get("aisdk_chats", args.chatId);
    if (!chat) return;
    for (const context of args.contexts) {
      const completion = await ctx.db.get("chat_completions", context.completionId);
      if (
        !completion ||
        completion.bill.balance !== chat.balance ||
        completion.bill.userId !== chat.userId ||
        !chat.chat_completions.includes(completion._id) ||
        context.telemetry.chatId !== chat._id
      ) {
        continue;
      }
      await ctx.db.patch("chat_completions", completion._id, {
        telemetry: context.telemetry,
      });
    }
  },
});

export const attachCompletionStep = internalMutation({
  args: {
    completionId: v.id("chat_completions"),
    telemetry: completionTelemetrySchema,
  },
  handler: async (ctx, args) => {
    const completion = await ctx.db.get("chat_completions", args.completionId);
    if (!completion) return;
    if (args.telemetry.chatId) {
      const chat = await ctx.db.get("aisdk_chats", args.telemetry.chatId);
      if (
        !chat ||
        chat.balance !== completion.bill.balance ||
        chat.userId !== completion.bill.userId ||
        !chat.chat_completions.includes(completion._id)
      ) {
        return;
      }
    }
    await ctx.db.patch("chat_completions", completion._id, {
      telemetry: args.telemetry,
    });
  },
});
