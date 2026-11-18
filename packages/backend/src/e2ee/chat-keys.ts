import { chatKeysResultValidator, staleWrapsResultValidator } from "./responses";
import { ConvexError, v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { chatKeyBindingStatement, chatKeyStatement, equalBytes, verify } from "radium-crypto";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import { mutation, query, type MutationCtx, type QueryCtx } from "../../convex/_generated/server";
import { authComponent } from "../../convex/auth";
import {
  authorizeChatRecord,
  requireAccessibleChat,
  requireOwnedWorkspace,
} from "../../convex/workspaces";
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
import { requestCustodyRelease } from "./migration-contract";
import { workspaceKeyAvailable } from "./workspace-key-availability";
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
/**
 * The exact public recipient an authenticated client prepared one HTTP turn for (`writableChatKey`):
 * the turn is sealed only while the chat's current epoch is still this key.
 */
export type PinnedChatRecipient = {
  userId: string;
  e2eeId: string;
  epoch: number;
  publicKey: ArrayBuffer;
};
/**
 * Reads the current public key for server-side sealing of NEW content (titles, telemetry,
 * notifications), or null while there is no key, it is stale (`chatKeyIsStale`), a workspace chat's
 * member key is unavailable, or the current epoch is not the chat's authenticated bound epoch
 * (`chatEpochIsBound`): unbound keys are read-only history that a rotation must replace. With a
 * client `pinned` recipient the current epoch must also be exactly that key, and only then may the
 * creator's own unsigned epoch one, still recoverable by its current recipients, be used
 * (`ownUnsignedRootRecoverable`). No secret material is returned.
 */
export async function currentChatPublicKey(
  ctx: ReadCtx,
  chat: Doc<"aisdk_chats">,
  workspace: Doc<"workspaces">,
  pinned?: PinnedChatRecipient,
) {
  if (!chat.e2eeId || !chat.keyEpoch || (await chatKeyIsStale(ctx, chat, workspace))) {
    return null;
  }
  if (chat.scope === "workspace" && !(await workspaceKeyAvailable(ctx, workspace, "member"))) {
    return null;
  }
  const key = await ctx.db
    .query("e2ee_chat_keys")
    .withIndex("by_chat_and_epoch", (q) => q.eq("chat", chat._id).eq("epoch", chat.keyEpoch!))
    .unique();
  if (
    !key ||
    (pinned &&
      (pinned.e2eeId !== chat.e2eeId ||
        pinned.epoch !== key.epoch ||
        !equalBytes(new Uint8Array(pinned.publicKey), new Uint8Array(key.publicKey))))
  ) {
    return null;
  }
  if (
    !(await chatEpochIsBound(ctx, chat, workspace, key)) &&
    !(pinned && (await ownUnsignedRootRecoverable(ctx, chat, workspace, key, pinned.userId)))
  ) {
    return null;
  }
  return { epoch: key.epoch, keyId: key.keyId, publicKey: key.publicKey };
}
/**
 * The one unbound epoch a client may still pin: its creator continuing a chat made on a locked
 * device, whose original seed and policy only that device holds (`writableChatKey` pins nothing
 * else; unlocking signs and binds it or rotates). Requires the authenticated creator's current
 * access, epoch one with no signer fields at all, the right suite and key size, and a wrap its
 * current recipients can open: the creator's ACTIVE identity, or for workspace chats the current
 * workspace epoch (whose member key availability the caller checked). Never a sealing target
 * without a pin, and never for the Node legacy recipient, which demands `chatEpochIsBound`.
 */
async function ownUnsignedRootRecoverable(
  ctx: ReadCtx,
  chat: Doc<"aisdk_chats">,
  workspace: Doc<"workspaces">,
  key: Doc<"e2ee_chat_keys">,
  userId: string,
): Promise<boolean> {
  if (
    userId !== chat.userId ||
    key.epoch !== 1 ||
    key.suite !== 1 ||
    key.publicKey.byteLength !== 1216 ||
    key.signature ||
    key.signerKeyId ||
    key.signerUserId ||
    key.bindingSignature ||
    key.bindingMembers ||
    !(await authorizeChatRecord(ctx, chat._id, userId))
  ) {
    return false;
  }
  if (chat.scope === "workspace") {
    const wrap = await newestWorkspaceWrap(ctx, chat._id, key.epoch);
    return !!workspace.keyEpoch && wrap?.workspaceEpoch === workspace.keyEpoch;
  }
  const identity = await activeIdentityFor(ctx, userId);
  if (!identity) {
    return false;
  }
  const wrap = await ctx.db
    .query("e2ee_chat_key_wraps")
    .withIndex("by_chat_and_chatEpoch_and_recipientKeyId", (q) =>
      q.eq("chat", chat._id).eq("chatEpoch", key.epoch).eq("recipientKeyId", identity.keyId),
    )
    .first();
  return wrap?.recipient === "identity" && wrap.userId === userId;
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
 * The raw audience a `bindingSignature` covers: the server-assigned chat ID, scope, creator and the
 * chat's declared picked members (not filtered workspace users). Members only matter for `shared`.
 */
export type ChatBindingPolicy = {
  chat: Id<"aisdk_chats">;
  scope: NonNullable<Doc<"aisdk_chats">["scope"]>;
  creatorId: string;
  members: string[];
};
/**
 * Whether `bindingMembers` is exactly what the binding signed: the canonical (sorted, unique) raw
 * members for `shared`, and empty or absent for other scopes. Stored so clients can still verify
 * the proof after a removal prunes the live member list; the Node recipient additionally demands
 * it equal the CURRENT raw members, so any difference (including departed users) keeps custody.
 */
function bindingMembersMatch(policy: ChatBindingPolicy, supplied: string[] | undefined): boolean {
  if (policy.scope !== "shared") {
    return !supplied || supplied.length === 0;
  }
  const expected = [...new Set(policy.members)].sort();
  return (
    !!supplied &&
    supplied.length === expected.length &&
    supplied.every((member, index) => member === expected[index])
  );
}
/** The chat's current declared policy, as a client must have signed it for the current epoch. */
async function currentBindingPolicy(
  ctx: ReadCtx,
  chat: Doc<"aisdk_chats">,
): Promise<ChatBindingPolicy> {
  return {
    chat: chat._id,
    scope: chat.scope ?? "personal",
    creatorId: chat.userId,
    members: await chatMemberIds(ctx, chat._id),
  };
}
async function verifyChatBinding(
  signingPublicKey: ArrayBuffer,
  workspaceId: Id<"workspaces">,
  e2eeId: string,
  key: { epoch: number; keyId: string; suite: number; publicKey: ArrayBuffer },
  bindingSignature: ArrayBuffer,
  policy: ChatBindingPolicy,
): Promise<boolean> {
  return (
    bindingSignature.byteLength === 64 &&
    (await verify(
      new Uint8Array(signingPublicKey),
      chatKeyBindingStatement({
        chatId: policy.chat,
        workspaceId,
        chatE2eeId: e2eeId,
        epoch: key.epoch,
        keyId: key.keyId,
        suite: key.suite,
        publicKey: new Uint8Array(key.publicKey),
        scope: policy.scope,
        creatorId: policy.creatorId,
        members: policy.members,
      }),
      new Uint8Array(bindingSignature),
    ))
  );
}
/**
 * Whether a stored epoch is safe to encrypt new content or migrated history to: right suite and
 * key size, an original signature by an ACTIVE identity that is the recorded signer, a signer that
 * still has authority over the chat's current scope (creator for personal, creator or picked
 * member for shared, workspace user for workspace), and a binding proof over the exact current
 * chat ID and audience. Anything else (unsigned, retired signer, pre-binding PR epochs, forged or
 * replayed metadata) is read-only history that needs a fresh bound epoch.
 */
export async function chatEpochIsBound(
  ctx: ReadCtx,
  chat: Doc<"aisdk_chats">,
  workspace: Doc<"workspaces">,
  key: Doc<"e2ee_chat_keys">,
): Promise<boolean> {
  if (
    !chat.e2eeId ||
    key.chat !== chat._id ||
    key.suite !== 1 ||
    key.publicKey.byteLength !== 1216 ||
    !key.signature ||
    key.signature.byteLength !== 64 ||
    !key.signerKeyId ||
    !key.signerUserId ||
    !key.bindingSignature
  ) {
    return false;
  }
  const signerKeyId = key.signerKeyId;
  const signer = await ctx.db
    .query("e2ee_identities")
    .withIndex("by_keyId", (q) => q.eq("keyId", signerKeyId))
    .unique();
  if (!signer || signer.userId !== key.signerUserId || signer.status !== "active") {
    return false;
  }
  const original = await verify(
    new Uint8Array(signer.signingPublicKey),
    chatKeyStatement({
      workspaceId: workspace._id,
      chatE2eeId: chat.e2eeId,
      epoch: key.epoch,
      keyId: key.keyId,
      suite: key.suite,
      publicKey: new Uint8Array(key.publicKey),
    }),
    new Uint8Array(key.signature),
  );
  if (!original || !(await authorizeChatRecord(ctx, chat._id, key.signerUserId))) {
    return false;
  }
  const policy = await currentBindingPolicy(ctx, chat);
  // The proof is verified over the CURRENT raw members; the stored copy must be the same canonical
  // list, so any difference (even a departed user) keeps history in custody until a fresh rotation.
  return (
    (await verifyChatBinding(
      signer.signingPublicKey,
      workspace._id,
      chat.e2eeId,
      key,
      key.bindingSignature,
      policy,
    )) && bindingMembersMatch(policy, key.bindingMembers)
  );
}
/**
 * Creators may always rotate. Other accessors may only when the key is stale or its current
 * epoch is not bound (`chatEpochIsBound`: unsigned, retired signer, pre-binding PR epoch or an
 * invalid proof); otherwise any member could rotate a chat to a key only they hold. The new epoch
 * must be bound and cover the full current audience, and the old epoch is never replaced.
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
  return !!current && !(await chatEpochIsBound(ctx, chat, workspace, current));
}
/**
 * Validates a public epoch and any supplied signatures against the authenticated signer. A
 * `bindingSignature` must come with the original signature, by the same signer, and verify over
 * `binding.policy` (the audience the epoch will serve: the NEXT scope and members when it
 * accompanies a scope change). `binding.required` rejects epochs without one.
 */
export async function validateChatEpoch(
  ctx: ReadCtx,
  workspace: Doc<"workspaces">,
  e2eeId: string,
  epoch: ChatKeyInput,
  userId: string,
  binding?: { policy: ChatBindingPolicy; required: boolean },
): Promise<void> {
  requirePositive(epoch.epoch);
  requireKeyId(epoch.keyId);
  if (
    epoch.suite !== 1 ||
    epoch.publicKey.byteLength !== 1216 ||
    !!epoch.signerKeyId !== !!epoch.signature ||
    (epoch.bindingSignature && !epoch.signature) ||
    (epoch.bindingMembers && (!epoch.bindingSignature || epoch.bindingMembers.length > 1000)) ||
    (binding?.required && !epoch.bindingSignature)
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
          epoch: epoch.epoch,
          keyId: epoch.keyId,
          suite: epoch.suite,
          publicKey: new Uint8Array(epoch.publicKey),
        }),
        new Uint8Array(epoch.signature),
      ))
    ) {
      invalidKeys();
    }
    if (
      epoch.bindingSignature &&
      !(
        binding &&
        bindingMembersMatch(binding.policy, epoch.bindingMembers) &&
        (await verifyChatBinding(
          signer.signingPublicKey,
          workspace._id,
          e2eeId,
          epoch,
          epoch.bindingSignature,
          binding.policy,
        ))
      )
    ) {
      invalidKeys();
    }
  }
}
/**
 * Validates recipient identities, current workspace epochs and scope coverage. `members` is the
 * chat's raw picked list; the identity audience of a new epoch is the creator and those members
 * that are still workspace users (owner or explicit member). Removal revokes future epochs even
 * from the shared chat's creator, and a removed member whose `chat_members` row an unfinished
 * removal batch has not deleted yet is neither required nor allowed, so the remaining readers can
 * still key the chat. The raw list stays untouched for narrowing and rekey decisions.
 */
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
  const recipients = new Set<string>();
  for (const userId of new Set([chat.userId, ...members])) {
    const workspaceUser =
      userId === workspace.ownerId ||
      !!(await ctx.db
        .query("workspace_members")
        .withIndex("by_workspace_and_userId", (q) =>
          q.eq("workspace", workspace._id).eq("userId", userId),
        )
        .first());
    if (workspaceUser) {
      recipients.add(userId);
    }
  }
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
  await requestCustodyRelease(ctx, { chat: chat._id });
}
/**
 * Atomically validates initial scope coverage, stores epoch one and marks the chat encrypted.
 * `actor` is the authenticated user supplying the keys; it defaults to the creator, which is the
 * actor whenever a chat is created together with its keys. A supplied signature must be the
 * actor's active identity and records them as the signer. An existing epoch is never replaced, so
 * of two concurrent setups only the first to commit succeeds. `requireBinding` (setup of an
 * existing chat, whose ID the client knows) demands a binding proof over the chat's current scope,
 * creator and raw `members`; creation cannot have one yet and the first writable path rotates.
 */
