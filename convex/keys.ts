import { v } from "convex/values";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { authComponent } from "./auth";
import { findUsableCredit, hashText } from "./key";

/**
 * Return the signed-in user's BetterAuth id, or throw. Shared gate for per-user
 * resources (chatroom settings, MCP servers).
 */
export async function requireUserId(ctx: QueryCtx | MutationCtx): Promise<string> {
  const identity = await authComponent.getAuthUser(ctx);
  if (!identity) throw new Error("Not logged in.");
  return identity._id;
}

/**
 * Load a balance and assert it belongs to the signed-in user. Shared ownership
 * gate for the gateway's per-balance resources (keys, credits, credentials).
 */
export async function requireOwnedBalance(ctx: QueryCtx | MutationCtx, balance: Id<"balances">) {
  const identity = await authComponent.getAuthUser(ctx);
  if (!identity) throw new Error("Not logged in.");

  const record = await ctx.db.get("balances", balance);
  if (!record || record.userId !== identity._id) throw new Error("Balance not found.");
  return record;
}

/**
 * Generate a fresh gateway API key and its masked preview. The full value is
 * returned to the caller exactly once; only the hash and preview are stored.
 */
function generateApiKey(): { key: string; preview: string } {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const body = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const key = `rad-sk-${body}`;
  return { key, preview: `rad-sk-…${body.slice(-4)}` };
}

/** List the signed-in user's API keys for a balance (never returns the secret). */
export const listKeys = query({
  args: {
    balance: v.id("balances"),
  },
  handler: async (ctx, args) => {
    const balance = await requireOwnedBalance(ctx, args.balance);

    const keys = await ctx.db
      .query("keys")
      .withIndex("by_balance", (q) => q.eq("balance", args.balance))
      .take(200);

    return keys.map((key) => ({
      _id: key._id,
      _creationTime: key._creationTime,
      name: key.name,
      preview: key.preview,
      creditLimit: key.creditLimit,
      usedCredits: key.usedCredits,
      usableCredits: findUsableCredit(balance.credits, key.usedCredits, key.creditLimit),
    }));
  },
});

/**
 * Create an API key for a balance and return the plaintext value once. Only the
 * SHA-512 hash and a masked preview are persisted.
 */
export const createKey = mutation({
  args: {
    balance: v.id("balances"),
    name: v.string(),
    creditLimit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireOwnedBalance(ctx, args.balance);

    const name = args.name.trim();
    if (!name) throw new Error("Key name is required.");
    if (args.creditLimit !== undefined && args.creditLimit < 0) {
      throw new Error("Credit limit cannot be negative.");
    }

    const { key, preview } = generateApiKey();
    const _id = await ctx.db.insert("keys", {
      balance: args.balance,
      name,
      hash: await hashText(key),
      preview,
      creditLimit: args.creditLimit,
      usedCredits: 0,
    });

    return { _id, key, preview };
  },
});

/** Rename a key or change its per-key credit limit. */
export const updateKey = mutation({
  args: {
    key: v.id("keys"),
    name: v.optional(v.string()),
    creditLimit: v.optional(v.union(v.number(), v.null())),
  },
  handler: async (ctx, args) => {
    const key = await ctx.db.get("keys", args.key);
    if (!key) throw new Error("Key not found.");
    await requireOwnedBalance(ctx, key.balance);

    const patch: { name?: string; creditLimit?: number | undefined } = {};
    if (args.name !== undefined) {
      const name = args.name.trim();
      if (!name) throw new Error("Key name is required.");
      patch.name = name;
    }
    if (args.creditLimit !== undefined) {
      if (args.creditLimit !== null && args.creditLimit < 0) {
        throw new Error("Credit limit cannot be negative.");
      }
      patch.creditLimit = args.creditLimit ?? undefined;
    }

    await ctx.db.patch("keys", args.key, patch);
  },
});

/** Permanently revoke an API key. */
export const deleteKey = mutation({
  args: {
    key: v.id("keys"),
  },
  handler: async (ctx, args) => {
    const key = await ctx.db.get("keys", args.key);
    if (!key) return true;
    await requireOwnedBalance(ctx, key.balance);

    await ctx.db.delete("keys", args.key);
    return true;
  },
});
