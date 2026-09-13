import { v } from "convex/values";
import { query, type QueryCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { requireOwnedWorkspace } from "./workspaces";

async function recentCompletions(ctx: QueryCtx, workspace: Doc<"workspaces">, limit: number) {
  const current = await ctx.db
    .query("chat_completions")
    .withIndex("by_workspace", (q) => q.eq("bill.workspace", workspace._id))
    .order("desc")
    .take(limit);
  if (!workspace.legacyBalance) return current;
  const legacy = await ctx.db
    .query("chat_completions")
    .withIndex("by_balance", (q) => q.eq("bill.balance", workspace.legacyBalance!))
    .order("desc")
    .take(limit);
  const byId = new Map(current.map((completion) => [completion._id, completion]));
  for (const completion of legacy) byId.set(completion._id, completion);
  return [...byId.values()].sort((a, b) => b._creationTime - a._creationTime).slice(0, limit);
}

/** Read-only BYOK usage summary for a workspace. Usage is not a quota or balance. */
export const getUsage = query({
  args: {
    workspace: v.id("workspaces"),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const workspace = await requireOwnedWorkspace(ctx, args.workspace);
    const completions = await recentCompletions(
      ctx,
      workspace,
      Math.min(Math.max(args.limit ?? 50, 1), 200),
    );

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

    return {
      completions: recent.length,
      spentRecent: recent.reduce((total, completion) => total + completion.cost, 0),
      recent,
    };
  },
});
