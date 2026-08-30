import { v } from "convex/values";
import { query } from "./_generated/server";
import { requireOwnedBalance } from "./keys";

/**
 * Per-generation logs for a balance: the full request/response metadata for each
 * billed completion, used to render the gateway's Generation Logs view.
 *
 * Unlike {@link api.credits.getCredits} — which only summarises spend — this
 * returns the complete persisted metadata for every generation (provider,
 * generation IDs, token usage, pricing breakdown, latency, finish reason).
 */
export const getGenerations = query({
  args: {
    balance: v.id("balances"),
    /** How many recent generations to return (defaults to 100, capped at 200). */
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireOwnedBalance(ctx, args.balance);

    const completions = await ctx.db
      .query("chat_completions")
      .withIndex("by_balance", (q) => q.eq("bill.balance", args.balance))
      .order("desc")
      .take(Math.min(args.limit ?? 100, 200));

    return Promise.all(
      completions.map(async (completion) => {
        const model = await ctx.db.get("models", completion.request.model);
        const key = completion.bill.key ? await ctx.db.get("keys", completion.bill.key) : null;
        return {
          _id: completion._id,
          _creationTime: completion._creationTime,
          apiKey: key ? { name: key.name, preview: key.preview } : null,
          request: {
            provider: completion.request.provider,
            byok: completion.request.byok,
            streamed: completion.request.streamed,
            canceled: completion.request.canceled,
            model: model ? { id: model._id, name: model.name, slug: model.slug } : null,
          },
          response: completion.response,
          // @todo Surface the full request payload — system message, tools,
          // tool calls, and user/assistant messages — once `chat_completions`
          // persists it. This will be opt-in since transcripts can be large and
          // may contain sensitive content (à la the AI SDK Devtools).
        };
      }),
    );
  },
});
