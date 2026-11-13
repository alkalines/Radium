import { chatKeysResultValidator, staleWrapsResultValidator } from "./responses";
import { ConvexError, v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { chatKeyStatement, verify } from "radium-crypto";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import { mutation, query, type MutationCtx, type QueryCtx } from "../../convex/_generated/server";
import { authComponent } from "../../convex/auth";
import { requireAccessibleChat, requireOwnedWorkspace } from "../../convex/workspaces";
import { chatMemberIds } from "../chatroom/members";
import {
  activeIdentityFor,
  chatKeyInputValidator,
  chatKeysSetupValidator,
  invalidKeys,
  requireKeyId,
  requirePositive,
  requireSealedKey,
  wrapInputValidator,
  type ChatKeyInput,
  type ChatKeysSetup,
  type WrapInput,
} from "./workspace-contract";
type ReadCtx = QueryCtx | MutationCtx;
/** Reject plaintext creation by keyed accounts, except workspace chats in keyless workspaces. */
export async function requireChatKeysForCreate(
  ctx: ReadCtx,
  input: {
    userId: string;
    workspace: Doc<"workspaces">;
    scope: "personal" | "shared" | "workspace";
    hasKeys: boolean;
  },
): Promise<void> {
  if (
    !input.hasKeys &&
    !(input.scope === "workspace" && !input.workspace.keyEpoch) &&
    (await activeIdentityFor(ctx, input.userId))
  ) {
    throw new ConvexError({ code: "E2EE_KEYS_REQUIRED" });
  }
}
/** Reads the current public key; no secret material is returned. */
export async function currentChatPublicKey(ctx: ReadCtx, chat: Doc<"aisdk_chats">) {
  if (!chat.keyEpoch) {
    return null;
  }
  const key = await ctx.db
    .query("e2ee_chat_keys")
    .withIndex("by_chat_and_epoch", (q) => q.eq("chat", chat._id).eq("epoch", chat.keyEpoch!))
    .unique();
  return key ? { epoch: key.epoch, keyId: key.keyId, publicKey: key.publicKey } : null;
}
/** Epoch cap that keeps `chatKeys` and scope changes within their bounded reads. */
export const MAX_CHAT_EPOCHS = 200;
/** Newest workspace wrap of one chat key epoch, read without scanning the others. */
export async function newestWorkspaceWrap(
  ctx: ReadCtx,
  chat: Id<"aisdk_chats">,
  chatEpoch: number,
) {
  return await ctx.db
    .query("e2ee_chat_key_wraps")
    .withIndex("by_chat_and_chatEpoch_and_workspaceEpoch", (q) =>
      q.eq("chat", chat).eq("chatEpoch", chatEpoch).gt("workspaceEpoch", 0),
    )
    .order("desc")
    .first();
}
/**
 * Whether a workspace chat's current key epoch predates the workspace's current key epoch. A
 * rotation (for example after a member's removal) leaves earlier workspace keys able to open it,
 * so it needs a new chat epoch whatever the owner's rewrap job has since added to older ones.
 */
export async function chatPredatesWorkspaceKey(
  ctx: ReadCtx,
  chat: Doc<"aisdk_chats">,
  workspace: Doc<"workspaces">,
): Promise<boolean> {
  if (chat.scope !== "workspace" || !chat.e2eeId || !workspace.keyEpoch || !chat.keyEpoch) {
    return false;
  }
  const key = await ctx.db
    .query("e2ee_chat_keys")
    .withIndex("by_chat_and_epoch", (q) => q.eq("chat", chat._id).eq("epoch", chat.keyEpoch!))
    .unique();
  const workspaceEpoch = await ctx.db
    .query("e2ee_workspace_epochs")
    .withIndex("by_workspace_and_epoch", (q) =>
      q.eq("workspace", workspace._id).eq("epoch", workspace.keyEpoch!),
    )
    .unique();
  return !!key && !!workspaceEpoch && key.createdAt < workspaceEpoch.createdAt;
}
/**
 * A keyed chat must start a new chat key epoch before anything is sealed to it when a recipient
 * lost access (`rekey`) or its workspace key rotated since the chat's current epoch was made.
 */
export async function chatKeyIsStale(
  ctx: ReadCtx,
  chat: Doc<"aisdk_chats">,
  workspace: Doc<"workspaces">,
): Promise<boolean> {
  if (!chat.e2eeId) {
    return false;
  }
  return !!chat.rekey || (await chatPredatesWorkspaceKey(ctx, chat, workspace));
}
/**
 * Creators may always rotate. Other accessors may only when the key is stale or its current
 * epoch is unsigned or signed by an identity its signer has since retired; otherwise any member
 * could rotate a chat to a key only they hold.
 */
export async function canRotateChatKey(
  ctx: ReadCtx,
  chat: Doc<"aisdk_chats">,
  workspace: Doc<"workspaces">,
  userId: string,
): Promise<boolean> {
  if (chat.userId === userId || (await chatKeyIsStale(ctx, chat, workspace))) {
    return true;
  }
  const current = chat.keyEpoch
    ? await ctx.db
        .query("e2ee_chat_keys")
        .withIndex("by_chat_and_epoch", (q) => q.eq("chat", chat._id).eq("epoch", chat.keyEpoch!))
        .unique()
    : null;
  if (!current) {
    return false;
  }
  if (!current.signature || !current.signerUserId) {
    return true;
  }
  const signer = await activeIdentityFor(ctx, current.signerUserId);
  return signer?.keyId !== current.signerKeyId;
}
/** Validates a public epoch and any supplied signature against the authenticated signer. */
export async function validateChatEpoch(
  ctx: ReadCtx,
  workspace: Doc<"workspaces">,
  e2eeId: string,
  epoch: ChatKeyInput,
  userId: string,
): Promise<void> {
  requirePositive(epoch.epoch);
  requireKeyId(epoch.keyId);
  if (
    epoch.suite !== 1 ||
    epoch.publicKey.byteLength !== 1216 ||
    !!epoch.signerKeyId !== !!epoch.signature
  ) {
    invalidKeys();
  }
  if (epoch.signerKeyId && epoch.signature) {
    requireKeyId(epoch.signerKeyId);
    const signer = await activeIdentityFor(ctx, userId);
    if (
      !signer ||
      signer.keyId !== epoch.signerKeyId ||
      epoch.signature.byteLength !== 64 ||
      !(await verify(
        new Uint8Array(signer.signingPublicKey),
        chatKeyStatement({
          workspaceId: workspace._id,
          chatE2eeId: e2eeId,
          ...epoch,
          publicKey: new Uint8Array(epoch.publicKey),
        }),
        new Uint8Array(epoch.signature),
      ))
    ) {
      invalidKeys();
    }
  }
}
/** Validates recipient identities, current workspace epochs and scope coverage. */
export async function validateChatWraps(
  ctx: ReadCtx,
  chat: Doc<"aisdk_chats">,
  workspace: Doc<"workspaces">,
  members: string[],
  wraps: WrapInput[],
  epochs: number[],
  coverage = true,
): Promise<void> {
  if (wraps.length > 1000) {
    invalidKeys();
  }
  // Removal revokes future epochs even when the removed user created the shared chat.
  const creatorIsMember =
    chat.userId === workspace.ownerId ||
    !!(await ctx.db
      .query("workspace_members")
      .withIndex("by_workspace_and_userId", (q) =>
        q.eq("workspace", workspace._id).eq("userId", chat.userId),
      )
      .first());
  const recipients = new Set([...members, ...(creatorIsMember ? [chat.userId] : [])]);
  for (const wrap of wraps) {
    requirePositive(wrap.chatEpoch);
    requireKeyId(wrap.recipientKeyId);
    requireSealedKey(wrap.sealed);
    if (!epochs.includes(wrap.chatEpoch)) {
      invalidKeys();
    }
    if (wrap.recipient === "workspace") {
      if (
        chat.scope !== "workspace" ||
        !workspace.keyEpoch ||
        wrap.workspaceEpoch !== workspace.keyEpoch
      ) {
        invalidKeys();
      }
      const key = await ctx.db
        .query("e2ee_workspace_epochs")
        .withIndex("by_workspace_and_epoch", (q) =>
          q.eq("workspace", workspace._id).eq("epoch", wrap.workspaceEpoch),
        )
        .unique();
      if (!key || key.memberKeyId !== wrap.recipientKeyId) {
        invalidKeys();
      }
    } else {
      if (chat.scope !== "workspace" && !recipients.has(wrap.userId)) {
        invalidKeys();
      }
      if (
        wrap.userId !== workspace.ownerId &&
        !(await ctx.db
          .query("workspace_members")
          .withIndex("by_workspace_and_userId", (q) =>
            q.eq("workspace", workspace._id).eq("userId", wrap.userId),
          )
          .first())
      ) {
        invalidKeys();
      }
      const identity = await activeIdentityFor(ctx, wrap.userId);
      if (!identity || identity.keyId !== wrap.recipientKeyId) {
        invalidKeys();
      }
    }
  }
  if (!coverage) {
    return;
  }
  for (const epoch of epochs) {
    if (chat.scope === "workspace") {
      if (
        !wraps.some(
          (w) =>
            w.chatEpoch === epoch &&
            w.recipient === "workspace" &&
            w.workspaceEpoch === workspace.keyEpoch,
        )
      ) {
        invalidKeys();
      }
    } else {
      for (const userId of recipients) {
        if (
          !wraps.some(
            (w) => w.chatEpoch === epoch && w.recipient === "identity" && w.userId === userId,
          )
        ) {
          invalidKeys();
        }
      }
    }
  }
}
/**
 * Inserts validated wraps and returns how many were stored; callers must authorize and validate
 * first. A wrap for an existing `(chat, chatEpoch, recipientKeyId)` is replaced when the writer is
 * the chat creator or the workspace owner and skipped otherwise, so another accessor's junk
 * ciphertext can neither be overwritten by nor shadow a trusted wrap.
 */
export async function insertChatWraps(
  ctx: MutationCtx,
  chat: Doc<"aisdk_chats">,
  workspace: Doc<"workspaces">,
  wraps: WrapInput[],
  writerId: string,
): Promise<number> {
  const trustedWriter = writerId === chat.userId || writerId === workspace.ownerId;
  let inserted = 0;
  for (const wrap of wraps) {
    const existing = await ctx.db
      .query("e2ee_chat_key_wraps")
      .withIndex("by_chat_and_chatEpoch_and_recipientKeyId", (q) =>
        q
          .eq("chat", chat._id)
          .eq("chatEpoch", wrap.chatEpoch)
          .eq("recipientKeyId", wrap.recipientKeyId),
      )
      .first();
    if (existing) {
      if (!trustedWriter) {
        continue;
      }
      await ctx.db.delete("e2ee_chat_key_wraps", existing._id);
    }
    await ctx.db.insert("e2ee_chat_key_wraps", {
      ...wrap,
      chat: chat._id,
      workspace: workspace._id,
    });
    inserted++;
  }
  return inserted;
}
/** Inserts a verified chat epoch; callers enforce epoch monotonicity and authorization. */
export async function insertChatEpoch(
  ctx: MutationCtx,
  chat: Doc<"aisdk_chats">,
  workspace: Doc<"workspaces">,
  epoch: ChatKeyInput,
  userId: string,
): Promise<void> {
  await ctx.db.insert("e2ee_chat_keys", {
    ...epoch,
    chat: chat._id,
    workspace: workspace._id,
    signerUserId: epoch.signature ? userId : undefined,
    createdAt: Date.now(),
  });
}
/** Atomically validates initial scope coverage, stores epoch one and marks the chat encrypted. */
export async function insertChatKeysSetup(
  ctx: MutationCtx,
  input: {
    chat: Doc<"aisdk_chats">;
    workspace: Doc<"workspaces">;
    members: string[];
    keys: ChatKeysSetup;
  },
): Promise<void> {
  const { chat, workspace, members, keys } = input;
  if (chat.e2eeId || keys.epoch.epoch !== 1) {
    invalidKeys();
  }
  requireKeyId(keys.e2eeId);
  await validateChatEpoch(ctx, workspace, keys.e2eeId, keys.epoch, chat.userId);
  await validateChatWraps(ctx, chat, workspace, members, keys.wraps, [1]);
  await insertChatEpoch(ctx, chat, workspace, keys.epoch, chat.userId);
  await insertChatWraps(ctx, chat, workspace, keys.wraps, chat.userId);
  await ctx.db.patch("aisdk_chats", chat._id, { e2eeId: keys.e2eeId, keyEpoch: 1 });
}
/** Returns authorized public epochs and only wraps usable by the caller. */
export const chatKeys = query({
  args: { chatId: v.id("aisdk_chats") },
  returns: chatKeysResultValidator,
  handler: async (ctx, args) => {
    const { chat, workspace, userId } = await requireAccessibleChat(ctx, args.chatId);
    const epochs = await ctx.db
      .query("e2ee_chat_keys")
      .withIndex("by_chat_and_epoch", (q) => q.eq("chat", chat._id))
      .take(201);
    if (epochs.length > 200) {
      invalidKeys();
    }
    const wraps = [];
    for (const epoch of epochs) {
      const rows = await ctx.db
        .query("e2ee_chat_key_wraps")
        .withIndex("by_chat_and_chatEpoch_and_recipientKeyId", (q) =>
          q.eq("chat", chat._id).eq("chatEpoch", epoch.epoch),
        )
        .take(401);
      if (rows.length > 400) {
        invalidKeys();
      }
      wraps.push(...rows.filter((row) => row.recipient === "workspace" || row.userId === userId));
    }
    return {
      chat: chat._id,
      workspace: workspace._id,
      e2eeId: chat.e2eeId ?? null,
      keyEpoch: chat.keyEpoch ?? null,
      scope: chat.scope ?? "personal",
      creatorId: chat.userId,
      rekey: chat.rekey ?? false,
      workspaceKeyEpoch: workspace.keyEpoch ?? null,
      staleForWorkspace: await chatPredatesWorkspaceKey(ctx, chat, workspace),
      members: await chatMemberIds(ctx, chat._id),
      epochs,
      wraps,
    };
  },
});
/** Encrypts an existing chat without rewriting its historical plaintext. */
export const setupChatKeys = mutation({
  args: { chatId: v.id("aisdk_chats"), keys: chatKeysSetupValidator },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { chat, workspace, userId } = await requireAccessibleChat(ctx, args.chatId);
    if (chat.userId !== userId) {
      invalidKeys();
    }
    await insertChatKeysSetup(ctx, {
      chat,
      workspace,
      members: await chatMemberIds(ctx, chat._id),
      keys: args.keys,
    });
    return null;
  },
});
/** Starts the next epoch with complete recipient coverage and clears revocation rekey state. */
export const rotateChatKey = mutation({
  args: {
    chatId: v.id("aisdk_chats"),
    epoch: chatKeyInputValidator,
    wraps: v.array(wrapInputValidator),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { chat, workspace, userId } = await requireAccessibleChat(ctx, args.chatId);
    if (
      !chat.e2eeId ||
      args.epoch.epoch !== (chat.keyEpoch ?? 0) + 1 ||
      args.epoch.epoch > MAX_CHAT_EPOCHS ||
      !args.epoch.signature
    ) {
      invalidKeys();
    }
    if (!(await canRotateChatKey(ctx, chat, workspace, userId))) {
      invalidKeys();
    }
    await validateChatEpoch(ctx, workspace, chat.e2eeId, args.epoch, userId);
    await validateChatWraps(ctx, chat, workspace, await chatMemberIds(ctx, chat._id), args.wraps, [
      args.epoch.epoch,
    ]);
    await insertChatEpoch(ctx, chat, workspace, args.epoch, userId);
    await insertChatWraps(ctx, chat, workspace, args.wraps, userId);
    await ctx.db.patch("aisdk_chats", chat._id, { keyEpoch: args.epoch.epoch, rekey: false });
    return null;
  },
});
/** Adds active-recipient wraps for existing epochs without duplicating recipients. */
export const addChatKeyWraps = mutation({
  args: { chatId: v.id("aisdk_chats"), wraps: v.array(wrapInputValidator) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { chat, workspace, userId } = await requireAccessibleChat(ctx, args.chatId);
    const epochs = await ctx.db
      .query("e2ee_chat_keys")
      .withIndex("by_chat_and_epoch", (q) => q.eq("chat", chat._id))
      .take(201);
    if (!chat.e2eeId || epochs.length > 200) {
      invalidKeys();
    }
    await validateChatWraps(
      ctx,
      chat,
      workspace,
      await chatMemberIds(ctx, chat._id),
      args.wraps,
      epochs.map((e) => e.epoch),
      false,
    );
    await insertChatWraps(ctx, chat, workspace, args.wraps, userId);
    return null;
  },
});
/** Lets the creator certify an epoch created while locked, never replace an existing signature. */
export const signChatKey = mutation({
  args: {
    chatId: v.id("aisdk_chats"),
    epoch: v.number(),
    signerKeyId: v.string(),
    signature: v.bytes(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { chat, workspace, userId } = await requireAccessibleChat(ctx, args.chatId);
    const epoch = await ctx.db
      .query("e2ee_chat_keys")
      .withIndex("by_chat_and_epoch", (q) => q.eq("chat", chat._id).eq("epoch", args.epoch))
      .unique();
    if (chat.userId !== userId || !chat.e2eeId || !epoch || epoch.signature) {
      invalidKeys();
    }
    await validateChatEpoch(
      ctx,
      workspace,
      chat.e2eeId,
      { ...epoch, signerKeyId: args.signerKeyId, signature: args.signature },
      userId,
    );
    await ctx.db.patch("e2ee_chat_keys", epoch._id, {
      signerUserId: userId,
      signerKeyId: args.signerKeyId,
      signature: args.signature,
    });
    return null;
  },
});
/** Pages stale workspace wraps for owner-driven background rewrapping. */
export const staleWorkspaceWraps = query({
  args: { workspace: v.id("workspaces"), paginationOpts: paginationOptsValidator },
  returns: staleWrapsResultValidator,
  handler: async (ctx, args) => {
    const workspace = await requireOwnedWorkspace(ctx, args.workspace);
    return await ctx.db
      .query("e2ee_chat_key_wraps")
      .withIndex("by_workspace_and_workspaceEpoch", (q) =>
        q
          .eq("workspace", workspace._id)
          .gt("workspaceEpoch", 0)
          .lt("workspaceEpoch", workspace.keyEpoch ?? 0),
      )
      .paginate({ ...args.paginationOpts, numItems: Math.min(args.paginationOpts.numItems, 100) });
  },
});
/** Replaces old workspace wraps only with current-epoch wraps of the same chat epoch. */
export const replaceWorkspaceWraps = mutation({
  args: {
    workspace: v.id("workspaces"),
    replacements: v.array(
      v.object({ oldWrap: v.id("e2ee_chat_key_wraps"), wrap: wrapInputValidator }),
    ),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const workspace = await requireOwnedWorkspace(ctx, args.workspace);
    if (args.replacements.length > 100) {
      invalidKeys();
    }
    for (const replacement of args.replacements) {
      const old = await ctx.db.get("e2ee_chat_key_wraps", replacement.oldWrap);
      if (
        !old ||
        old.workspace !== workspace._id ||
        old.recipient !== "workspace" ||
        !old.workspaceEpoch ||
        old.workspaceEpoch >= (workspace.keyEpoch ?? 0) ||
        replacement.wrap.recipient !== "workspace" ||
        replacement.wrap.chatEpoch !== old.chatEpoch
      ) {
        invalidKeys();
      }
      const chat = await ctx.db.get("aisdk_chats", old.chat);
      // A chat that left workspace scope no longer needs workspace wraps; drop the stale one.
      if (!chat || chat.scope !== "workspace") {
        await ctx.db.delete("e2ee_chat_key_wraps", old._id);
        continue;
      }
      await validateChatWraps(ctx, chat, workspace, [], [replacement.wrap], [old.chatEpoch]);
      // The owner's wrap replaces any junk already stored for the same recipient.
      const inserted = await insertChatWraps(
        ctx,
        chat,
        workspace,
        [replacement.wrap],
        workspace.ownerId,
      );
      if (inserted > 0) {
        await ctx.db.delete("e2ee_chat_key_wraps", old._id);
      }
    }
    return null;
  },
});
