import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";

const namespaceValidator = v.union(v.literal("session"), v.literal("rate_limit"));

export const getState = internalQuery({
  args: {
    provider: v.string(),
    namespace: namespaceValidator,
    key: v.string(),
  },
  handler: async (ctx, args) => {
    const entry = await ctx.db
      .query("subscription_state")
      .withIndex("by_provider_namespace_key", (q) =>
        q.eq("provider", args.provider).eq("namespace", args.namespace).eq("key", args.key),
      )
      .unique();

    if (!entry || (entry.expiresAt !== undefined && entry.expiresAt <= Date.now())) {
      return undefined;
    }
    return entry.value;
  },
});

export const setState = internalMutation({
  args: {
    provider: v.string(),
    namespace: namespaceValidator,
    key: v.string(),
    value: v.any(),
    expiresAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("subscription_state")
      .withIndex("by_provider_namespace_key", (q) =>
        q.eq("provider", args.provider).eq("namespace", args.namespace).eq("key", args.key),
      )
      .unique();
    const value = {
      provider: args.provider,
      namespace: args.namespace,
      key: args.key,
      value: args.value,
      expiresAt: args.expiresAt,
    };

    if (existing) {
      await ctx.db.replace(existing._id, value);
    } else {
      await ctx.db.insert("subscription_state", value);
    }
  },
});

export const deleteState = internalMutation({
  args: {
    provider: v.string(),
    namespace: namespaceValidator,
    key: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("subscription_state")
      .withIndex("by_provider_namespace_key", (q) =>
        q.eq("provider", args.provider).eq("namespace", args.namespace).eq("key", args.key),
      )
      .unique();
    if (existing) await ctx.db.delete(existing._id);
  },
});