export async function insertChatKeysSetup(
  ctx: MutationCtx,
  input: {
    chat: Doc<"aisdk_chats">;
    workspace: Doc<"workspaces">;
    members: string[];
    keys: ChatKeysSetup;
    actor?: string;
    requireBinding?: boolean;
  },
): Promise<void> {
  const { chat, workspace, members, keys } = input;
  const actor = input.actor ?? chat.userId;
  const existingEpoch = await ctx.db
    .query("e2ee_chat_keys")
    .withIndex("by_chat_and_epoch", (q) => q.eq("chat", chat._id))
    .first();
  if (chat.e2eeId || chat.keyEpoch || existingEpoch || keys.epoch.epoch !== 1) {
    invalidKeys();
  }
  requireKeyId(keys.e2eeId);
  await validateChatEpoch(ctx, workspace, keys.e2eeId, keys.epoch, actor, {
    policy: { chat: chat._id, scope: chat.scope ?? "personal", creatorId: chat.userId, members },
    required: input.requireBinding ?? false,
  });
  await validateChatWraps(ctx, chat, workspace, members, keys.wraps, [1]);
  await insertChatEpoch(ctx, chat, workspace, keys.epoch, actor);
  await insertChatWraps(ctx, chat, workspace, keys.wraps, actor);
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
/**
 * Gives an existing keyless chat its initial key epoch without rewriting its historical plaintext.
 * Any current reader may do this (the policy for migrated history whose creator is unavailable):
 * `requireAccessibleChat` refuses removed users, outsiders and other users' personal chats. The
 * epoch must be signed by the caller's active identity, so readers authenticate who created it,
 * and must carry a binding proof over this chat's ID, scope, creator and picked members. Its wraps
 * must cover exactly the chat's current audience (`validateChatWraps`): nobody gains
 * access and a creator who left the workspace receives nothing. Recipients without an active
 * identity, or a workspace chat in a workspace without keys, make setup impossible, so history
 * stays in custody until they enrol. Never replaces an existing epoch; the loser of a concurrent
 * setup fails and must read the winner's.
 */
export const setupChatKeys = mutation({
  args: { chatId: v.id("aisdk_chats"), keys: chatKeysSetupValidator },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { chat, workspace, userId } = await requireAccessibleChat(ctx, args.chatId);
    if (!args.keys.epoch.signature || !args.keys.epoch.signerKeyId) {
      invalidKeys();
    }
    await insertChatKeysSetup(ctx, {
      chat,
      workspace,
      members: await chatMemberIds(ctx, chat._id),
      keys: args.keys,
      actor: userId,
      requireBinding: true,
    });
    return null;
  },
});
/**
 * Starts the next epoch with complete recipient coverage and clears revocation rekey state. The
 * epoch must be bound to this chat's current scope and audience; it is also how a reader upgrades
 * a read-only epoch that is unbound (`canRotateChatKey`). Old epochs and their signatures are kept.
 */
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
    const policy = await currentBindingPolicy(ctx, chat);
    await validateChatEpoch(ctx, workspace, chat.e2eeId, args.epoch, userId, {
      policy,
      required: true,
    });
    await validateChatWraps(ctx, chat, workspace, policy.members, args.wraps, [args.epoch.epoch]);
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
/**
 * Lets the creator certify an epoch created while locked, never replace an existing signature.
 * The optional binding proof (over the chat's CURRENT scope, creator and picked members) is only
 * accepted for the current epoch, so an old or already-disclosed key is never newly certified.
 * Signing the current epoch asks for a custody release, which still waits unless the epoch ends up
 * bound.
 */
