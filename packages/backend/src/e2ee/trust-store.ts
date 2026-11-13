import { ConvexError, v } from "convex/values";
import { mutation, query, type QueryCtx } from "../../convex/_generated/server";
import { authComponent } from "../../convex/auth";
import { requireAccessibleChat } from "../../convex/workspaces";
import { activeIdentityFor, invalidKeys, requireBox, requireKeyId } from "./workspace-contract";
/** Returns only the authenticated user's opaque pin envelope. */
export const getTrustStore = query({
  args: {},
  returns: v.union(v.null(), v.object({ version: v.number(), envelope: v.bytes() })),
  handler: async (ctx) => {
    const user = await authComponent.getAuthUser(ctx);
    const store = await ctx.db
      .query("e2ee_trust_stores")
      .withIndex("by_userId", (q) => q.eq("userId", user._id))
      .unique();
    return store ? { version: store.version, envelope: store.envelope } : null;
  },
});
/** Compare-and-swap update; stale devices cannot overwrite newer trust decisions. */
export const saveTrustStore = mutation({
  args: {
    expectedVersion: v.union(v.number(), v.null()),
    version: v.number(),
    envelope: v.bytes(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const user = await authComponent.getAuthUser(ctx);
    requireBox(args.envelope, 262144);
    const store = await ctx.db
      .query("e2ee_trust_stores")
      .withIndex("by_userId", (q) => q.eq("userId", user._id))
      .unique();
    if (
      !Number.isSafeInteger(args.version) ||
      args.version < 1 ||
      (store?.version ?? null) !== args.expectedVersion ||
      args.version !== (args.expectedVersion ?? 0) + 1
    ) {
      throw new ConvexError({ code: "TRUST_STORE_CONFLICT" });
    }
    const fields = {
      userId: user._id,
      version: args.version,
      envelope: args.envelope,
      updatedAt: Date.now(),
    };
    if (store) {
      await ctx.db.patch("e2ee_trust_stores", store._id, fields);
    } else {
      await ctx.db.insert("e2ee_trust_stores", fields);
    }
    return null;
  },
});
/** Resolves the bounded public-key directory visible through direct workspace membership. */
async function accessibleIdentityUsers(ctx: QueryCtx, userId: string): Promise<Set<string>> {
  const owned = await ctx.db
    .query("workspaces")
    .withIndex("by_ownerId", (q) => q.eq("ownerId", userId))
    .take(101);
  const memberships = await ctx.db
    .query("workspace_members")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .take(201);
  if (owned.length > 100 || memberships.length > 200) {
    invalidKeys();
  }
  const workspaces = [...owned];
  for (const member of memberships) {
    const workspace = await ctx.db.get("workspaces", member.workspace);
    if (
      workspace &&
      workspace.archivedAt === undefined &&
      !workspaces.some((w) => w._id === workspace._id)
    ) {
      workspaces.push(workspace);
    }
  }
  const allowed = new Set<string>([userId]);
  for (const workspace of workspaces) {
    if (workspace.archivedAt !== undefined) {
      continue;
    }
    allowed.add(workspace.ownerId);
    const rows = await ctx.db
      .query("workspace_members")
      .withIndex("by_workspace", (q) => q.eq("workspace", workspace._id))
      .take(201);
    if (rows.length > 200) {
      invalidKeys();
    }
    for (const row of rows) {
      allowed.add(row.userId);
    }
  }
  return allowed;
}
/** Public active identities, restricted to self or users sharing an accessible workspace. */
export const identityKeys = query({
  args: { userIds: v.array(v.string()) },
  returns: v.array(
    v.union(
      v.null(),
      v.object({
        userId: v.string(),
        keyId: v.string(),
        suite: v.number(),
        encryptionPublicKey: v.bytes(),
        signingPublicKey: v.bytes(),
        selfSignature: v.bytes(),
      }),
    ),
  ),
  handler: async (ctx, args) => {
    const user = await authComponent.getAuthUser(ctx);
    if (args.userIds.length > 200) {
      invalidKeys();
    }
    const allowed = await accessibleIdentityUsers(ctx, user._id);
    const results = [];
    for (const userId of args.userIds) {
      if (!allowed.has(userId)) {
        invalidKeys();
      }
      const identity = await activeIdentityFor(ctx, userId);
      results.push(
        identity
          ? {
              userId,
              keyId: identity.keyId,
              suite: identity.suite,
              encryptionPublicKey: identity.encryptionPublicKey,
              signingPublicKey: identity.signingPublicKey,
              selfSignature: identity.selfSignature,
            }
          : null,
      );
    }
    return results;
  },
});

/**
 * Display names for trust prompts and key status rows, under the same rule as `identityKeys`:
 * only the caller and users sharing an accessible workspace. Names are labels, never trust
 * anchors; clients still compare fingerprints and safety numbers.
 */
export const identityNames = query({
  args: { userIds: v.array(v.string()) },
  returns: v.array(v.object({ userId: v.string(), name: v.string() })),
  handler: async (ctx, args) => {
    const user = await authComponent.getAuthUser(ctx);
    if (args.userIds.length > 200) {
      invalidKeys();
    }
    const allowed = await accessibleIdentityUsers(ctx, user._id);
    const results = [];
    for (const userId of new Set(args.userIds)) {
      if (!allowed.has(userId)) {
        invalidKeys();
      }
      const account = await authComponent.getAnyUserById(ctx, userId);
      if (account) {
        results.push({ userId, name: account.name });
      }
    }
    return results;
  },
});

/** Historical public keys verify old signatures after reset; pending keys never authenticate data. */
export const identityKeysByKeyId = query({
  args: { keyIds: v.array(v.string()), chatId: v.optional(v.id("aisdk_chats")) },
  returns: v.array(
    v.union(
      v.null(),
      v.object({
        userId: v.string(),
        keyId: v.string(),
        suite: v.number(),
        encryptionPublicKey: v.bytes(),
        signingPublicKey: v.bytes(),
        selfSignature: v.bytes(),
        status: v.union(v.literal("active"), v.literal("retired")),
      }),
    ),
  ),
  handler: async (ctx, args) => {
    const user = await authComponent.getAuthUser(ctx);
    if (args.keyIds.length > 200) {
      invalidKeys();
    }
    const allowed = await accessibleIdentityUsers(ctx, user._id);
    const chatSigners = new Set<string>();
    if (args.chatId) {
      // A removed creator's historical signatures remain verifiable by surviving readers.
      const { chat } = await requireAccessibleChat(ctx, args.chatId);
      const epochs = await ctx.db
        .query("e2ee_chat_keys")
        .withIndex("by_chat_and_epoch", (q) => q.eq("chat", chat._id))
        .take(201);
      if (epochs.length > 200) {
        invalidKeys();
      }
      for (const epoch of epochs) {
        if (epoch.signerKeyId) {
          chatSigners.add(epoch.signerKeyId);
        }
      }
    }
    const results = [];
    for (const keyId of args.keyIds) {
      requireKeyId(keyId);
      const identity = await ctx.db
        .query("e2ee_identities")
        .withIndex("by_keyId", (q) => q.eq("keyId", keyId))
        .unique();
      if (!identity || identity.status === "pending") {
        results.push(null);
        continue;
      }
      if (!allowed.has(identity.userId) && !chatSigners.has(keyId)) {
        invalidKeys();
      }
      results.push({
        userId: identity.userId,
        keyId,
        suite: identity.suite,
        encryptionPublicKey: identity.encryptionPublicKey,
        signingPublicKey: identity.signingPublicKey,
        selfSignature: identity.selfSignature,
        status: identity.status,
      });
    }
    return results;
  },
});
