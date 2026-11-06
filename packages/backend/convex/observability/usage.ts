import { v } from "convex/values";
import { query } from "../_generated/server";
import { requireOwnedWorkspace } from "../workspaces";
import { credentialDisplayName } from "../../src/workspaces/credentials";
import { completionsForWorkspace } from "../../src/usage/activity";

export { getActivity } from "../../src/usage/activity";

/** Recent owner-visible usage estimates; this is not a balance or billing read. */
export const getUsage = query({
  args: {
    workspace: v.id("workspaces"),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const workspace = await requireOwnedWorkspace(ctx, args.workspace);
    const limit = Math.min(Math.max(args.limit ?? 50, 1), 200);
    const completions = await completionsForWorkspace(ctx, workspace, undefined, limit * 2, limit);
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
      spentRecent: recent.reduce((total, completion) => total + (completion.cost ?? 0), 0),
      unknownCostRequests: recent.filter((completion) => completion.cost === undefined).length,
      recent,
    };
  },
});

/** Per-generation usage metadata for the workspace owner; members have no general Gateway access. */
export const getGenerations = query({
  args: {
    workspace: v.id("workspaces"),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const workspace = await requireOwnedWorkspace(ctx, args.workspace);
    const limit = Math.min(Math.max(args.limit ?? 100, 1), 200);
    const completions = await completionsForWorkspace(ctx, workspace, undefined, limit * 2, limit);

    return Promise.all(
      completions.map(async (completion) => {
        const model = await ctx.db.get("models", completion.request.model);
        const apiKey = completion.bill.apiKey
          ? await ctx.db.get("api_keys", completion.bill.apiKey)
          : null;
        const legacyKey =
          !apiKey && completion.bill.key ? await ctx.db.get("keys", completion.bill.key) : null;
        const key = apiKey ?? legacyKey;
        const credential = completion.request.credential
          ? await ctx.db.get("workspace_credentials", completion.request.credential)
          : null;
        return {
          _id: completion._id,
          _creationTime: completion._creationTime,
          apiKey: key ? { name: key.name, preview: key.preview } : null,
          request: {
            provider: completion.request.provider,
            /** Absent when the credential was removed, legacy, or the row predates pools. */
            credentialName: credential ? credentialDisplayName(credential) : undefined,
            byok: completion.request.byok,
            streamed: completion.request.streamed,
            canceled: completion.request.canceled,
            model: model ? { id: model._id, name: model.name, slug: model.slug } : null,
          },
          response: completion.response,
        };
      }),
    );
  },
});