export const signChatKey = mutation({
  args: {
    chatId: v.id("aisdk_chats"),
    epoch: v.number(),
    signerKeyId: v.string(),
    signature: v.bytes(),
    bindingSignature: v.optional(v.bytes()),
    bindingMembers: v.optional(v.array(v.string())),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { chat, workspace, userId } = await requireAccessibleChat(ctx, args.chatId);
    const epoch = await ctx.db
      .query("e2ee_chat_keys")
      .withIndex("by_chat_and_epoch", (q) => q.eq("chat", chat._id).eq("epoch", args.epoch))
      .unique();
    const current = args.epoch === chat.keyEpoch;
    if (
      chat.userId !== userId ||
      !chat.e2eeId ||
      !epoch ||
      epoch.signature ||
      (args.bindingSignature && !current)
    ) {
      invalidKeys();
    }
    await validateChatEpoch(
      ctx,
      workspace,
      chat.e2eeId,
      {
        ...epoch,
        signerKeyId: args.signerKeyId,
        signature: args.signature,
        bindingSignature: args.bindingSignature,
        bindingMembers: args.bindingMembers,
      },
      userId,
      { policy: await currentBindingPolicy(ctx, chat), required: false },
    );
    await ctx.db.patch("e2ee_chat_keys", epoch._id, {
      signerUserId: userId,
      signerKeyId: args.signerKeyId,
      signature: args.signature,
      bindingSignature: args.bindingSignature,
      bindingMembers: args.bindingMembers,
    });
    if (current) {
      await requestCustodyRelease(ctx, { chat: chat._id });
    }
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
