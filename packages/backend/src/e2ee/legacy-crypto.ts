import type { MutationCtx, QueryCtx } from "../../convex/_generated/server";
import type { Id } from "../../convex/_generated/dataModel";
import { chatEpochCanReleaseCustody, chatKeyIsStale } from "./chat-keys";
import type { LegacyRecipient } from "contracts/e2ee/legacy-contract";
import { workspaceKeyAvailable } from "./workspace-key-availability";

/**
 * Chat history uses its native chat key only when clients can open it and the key is the chat's
 * authentic writable epoch: right suite and size, an original signature by an active recorded
 * signer with authority over the current scope, and a binding proof over this exact chat and its
 * current audience (`chatEpochIsBound`). The signer must also be the chat creator or the workspace
 * owner (`chatEpochCanReleaseCustody`): another reader's wraps are unverifiable, so their epoch
 * never receives released history. Keyless chats of every scope, stale epochs (a revoked
 * recipient or a rotated workspace key can still open them) and unsigned, unbound or forged
 * epochs stay in custody, never deleting plaintext into a copy no reader would accept. Creating a
 * creator- or owner-signed epoch (`insertChatEpoch`) or certifying one (`signChatKey`) requests
 * the release.
 */
export async function activeLegacyRecipient(ctx: QueryCtx | MutationCtx, input: {
  userId?: string;
  workspace?: Id<"workspaces">;
  chat?: Id<"aisdk_chats">;
  purpose?: "member" | "owner";
}): Promise<LegacyRecipient | undefined> {
  if (input.chat) {
    const chat = await ctx.db.get("aisdk_chats", input.chat);
    if (!chat) throw new Error("Legacy content has no parent chat");
    if (input.workspace && chat.workspace !== input.workspace) throw new Error("Legacy chat workspace mismatch");
    if (chat.keyEpoch) {
      const workspaceId = input.workspace ?? chat.workspace;
      const workspace = workspaceId ? await ctx.db.get("workspaces", workspaceId) : null;
      if (!workspace) throw new Error("Legacy chat has no workspace");
      // Native writers refuse a stale epoch a removed reader may still hold; migrated history follows the same rule.
      if (await chatKeyIsStale(ctx, chat, workspace)) return undefined;
      if (chat.scope === "workspace" && !(await workspaceKeyAvailable(ctx, workspace, "member"))) return undefined;
      const key = await ctx.db.query("e2ee_chat_keys").withIndex("by_chat_and_epoch", q => q.eq("chat", chat._id).eq("epoch", chat.keyEpoch!)).unique();
      if (!key) throw new Error("Legacy chat key is missing");
      if (!(await chatEpochCanReleaseCustody(ctx, chat, workspace, key))) return undefined;
      return { kind: "chat", keyId: key.keyId, epoch: key.epoch, publicKey: key.publicKey };
    }
    // Only a chat seed can be rewrapped when visibility changes; workspace fallback would survive narrowing.
    return undefined;
  }
  if (input.workspace) {
    const workspace = await ctx.db.get("workspaces", input.workspace);
    if (!workspace) throw new Error("Legacy content has no workspace");
    if (!workspace.keyEpoch) return undefined;
    if (!(await workspaceKeyAvailable(ctx, workspace, input.purpose ?? "member"))) return undefined;
    const key = await ctx.db.query("e2ee_workspace_epochs").withIndex("by_workspace_and_epoch", q => q.eq("workspace", workspace._id).eq("epoch", workspace.keyEpoch!)).unique();
    if (!key) throw new Error("Legacy workspace key is missing");
    return input.purpose === "owner"
      ? { kind: "workspace_owner", keyId: key.ownerKeyId, epoch: key.epoch, publicKey: key.ownerPublicKey }
      : { kind: "workspace_member", keyId: key.memberKeyId, epoch: key.epoch, publicKey: key.memberPublicKey };
  }
  if (input.userId) {
    const key = await ctx.db.query("e2ee_identities").withIndex("by_userId_and_status", q => q.eq("userId", input.userId!).eq("status", "active")).unique();
    if (key) return { kind: "identity", keyId: key.keyId, epoch: 1, publicKey: key.encryptionPublicKey };
  }
  return undefined;
}
