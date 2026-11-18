import type { Doc } from "../../convex/_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../convex/_generated/server";

/**
 * Whether an epoch remains recoverable by a current workspace user's active identity. A no-recovery
 * reset retires identity keys without rotating workspace keys: existence of the public epoch alone
 * must not authorize irreversible migration to its potentially lost private seed. Grant signatures
 * are validated on insertion; this checks availability, not proof of possession of the sealed seed.
 * Oversized historical grant/member sets conservatively stay in custody. All reads are OCC-tracked.
 */
export async function workspaceKeyAvailable(
  ctx: QueryCtx | MutationCtx,
  workspace: Doc<"workspaces">,
  purpose: "member" | "owner",
): Promise<boolean> {
  if (!workspace.keyEpoch) return false;
  const owner = await ctx.db.query("e2ee_identities")
    .withIndex("by_userId_and_status", q => q.eq("userId", workspace.ownerId).eq("status", "active")).unique();
  const ownerGrants = await ctx.db.query("e2ee_workspace_grants")
    .withIndex("by_workspace_and_userId_and_epoch", q => q.eq("workspace", workspace._id).eq("userId", workspace.ownerId).eq("epoch", workspace.keyEpoch!)).take(403);
  if (owner && ownerGrants.length <= 402 && ownerGrants.some(grant => grant.purpose === purpose && grant.recipientKeyId === owner.keyId)) return true;
  if (purpose === "owner") return false;
  const members = await ctx.db.query("workspace_members").withIndex("by_workspace", q => q.eq("workspace", workspace._id)).take(201);
  if (members.length > 200) return false;
  const allowed = new Set(members.map(member => member.userId));
  const grants = await ctx.db.query("e2ee_workspace_grants")
    .withIndex("by_workspace_and_epoch", q => q.eq("workspace", workspace._id).eq("epoch", workspace.keyEpoch!)).take(403);
  if (grants.length > 402) return false;
  const active = new Map<string, string | null>();
  for (const grant of grants) {
    if (grant.purpose !== "member" || !allowed.has(grant.userId)) continue;
    if (!active.has(grant.userId)) {
      const identity = await ctx.db.query("e2ee_identities")
        .withIndex("by_userId_and_status", q => q.eq("userId", grant.userId).eq("status", "active")).unique();
      active.set(grant.userId, identity?.keyId ?? null);
    }
    if (active.get(grant.userId) === grant.recipientKeyId) return true;
  }
  return false;
}
