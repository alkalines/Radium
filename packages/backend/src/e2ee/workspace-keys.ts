import { workspaceKeyStateValidator } from "./responses";
import { v } from "convex/values";
import { grantStatement, rosterStatement, verify } from "radium-crypto";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import { mutation, query, type MutationCtx, type QueryCtx } from "../../convex/_generated/server";
import { authComponent } from "../../convex/auth";
import { requireOwnedWorkspace, requireWorkspaceAccessForUser } from "../../convex/workspaces";
import {
  activeIdentityFor,
  epochInputValidator,
  grantInputValidator,
  invalidKeys,
  requireBox,
  requireKeyId,
  requirePositive,
  requireSealedKey,
  rosterInputValidator,
  type EpochInput,
  type GrantInput,
  type RosterInput,
} from "./workspace-contract";
type ReadCtx = QueryCtx | MutationCtx;
/** Bounded workspace membership list, including implicit ownership. */
export async function workspaceUsers(
  ctx: ReadCtx,
  workspace: Doc<"workspaces">,
): Promise<string[]> {
  const members = await ctx.db
    .query("workspace_members")
    .withIndex("by_workspace", (q) => q.eq("workspace", workspace._id))
    .take(201);
  if (members.length > 200) {
    invalidKeys();
  }
  return [workspace.ownerId, ...members.map((row) => row.userId)];
}
/** Latest owner-signed roster, or null before bootstrap. */
export async function latestRoster(ctx: ReadCtx, workspace: Id<"workspaces">) {
  return await ctx.db
    .query("e2ee_rosters")
    .withIndex("by_workspace_and_version", (q) => q.eq("workspace", workspace))
    .order("desc")
    .first();
}
/** Parses the signed roster's bounded members into userId → pinned keyId for re-grant checks. */
export function rosterMembers(roster: Doc<"e2ee_rosters"> | null): Map<string, string> {
  const members = new Map<string, string>();
  if (!roster) {
    return members;
  }
  try {
    const body = JSON.parse(new TextDecoder().decode(roster.body));
    if (!Array.isArray(body.members) || body.members.length > 200) {
      invalidKeys();
    }
    for (const member of body.members) {
      if (typeof member.userId !== "string" || typeof member.keyId !== "string") {
        invalidKeys();
      }
      members.set(member.userId, member.keyId);
    }
    return members;
  } catch {
    return invalidKeys();
  }
}
/** Verifies a monotonic roster against the owner's active signing identity and workspace binding. */
export async function storeRoster(
  ctx: MutationCtx,
  workspace: Doc<"workspaces">,
  roster: RosterInput,
  epoch = workspace.keyEpoch,
): Promise<void> {
  requirePositive(roster.version);
  requireKeyId(roster.signerKeyId);
  requireBox(roster.body);
  const owner = await activeIdentityFor(ctx, workspace.ownerId);
  const previous = await latestRoster(ctx, workspace._id);
  // Signing with a retired or substituted key must not advance the trusted roster head.
  if (
    !owner ||
    owner.keyId !== roster.signerKeyId ||
    roster.signature.byteLength !== 64 ||
    roster.version <= (previous?.version ?? 0) ||
    !(await verify(
      new Uint8Array(owner.signingPublicKey),
      rosterStatement({ workspaceId: workspace._id, body: new Uint8Array(roster.body) }),
      new Uint8Array(roster.signature),
    ))
  ) {
    invalidKeys();
  }
  try {
    const body = JSON.parse(new TextDecoder().decode(roster.body));
    if (
      body.v !== 1 ||
      body.workspace !== workspace._id ||
      body.version !== roster.version ||
      body.epoch !== epoch ||
      body.owner?.userId !== workspace.ownerId ||
      body.owner?.keyId !== owner.keyId ||
      !Array.isArray(body.members) ||
      body.members.length > 200 ||
      !Array.isArray(body.epochs) ||
      body.epochs.length > 200
    ) {
      invalidKeys();
    }
    const users = await workspaceUsers(ctx, workspace);
    const seen = new Set<string>();
    for (const member of body.members) {
      const identity = await activeIdentityFor(ctx, member.userId);
      if (
        member.userId === workspace.ownerId ||
        !users.includes(member.userId) ||
        seen.has(member.userId) ||
        !identity ||
        member.keyId !== identity.keyId
      ) {
        invalidKeys();
      }
      seen.add(member.userId);
    }
  } catch {
    invalidKeys();
  }
  await ctx.db.insert("e2ee_rosters", {
    ...roster,
    workspace: workspace._id,
    createdAt: Date.now(),
  });
}
/** Validates and stores a signed grant; self grants are allowed only by explicit join flows. */
export async function storeGrant(
  ctx: MutationCtx,
  workspace: Doc<"workspaces">,
  grant: GrantInput,
  granterUserId: string,
  allowSelf = false,
): Promise<void> {
  requirePositive(grant.epoch);
  requireKeyId(grant.recipientKeyId);
  requireKeyId(grant.granterKeyId);
  requireSealedKey(grant.sealed);
  const users = await workspaceUsers(ctx, workspace);
  const recipient = await activeIdentityFor(ctx, grant.userId);
  const granter = await activeIdentityFor(ctx, granterUserId);
  // New ciphertext may target only identities currently bound to workspace members.
  if (
    !users.includes(grant.userId) ||
    !recipient ||
    recipient.keyId !== grant.recipientKeyId ||
    !granter ||
    granter.keyId !== grant.granterKeyId ||
    grant.signature.byteLength !== 64 ||
    (grant.purpose === "owner" && grant.userId !== workspace.ownerId)
  ) {
    invalidKeys();
  }
  if (!allowSelf && granterUserId === grant.userId && granterUserId !== workspace.ownerId) {
    invalidKeys();
  }
  const epoch = await ctx.db
    .query("e2ee_workspace_epochs")
    .withIndex("by_workspace_and_epoch", (q) =>
      q.eq("workspace", workspace._id).eq("epoch", grant.epoch),
    )
    .unique();
  if (
    !epoch ||
    !(await verify(
      new Uint8Array(granter.signingPublicKey),
      grantStatement({
        workspaceId: workspace._id,
        ...grant,
        recipientUserId: grant.userId,
        sealed: new Uint8Array(grant.sealed),
      }),
      new Uint8Array(grant.signature),
    ))
  ) {
    invalidKeys();
  }
  if (granterUserId !== workspace.ownerId && !allowSelf) {
    // A member can redistribute only an epoch they hold, to the exact identity the owner listed.
    if (
      grant.purpose !== "member" ||
      rosterMembers(await latestRoster(ctx, workspace._id)).get(grant.userId) !==
        grant.recipientKeyId
    ) {
      invalidKeys();
    }
    const held = await ctx.db
      .query("e2ee_workspace_grants")
      .withIndex("by_workspace_and_userId_and_epoch", (q) =>
        q.eq("workspace", workspace._id).eq("userId", granterUserId).eq("epoch", grant.epoch),
      )
      .take(3);
    if (!held.some((row) => row.purpose === "member" && row.recipientKeyId === granter.keyId)) {
      invalidKeys();
    }
  }
  const existing = await ctx.db
    .query("e2ee_workspace_grants")
    .withIndex("by_workspace_and_userId_and_epoch", (q) =>
      q.eq("workspace", workspace._id).eq("userId", grant.userId).eq("epoch", grant.epoch),
    )
    .take(3);
  const old = existing.find((row) => row.purpose === grant.purpose);
  // An owner endorsement replaces any join self-grant or member re-grant, so a junk grant can
  // never block the owner's correct one; retries keep endorsed ciphertext intact.
  const replace =
    !old ||
    old.recipientKeyId !== grant.recipientKeyId ||
    (old.granterUserId !== workspace.ownerId && granterUserId === workspace.ownerId);
  if (replace) {
    if (old) {
      await ctx.db.delete("e2ee_workspace_grants", old._id);
    }
    await ctx.db.insert("e2ee_workspace_grants", {
      ...grant,
      workspace: workspace._id,
      granterUserId,
      createdAt: Date.now(),
    });
  }
  // Only an owner-signed grant resolves a key request; a member's re-grant may be junk.
  if (
    grant.purpose === "member" &&
    grant.epoch === workspace.keyEpoch &&
    granterUserId === workspace.ownerId &&
    granterUserId !== grant.userId
  ) {
    const requests = await ctx.db
      .query("e2ee_join_requests")
      .withIndex("by_workspace_and_userId", (q) =>
        q.eq("workspace", workspace._id).eq("userId", grant.userId),
      )
      .take(201);
    if (requests.length > 200) {
      invalidKeys();
    }
    for (const request of requests) {
      if (request.keyId === grant.recipientKeyId) {
        await ctx.db.delete("e2ee_join_requests", request._id);
      }
    }
  }
}
/** Inserts a workspace epoch, owner coverage and signed roster in one transaction. */
export async function insertWorkspaceEpoch(
  ctx: MutationCtx,
  workspace: Doc<"workspaces">,
  input: {
    epoch: EpochInput;
    grants: GrantInput[];
    roster: RosterInput;
  },
): Promise<void> {
  const { epoch, grants, roster } = input;
  if (!workspace.keyEpoch && roster.version !== 1) {
    invalidKeys();
  }
  if (
    epoch.epoch !== (workspace.keyEpoch ?? 0) + 1 ||
    epoch.epoch > 200 ||
    epoch.suite !== 1 ||
    epoch.memberPublicKey.byteLength !== 1216 ||
    epoch.ownerPublicKey.byteLength !== 1216 ||
    grants.length > 402
  ) {
    invalidKeys();
  }
  requireKeyId(epoch.memberKeyId);
  requireKeyId(epoch.ownerKeyId);
  if (
    epoch.memberKeyId === epoch.ownerKeyId ||
    !["member", "owner"].every((purpose) =>
      grants.some(
        (g) => g.userId === workspace.ownerId && g.purpose === purpose && g.epoch === epoch.epoch,
      ),
    )
  ) {
    invalidKeys();
  }
  if (grants.some((g) => g.epoch !== epoch.epoch)) {
    invalidKeys();
  }
  await ctx.db.insert("e2ee_workspace_epochs", {
    ...epoch,
    workspace: workspace._id,
    createdBy: workspace.ownerId,
    createdAt: Date.now(),
  });
  const updated = { ...workspace, keyEpoch: epoch.epoch };
  for (const grant of grants) {
    await storeGrant(ctx, updated, grant, workspace.ownerId);
  }
  await storeRoster(ctx, updated, roster, epoch.epoch);
  await ctx.db.patch("workspaces", workspace._id, { keyEpoch: epoch.epoch });
}
/** Deletes old-epoch admission proofs before rotating keys. */
export async function clearWorkspaceJoins(
  ctx: MutationCtx,
  workspace: Id<"workspaces">,
): Promise<void> {
  const invites = await ctx.db
    .query("e2ee_invites")
    .withIndex("by_workspace", (q) => q.eq("workspace", workspace))
    .take(201);
  const requests = await ctx.db
    .query("e2ee_join_requests")
    .withIndex("by_workspace", (q) => q.eq("workspace", workspace))
    .take(401);
  if (invites.length > 200 || requests.length > 400) {
    invalidKeys();
  }
  for (const row of invites) {
    await ctx.db.delete("e2ee_invites", row._id);
  }
  for (const row of requests) {
    await ctx.db.delete("e2ee_join_requests", row._id);
  }
}
/** Bootstraps the owner's existing keyless workspace. */
export const bootstrapWorkspaceKeys = mutation({
  args: {
    workspace: v.id("workspaces"),
    epoch: epochInputValidator,
    grants: v.array(grantInputValidator),
    roster: rosterInputValidator,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const workspace = await requireOwnedWorkspace(ctx, args.workspace);
    if (workspace.keyEpoch) {
      invalidKeys();
    }
    await insertWorkspaceEpoch(ctx, workspace, args);
    return null;
  },
});
/** Rotates both workspace keys after owner recovery or compromise. */
export const rotateWorkspaceEpoch = mutation({
  args: {
    workspace: v.id("workspaces"),
    epoch: epochInputValidator,
    grants: v.array(grantInputValidator),
    roster: rosterInputValidator,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const workspace = await requireOwnedWorkspace(ctx, args.workspace);
    if (!workspace.keyEpoch) {
      invalidKeys();
    }
    await clearWorkspaceJoins(ctx, workspace._id);
    await insertWorkspaceEpoch(ctx, workspace, args);
    return null;
  },
});
/** Adds authorized signed grants and resolves fulfilled key requests. */
export const addGrants = mutation({
  args: { workspace: v.id("workspaces"), grants: v.array(grantInputValidator) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const user = await authComponent.getAuthUser(ctx);
    const workspace = await requireWorkspaceAccessForUser(ctx, args.workspace, user._id);
    if (args.grants.length > 402) {
      invalidKeys();
    }
    for (const grant of args.grants) {
      await storeGrant(ctx, workspace, grant, user._id);
    }
    return null;
  },
});
/** Publishes a strictly newer owner-signed roster. */
export const publishRoster = mutation({
  args: { workspace: v.id("workspaces"), roster: rosterInputValidator },
  returns: v.null(),
  handler: async (ctx, args) => {
    await storeRoster(ctx, await requireOwnedWorkspace(ctx, args.workspace), args.roster);
    return null;
  },
});
/** Reads bounded key state, revealing admission proofs only to eligible granters. */
export const workspaceKeyState = query({
  args: { workspace: v.id("workspaces") },
  returns: workspaceKeyStateValidator,
  handler: async (ctx, args) => {
    const user = await authComponent.getAuthUser(ctx);
    const workspace = await requireWorkspaceAccessForUser(ctx, args.workspace, user._id);
    const owner = workspace.ownerId === user._id;
    const epochs = await ctx.db
      .query("e2ee_workspace_epochs")
      .withIndex("by_workspace_and_epoch", (q) => q.eq("workspace", workspace._id))
      .take(201);
    if (epochs.length > 200) {
      invalidKeys();
    }
    const roster = await latestRoster(ctx, workspace._id);
    const listed = rosterMembers(roster);
    const members = [];
    const myGrants = [];
    for (const userId of await workspaceUsers(ctx, workspace)) {
      const identity = await activeIdentityFor(ctx, userId);
      const grants = await ctx.db
        .query("e2ee_workspace_grants")
        .withIndex("by_workspace_and_userId_and_epoch", (q) =>
          q.eq("workspace", workspace._id).eq("userId", userId),
        )
        .take(401);
      if (grants.length > 400) {
        invalidKeys();
      }
      if (userId === user._id) {
        myGrants.push(...grants);
      }
      // Only owner-endorsed grants count; a member's re-grant may be junk the owner must replace.
      const granted = grants
        .filter(
          (g) =>
            g.purpose === "member" &&
            g.recipientKeyId === identity?.keyId &&
            g.granterUserId === workspace.ownerId,
        )
        .map((g) => g.epoch);
      members.push({
        userId,
        role: userId === workspace.ownerId ? ("owner" as const) : ("member" as const),
        keyId: identity?.keyId ?? null,
        grantedEpoch: granted.length ? Math.max(...granted) : null,
      });
    }
    const requests = await ctx.db
      .query("e2ee_join_requests")
      .withIndex("by_workspace", (q) => q.eq("workspace", workspace._id))
      .take(401);
    const invites = owner
      ? await ctx.db
          .query("e2ee_invites")
          .withIndex("by_workspace", (q) => q.eq("workspace", workspace._id))
          .take(201)
      : [];
    if (requests.length > 400 || invites.length > 200) {
      invalidKeys();
    }
    const phrase = workspace.keyEpoch
      ? await ctx.db
          .query("e2ee_phrases")
          .withIndex("by_workspace_and_epoch", (q) =>
            q.eq("workspace", workspace._id).eq("epoch", workspace.keyEpoch!),
          )
          .unique()
      : null;
    return {
      role: owner ? ("owner" as const) : ("member" as const),
      ownerId: workspace.ownerId,
      keyEpoch: workspace.keyEpoch ?? null,
      epochs,
      roster,
      myGrants,
      members,
      joinRequests: requests.filter(
        (r) => owner || (r.source === "request" && listed.has(r.userId)),
      ),
      phrase: phrase
        ? { epoch: phrase.epoch, phraseId: phrase.phraseId, wrapper: phrase.wrapper }
        : null,
      invites: invites
        .filter((i) => i.expiresAt > Date.now())
        .map((i) => ({
          inviteId: i.inviteId,
          invitedUserId: i.invitedUserId,
          expiresAt: i.expiresAt,
        })),
    };
  },
});
