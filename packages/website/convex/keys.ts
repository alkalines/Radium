import { v } from "convex/values";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { authComponent } from "./auth";
import { hashText, isRevokedKey } from "./key";
import { requireOwnedWorkspace } from "./workspaces";

/**
 * Return the signed-in user's Better Auth id, or throw. This remains separate
 * from workspace authorization for resources that are intentionally personal.
 */
export async function requireUserId(ctx: QueryCtx | MutationCtx): Promise<string> {
  const identity = await authComponent.getAuthUser(ctx);
  if (!identity) throw new Error("Not logged in.");
  return identity._id;
}

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

export type ListedKey =
  | {
      source: "workspace";
      _id: Id<"api_keys">;
      _creationTime: number;
      name: string;
      preview?: string;
    }
  | {
      source: "legacy";
      _id: Id<"keys">;
      _creationTime: number;
      name: string;
      preview?: string;
    };

/**
 * List active workspace and unmigrated legacy keys. The source tag is required
 * because Convex document IDs do not carry a runtime table discriminator.
 */
export const listKeys = query({
  args: { workspace: v.id("workspaces") },
  handler: async (ctx, args) => {
    const workspace = await requireOwnedWorkspace(ctx, args.workspace);

    const keys = await ctx.db
      .query("api_keys")
      .withIndex("by_workspace", (q) => q.eq("workspace", args.workspace))
      .take(200);

    const mappedLegacyKeys = new Set<Id<"keys">>();
    const activeKeys: ListedKey[] = [];
    for (const key of keys) {
      if (key.legacyKey !== undefined) mappedLegacyKeys.add(key.legacyKey);
      if (isRevokedKey(key)) continue;
      if (key.legacyKey !== undefined) {
        const legacyKey = await ctx.db.get("keys", key.legacyKey);
        if (
          !legacyKey ||
          isRevokedKey(legacyKey) ||
          !workspace.legacyBalance ||
          legacyKey.balance !== workspace.legacyBalance ||
          legacyKey.hash !== key.hash
        ) {
          continue;
        }
      }
      activeKeys.push({
        source: "workspace",
        _id: key._id,
        _creationTime: key._creationTime,
        name: key.name,
        preview: key.preview,
      });
    }

    if (workspace.legacyBalance) {
      const balance = await ctx.db.get("balances", workspace.legacyBalance);
      if (balance?.userId === workspace.ownerId) {
        const legacyKeys = await ctx.db
          .query("keys")
          .withIndex("by_balance", (q) => q.eq("balance", workspace.legacyBalance!))
          .take(200);

        for (const key of legacyKeys) {
          if (isRevokedKey(key) || mappedLegacyKeys.has(key._id)) continue;
          const mappings = await ctx.db
            .query("api_keys")
            .withIndex("by_legacyKey", (q) => q.eq("legacyKey", key._id))
            .take(1);
          if (mappings.length > 0) continue;
          activeKeys.push({
            source: "legacy",
            _id: key._id,
            _creationTime: key._creationTime,
            name: key.name,
            preview: key.preview,
          });
        }
      }
    }

    return activeKeys.sort((a, b) => b._creationTime - a._creationTime).slice(0, 200);
  },
});

/**
 * Create a workspace API key and return the plaintext value exactly once. Only
 * the SHA-512 hash and a masked preview are persisted.
 */
export const createKey = mutation({
  args: {
    workspace: v.id("workspaces"),
    name: v.string(),
  },
  handler: async (ctx, args) => {
    await requireOwnedWorkspace(ctx, args.workspace);

    const name = args.name.trim();
    if (!name) throw new Error("Key name is required.");

    const { key, preview } = generateApiKey();
    const _id = await ctx.db.insert("api_keys", {
      workspace: args.workspace,
      name,
      hash: await hashText(key),
      preview,
    });

    return { _id, key, preview };
  },
});

/** Rename a workspace API key. */
export const updateKey = mutation({
  args: {
    key: v.id("api_keys"),
    name: v.string(),
  },
  handler: async (ctx, args) => {
    const key = await ctx.db.get("api_keys", args.key);
    if (!key) throw new Error("Key not found.");
    await requireOwnedWorkspace(ctx, key.workspace);

    const name = args.name.trim();
    if (!name) throw new Error("Key name is required.");
    await ctx.db.patch("api_keys", args.key, { name });
  },
});

/** Permanently revoke a workspace API key. Historical completions retain their attribution. */
export const deleteKey = mutation({
  args: { key: v.id("api_keys") },
  handler: async (ctx, args) => {
    const key = await ctx.db.get("api_keys", args.key);
    if (!key) return true;
    await requireOwnedWorkspace(ctx, key.workspace);

    const revokedAt = Date.now();
    const legacyKey = key.legacyKey ? await ctx.db.get("keys", key.legacyKey) : null;
    const apiKeyRevocation = { revokedAt };
    await ctx.db.patch("api_keys", args.key, apiKeyRevocation);
    if (legacyKey) {
      const legacyKeyRevocation = { revokedAt };
      await ctx.db.patch("keys", legacyKey._id, legacyKeyRevocation);
    }
    return true;
  },
});

/** Revoke an unmigrated legacy key and every mapped workspace copy atomically. */
export const deleteLegacyKey = mutation({
  args: {
    workspace: v.id("workspaces"),
    keyId: v.id("keys"),
  },
  handler: async (ctx, args) => {
    const workspace = await requireOwnedWorkspace(ctx, args.workspace);
    const key = await ctx.db.get("keys", args.keyId);
    if (!key) return true;

    if (!workspace.legacyBalance || key.balance !== workspace.legacyBalance) {
      throw new Error("Key not found.");
    }
    const balance = await ctx.db.get("balances", key.balance);
    if (!balance || balance.userId !== workspace.ownerId) {
      throw new Error("Key not found.");
    }

    const mappedKeys = await ctx.db
      .query("api_keys")
      .withIndex("by_legacyKey", (q) => q.eq("legacyKey", key._id))
      .take(200);
    if (
      mappedKeys.some(
        (mappedKey) => mappedKey.workspace !== workspace._id || mappedKey.hash !== key.hash,
      )
    ) {
      throw new Error("Legacy key mapping is invalid.");
    }

    const revokedAt = Date.now();
    await ctx.db.patch("keys", key._id, { revokedAt });
    await Promise.all(
      mappedKeys.map((mappedKey) => ctx.db.patch("api_keys", mappedKey._id, { revokedAt })),
    );
    return true;
  },
});

/** Type-only helper for callers that need to construct a new API-key reference. */
export type WorkspaceApiKeyId = Id<"api_keys">;
