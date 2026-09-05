import { v } from "convex/values";
import { query } from "./_generated/server";
import { requireOwnedBalance } from "./keys";

/**
 * Read-only credits summary for a balance: the current credit total plus a
 * window of recent completions used to render spend. There is no top-up
 * mutation yet — credits are adjusted by the billing pipeline in
 * `convex/key.ts` (`billKey`).
 */
export const getCredits = query({
  args: {
    balance: v.id("balances"),
    /** How many recent completions to summarise (defaults to 50). */
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const balance = await requireOwnedBalance(ctx, args.balance);

    const completions = await ctx.db
      .query("chat_completions")
      .withIndex("by_balance", (q) => q.eq("bill.balance", args.balance))
      .order("desc")
      .take(Math.min(args.limit ?? 50, 200));

    const recent = completions.map((completion) => ({
      _id: completion._id,
      _creationTime: completion._creationTime,
      provider: completion.request.provider,
      byok: completion.request.byok,
      cost: completion.response.pricing.cost,
      usage: {
        prompt_tokens: completion.response.usage.prompt_tokens,
        completion_tokens: completion.response.usage.completion_tokens,
      },
    }));

    const spent = recent.reduce((total, completion) => total + completion.cost, 0);

    return {
      credits: balance.credits,
      completions: recent.length,
      spentRecent: spent,
      recent,
    };
  },
});
