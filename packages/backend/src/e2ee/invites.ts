import { v } from "convex/values";
import {
  internalMutation,
  mutation,
  query,
  type MutationCtx,
} from "../../convex/_generated/server";
import { authComponent } from "../../convex/auth";
import { requireOwnedWorkspace, requireWorkspaceAccessForUser } from "../../convex/workspaces";
import {
  activeIdentityFor,
  grantInputValidator,
  invalidKeys,
  requireBox,
  requireKeyId,
  type GrantInput,
} from "./workspace-contract";
import { storeGrant, workspaceUsers } from "./workspace-keys";
import type { Doc } from "../../convex/_generated/dataModel";
const INVITE_TTL = 7 * 24 * 60 * 60 * 1000;
/** Stores one admission proof per member identity; proof secrets remain encrypted. */
async function join(
  ctx: MutationCtx,
  workspace: Doc<"workspaces">,
  userId: string,
  keyId: string,
  mac: ArrayBuffer,
  selfGrant: GrantInput,
  source: "invite" | "phrase",
  ownerSecret: ArrayBuffer,
  epoch: number,
  sourceId: string,
) {
  const identity = await activeIdentityFor(ctx, userId);
  requireKeyId(keyId);
  if (
    !identity ||
    identity.keyId !== keyId ||
    mac.byteLength !== 32 ||
    selfGrant.userId !== userId ||
    selfGrant.recipientKeyId !== keyId ||
    selfGrant.granterKeyId !== keyId ||
    selfGrant.purpose !== "member" ||
    selfGrant.epoch !== epoch ||
    epoch !== workspace.keyEpoch
  ) {
    invalidKeys();
  }
  await storeGrant(ctx, workspace, selfGrant, userId, true);
  const requests = await ctx.db
    .query("e2ee_join_requests")
    .withIndex("by_workspace_and_userId", (q) =>
      q.eq("workspace", workspace._id).eq("userId", userId),
    )
    .take(201);
  if (requests.length > 200) {
    invalidKeys();
  }
  for (const request of requests) {
    if (request.keyId === keyId) {
      await ctx.db.delete("e2ee_join_requests", request._id);
    }
  }
  await ctx.db.insert("e2ee_join_requests", {
    workspace: workspace._id,
    userId,
    keyId,
    source,
    sourceId,
    mac,
    ownerSecret,
    epoch,
    createdAt: Date.now(),
  });
}
/** Creates a seven-day single-use invite to an existing member of the current epoch. */
export const createInvite = mutation({
  args: {
    workspace: v.id("workspaces"),
    inviteId: v.string(),
    invitedUserId: v.string(),
    epoch: v.number(),
    sealed: v.bytes(),
    ownerSecret: v.bytes(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const workspace = await requireOwnedWorkspace(ctx, args.workspace);
    requireKeyId(args.inviteId);
    requireBox(args.sealed);
    requireBox(args.ownerSecret);
    if (
      !workspace.keyEpoch ||
      args.epoch !== workspace.keyEpoch ||
      !(await workspaceUsers(ctx, workspace)).includes(args.invitedUserId) ||
      args.invitedUserId === workspace.ownerId
    ) {
      invalidKeys();
    }
    if (
      await ctx.db
        .query("e2ee_invites")
        .withIndex("by_inviteId", (q) => q.eq("inviteId", args.inviteId))
        .first()
    ) {
      invalidKeys();
    }
    const invites = await ctx.db
      .query("e2ee_invites")
      .withIndex("by_workspace", (q) => q.eq("workspace", workspace._id))
      .take(201);
    if (invites.length > 200) {
      invalidKeys();
    }
    for (const invite of invites) {
      if (invite.invitedUserId === args.invitedUserId || invite.expiresAt <= Date.now()) {
        await ctx.db.delete("e2ee_invites", invite._id);
      }
    }
    await ctx.db.insert("e2ee_invites", {
      ...args,
      createdBy: workspace.ownerId,
      expiresAt: Date.now() + INVITE_TTL,
    });
    return null;
  },
});
/** Returns an unexpired invite only to its intended account. */
export const getInvite = query({
  args: { inviteId: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      workspace: v.id("workspaces"),
      epoch: v.number(),
      sealed: v.bytes(),
      expiresAt: v.number(),
      ownerId: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    const user = await authComponent.getAuthUser(ctx);
    requireKeyId(args.inviteId);
    const invite = await ctx.db
      .query("e2ee_invites")
      .withIndex("by_inviteId", (q) => q.eq("inviteId", args.inviteId))
      .unique();
    if (!invite || invite.invitedUserId !== user._id || invite.expiresAt <= Date.now()) {
      return null;
    }
    const workspace = await requireWorkspaceAccessForUser(ctx, invite.workspace, user._id);
    if (workspace.keyEpoch !== invite.epoch) {
      return null;
    }
    return {
      workspace: invite.workspace,
      epoch: invite.epoch,
      sealed: invite.sealed,
      expiresAt: invite.expiresAt,
      ownerId: workspace.ownerId,
    };
  },
});
/** Consumes an invite exactly once and stores the recipient's signed self-grant and proof. */
export const acceptInvite = mutation({
  args: { inviteId: v.string(), keyId: v.string(), mac: v.bytes(), selfGrant: grantInputValidator },
  returns: v.null(),
  handler: async (ctx, args) => {
    const user = await authComponent.getAuthUser(ctx);
    requireKeyId(args.inviteId);
    const invite = await ctx.db
      .query("e2ee_invites")
      .withIndex("by_inviteId", (q) => q.eq("inviteId", args.inviteId))
      .unique();
    if (!invite || invite.invitedUserId !== user._id || invite.expiresAt <= Date.now()) {
      invalidKeys();
    }
    const workspace = await requireWorkspaceAccessForUser(ctx, invite.workspace, user._id);
    await join(
      ctx,
      workspace,
      user._id,
      args.keyId,
      args.mac,
      args.selfGrant,
      "invite",
      invite.ownerSecret,
      invite.epoch,
      invite.inviteId,
    );
    await ctx.db.delete("e2ee_invites", invite._id);
    return null;
  },
});
/** Revokes a pending invitation; only its workspace owner can do so. */
export const revokeInvite = mutation({
  args: { inviteId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    requireKeyId(args.inviteId);
    const invite = await ctx.db
      .query("e2ee_invites")
      .withIndex("by_inviteId", (q) => q.eq("inviteId", args.inviteId))
      .unique();
    if (!invite) {
      return null;
    }
    await requireOwnedWorkspace(ctx, invite.workspace);
    await ctx.db.delete("e2ee_invites", invite._id);
    return null;
  },
});
/** Prunes a bounded batch; the hourly cron catches later batches without unbounded scans. */
export const pruneExpiredInvites = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("e2ee_invites")
      .withIndex("by_expiresAt", (q) => q.lte("expiresAt", Date.now()))
      .take(500);
    for (const row of rows) {
      await ctx.db.delete("e2ee_invites", row._id);
    }
    return null;
  },
});
/** Replaces the current epoch's optional generated-key-phrase wrapper. */
export const setPhrase = mutation({
  args: {
    workspace: v.id("workspaces"),
    epoch: v.number(),
    phraseId: v.string(),
    wrapper: v.bytes(),
    ownerSecret: v.bytes(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const workspace = await requireOwnedWorkspace(ctx, args.workspace);
    requireKeyId(args.phraseId);
    requireBox(args.wrapper);
    requireBox(args.ownerSecret);
    if (!workspace.keyEpoch || args.epoch !== workspace.keyEpoch) {
      invalidKeys();
    }
    const existing = await ctx.db
      .query("e2ee_phrases")
      .withIndex("by_workspace_and_epoch", (q) =>
        q.eq("workspace", workspace._id).eq("epoch", args.epoch),
      )
      .unique();
    if (existing) {
      await ctx.db.delete("e2ee_phrases", existing._id);
    }
    await ctx.db.insert("e2ee_phrases", {
      ...args,
      createdBy: workspace.ownerId,
      createdAt: Date.now(),
    });
    return null;
  },
});
/** Removes every historical phrase wrapper without deleting grants. */
export const removePhrase = mutation({
  args: { workspace: v.id("workspaces") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const workspace = await requireOwnedWorkspace(ctx, args.workspace);
    const rows = await ctx.db
      .query("e2ee_phrases")
      .withIndex("by_workspace_and_epoch", (q) => q.eq("workspace", workspace._id))
      .take(201);
    if (rows.length > 200) {
      invalidKeys();
    }
    for (const row of rows) {
      await ctx.db.delete("e2ee_phrases", row._id);
    }
    return null;
  },
});
/** Accepts the current phrase as a member, pending owner verification of the MAC. */
export const acceptPhrase = mutation({
  args: {
    workspace: v.id("workspaces"),
    keyId: v.string(),
    mac: v.bytes(),
    selfGrant: grantInputValidator,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const user = await authComponent.getAuthUser(ctx);
    const workspace = await requireWorkspaceAccessForUser(ctx, args.workspace, user._id);
    const phrase = await ctx.db
      .query("e2ee_phrases")
      .withIndex("by_workspace_and_epoch", (q) =>
        q.eq("workspace", workspace._id).eq("epoch", workspace.keyEpoch ?? 0),
      )
      .unique();
    if (!phrase) {
      invalidKeys();
    }
    await join(
      ctx,
      workspace,
      user._id,
      args.keyId,
      args.mac,
      args.selfGrant,
      "phrase",
      phrase.ownerSecret,
      phrase.epoch,
      phrase.phraseId,
    );
    return null;
  },
});
/** Requests a re-grant to the caller's active identity, idempotently per identity. */
export const requestKeys = mutation({
  args: { workspace: v.id("workspaces"), keyId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const user = await authComponent.getAuthUser(ctx);
    const workspace = await requireWorkspaceAccessForUser(ctx, args.workspace, user._id);
    const identity = await activeIdentityFor(ctx, user._id);
    requireKeyId(args.keyId);
    if (!identity || identity.keyId !== args.keyId || !workspace.keyEpoch) {
      invalidKeys();
    }
    const grants = await ctx.db
      .query("e2ee_workspace_grants")
      .withIndex("by_workspace_and_userId_and_epoch", (q) =>
        q.eq("workspace", workspace._id).eq("userId", user._id).eq("epoch", workspace.keyEpoch!),
      )
      .take(3);
    if (
      grants.some(
        (g) =>
          g.purpose === "member" &&
          g.recipientKeyId === args.keyId &&
          g.granterUserId === workspace.ownerId,
      )
    ) {
      return null;
    }
    const requests = await ctx.db
      .query("e2ee_join_requests")
      .withIndex("by_workspace_and_userId", (q) =>
        q.eq("workspace", workspace._id).eq("userId", user._id),
      )
      .take(201);
    if (requests.length > 200) {
      invalidKeys();
    }
    if (requests.some((r) => r.keyId === args.keyId)) {
      return null;
    }
    for (const row of requests) {
      await ctx.db.delete("e2ee_join_requests", row._id);
    }
    await ctx.db.insert("e2ee_join_requests", {
      workspace: workspace._id,
      userId: user._id,
      keyId: args.keyId,
      source: "request",
      createdAt: Date.now(),
    });
    return null;
  },
});
/** Denies one request, leaving all existing grants intact. */
export const dismissJoinRequest = mutation({
  args: { requestId: v.id("e2ee_join_requests") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const request = await ctx.db.get("e2ee_join_requests", args.requestId);
    if (!request) {
      return null;
    }
    await requireOwnedWorkspace(ctx, request.workspace);
    await ctx.db.delete("e2ee_join_requests", request._id);
    return null;
  },
});
