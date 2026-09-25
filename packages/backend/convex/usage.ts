import { v } from "convex/values";
import { type QueryCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { requireOwnedWorkspace } from "./workspaces";
import { workspaceQuery } from "./auth";
import { filterVisibleCompletions, type AttributedCompletion } from "./chat_observability";

async function recentCompletions(
  ctx: QueryCtx,
  workspace: Doc<"workspaces">,
  readLimit: number,
  outputLimit = readLimit,
) {
  const current = await ctx.db
    .query("chat_completions")
    .withIndex("by_workspace", (q) => q.eq("bill.workspace", workspace._id))
    .order("desc")
    .take(readLimit);
  const legacy = workspace.legacyBalance
    ? await ctx.db
        .query("chat_completions")
        .withIndex("by_balance", (q) => q.eq("bill.balance", workspace.legacyBalance!))
        .order("desc")
        .take(readLimit)
    : [];
  const byId = new Map(current.map((completion) => [completion._id, completion]));
  for (const completion of legacy) byId.set(completion._id, completion);
  const visible = await filterVisibleCompletions(ctx, workspace, [
    ...byId.values(),
  ] as AttributedCompletion[]);
  return visible.sort((a, b) => b._creationTime - a._creationTime).slice(0, outputLimit);
}

/** Read-only usage summary for the owner; members have no general Gateway access. */
export const getUsage = workspaceQuery({
  role: "owner",
  args: {
    workspace: v.id("workspaces"),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const workspace = await requireOwnedWorkspace(ctx, args.workspace);
    const limit = Math.min(Math.max(args.limit ?? 50, 1), 200);
    const completions = await recentCompletions(ctx, workspace, limit * 2, limit);

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

    // Persisted costs are operational estimates, not billing or debits.
    return {
      completions: recent.length,
      spentRecent: recent.reduce((total, completion) => total + completion.cost, 0),
      recent,
    };
  },
});
