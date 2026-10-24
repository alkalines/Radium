import { v } from "convex/values";
import { mutation, query, type MutationCtx, type QueryCtx } from "../../convex/_generated/server";
import { authComponent } from "../../convex/auth";

/**
 * Per-user interface preferences keyed by the Better Auth user ID. They follow the user across
 * workspaces and never grant model access: pickers still list only workspace-configured models.
 */

const MAX_PREFERRED_MODELS = 200;
const MAX_MODEL_SLUG_LENGTH = 200;

const modelPreferencesValidator = v.object({
  pinnedModels: v.array(v.string()),
  hiddenModels: v.array(v.string()),
});

type ModelPreferenceList = "pinnedModels" | "hiddenModels";

async function findUserPreferences(ctx: QueryCtx | MutationCtx, userId: string) {
  return await ctx.db
    .query("user_preferences")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .unique();
}

/**
 * Add or remove a model slug from one preference list for the signed-in user. Pinned and hidden
 * are mutually exclusive, so adding to one list removes the slug from the other. Lists stay
 * deduplicated, keep insertion order, and are capped; repeating a call is a no-op.
 */
async function setModelPreference(
  ctx: MutationCtx,
  model: string,
  list: ModelPreferenceList,
  enabled: boolean,
): Promise<null> {
  const identity = await authComponent.getAuthUser(ctx);
  if (!identity) throw new Error("Not logged in.");

  if (model.length === 0 || model.length > MAX_MODEL_SLUG_LENGTH) {
    throw new Error("Invalid model.");
  }

  const row = await findUserPreferences(ctx, identity._id);
  if (!row && !enabled) return null;

  const current = {
    pinnedModels: row?.pinnedModels ?? [],
    hiddenModels: row?.hiddenModels ?? [],
  };
  const next = { ...current };
  const opposite: ModelPreferenceList = list === "pinnedModels" ? "hiddenModels" : "pinnedModels";

  if (enabled) {
    if (!current[list].includes(model)) {
      if (current[list].length >= MAX_PREFERRED_MODELS) {
        throw new Error("Model preference limit reached.");
      }
      next[list] = [...current[list], model];
    }
    next[opposite] = current[opposite].filter((slug) => slug !== model);
  } else {
    next[list] = current[list].filter((slug) => slug !== model);
  }

  if (row) {
    await ctx.db.patch("user_preferences", row._id, next);
  } else {
    await ctx.db.insert("user_preferences", { userId: identity._id, ...next });
  }
  return null;
}

/** Read the caller's pinned and hidden model slugs; empty lists when signed out or unset. */
export const get = query({
  args: {},
  returns: modelPreferencesValidator,
  handler: async (ctx) => {
    const identity = await authComponent.safeGetAuthUser(ctx);
    if (!identity) return { pinnedModels: [], hiddenModels: [] };

    const row = await findUserPreferences(ctx, identity._id);
    return {
      pinnedModels: row?.pinnedModels ?? [],
      hiddenModels: row?.hiddenModels ?? [],
    };
  },
});

/** Pin or unpin a model slug for the caller. Pinning also un-hides it. */
export const setModelPinned = mutation({
  args: { model: v.string(), pinned: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args) =>
    await setModelPreference(ctx, args.model, "pinnedModels", args.pinned),
});

/** Hide or unhide a model slug for the caller. Hiding also un-pins it. */
export const setModelHidden = mutation({
  args: { model: v.string(), hidden: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args) =>
    await setModelPreference(ctx, args.model, "hiddenModels", args.hidden),
});
