import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import {
  CAPSULE_BYTES,
  chatKeyBindingStatement,
  chatKeyStatement,
  equalBytes,
  verify,
} from "radium-crypto";
import { z } from "zod";
import { base64urlBytes } from "contracts/wire";
import { chatAccess, requireChatAccess, type Chat, type ChatWorkspace } from "../chatroom/access";
import { chatMemberIds } from "../chatroom/members";
import { chats } from "../chatroom/schema";
import type { Database } from "../drivers/types";
import { workspaceMembers } from "../workspaces/schema";
import { e2eeChatKeys, e2eeChatKeyWraps, e2eeIdentities, e2eeWorkspaceEpochs } from "./schema";
import { chatKeyWire, chatWrapWire } from "./wire";
import {
  activeIdentity,
  invalidKeys,
  lockWorkspaceKeys,
  requireBox,
  requireKeyId,
  requirePositive,
  workspaceKeyAvailable,
} from "./workspace-keys";

/**
 * Chat key records (`docs/E2EE/Keys.md`, `docs/E2EE/Data.md`): per-chat key epochs, the wraps
 * that seal each epoch's seed to its readers, and the rules for when new content may be sealed to
 * an epoch. Ported from Convex `src/e2ee/chat-keys.ts`. The backend checks structure, bounds and
 * signatures; it never holds a chat seed. Every refusal is `E2EE_KEYS_INVALID`.
 */

/** Size of an encoded chat public key (suite 1). */
const CHAT_PUBLIC_KEY_BYTES = 1216;
const SIGNATURE_BYTES = 64;
/** Wraps one write may carry. */
export const MAX_WRAPS = 1000;
/** Members a binding may name. */
const MAX_BINDING_MEMBERS = 1000;
/** Workspace wraps of one epoch that scope narrowing deletes. */
const MAX_EPOCH_WORKSPACE_WRAPS = 200;

const keyIdInput = z.string().max(32);
const userIdInput = z.string().min(1).max(256);

/**
 * A chat key epoch, optionally unsigned when created on a locked device. `bindingSignature` is
 * the signer's `chatKeyBindingStatement` proof over the server-assigned chat id and audience; it
 * needs the original signature, is absent at chat creation (the id is unknown yet), and is
 * required for every epoch created after setup.
 */
export const chatKeyInput = z.object({
  epoch: z.number().int(),
  keyId: keyIdInput,
  suite: z.number().int(),
  publicKey: base64urlBytes(CHAT_PUBLIC_KEY_BYTES),
  signerKeyId: keyIdInput.optional(),
  signature: base64urlBytes(SIGNATURE_BYTES).optional(),
  bindingSignature: base64urlBytes(SIGNATURE_BYTES).optional(),
  /** Canonical raw picked members the binding signed; present exactly for `shared` bindings. */
  bindingMembers: z.array(userIdInput).max(MAX_BINDING_MEMBERS).optional(),
});

/** A chat seed sealed to a workspace member key epoch or to one identity. */
export const wrapInput = z.discriminatedUnion("recipient", [
  z.object({
    chatEpoch: z.number().int(),
    recipient: z.literal("workspace"),
    workspaceEpoch: z.number().int(),
    recipientKeyId: keyIdInput,
    sealed: base64urlBytes(CAPSULE_BYTES + 256),
  }),
  z.object({
    chatEpoch: z.number().int(),
    recipient: z.literal("identity"),
    userId: userIdInput,
    recipientKeyId: keyIdInput,
    sealed: base64urlBytes(CAPSULE_BYTES + 256),
  }),
]);

/** The initial chat epoch and its recipient coverage. */
export const chatKeysSetupInput = z.object({
  e2eeId: keyIdInput,
  epoch: chatKeyInput,
  wraps: z.array(wrapInput).max(MAX_WRAPS),
});

export type ChatKeyInput = z.output<typeof chatKeyInput>;
export type WrapInput = z.output<typeof wrapInput>;
export type ChatKeysSetup = z.output<typeof chatKeysSetupInput>;
export type ChatKey = typeof e2eeChatKeys.$inferSelect;

/** A sealed 32-byte seed is one capsule plus a short envelope; anything larger is junk. */
function requireSealedKey(value: Uint8Array) {
  requireBox(value, CAPSULE_BYTES + 256);
}

/** Whether `userId` owns or is a direct member of `workspace` (no archive check: callers did it). */
async function isWorkspaceUser(db: Database, workspace: ChatWorkspace, userId: string) {
  if (userId === workspace.ownerId) return true;
  const [row] = await db
    .select({ id: workspaceMembers.id })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspace, workspace.id), eq(workspaceMembers.userId, userId)));
  return row !== undefined;
}

/** One stored epoch of a chat's key (public parts and signatures), or undefined. */
export async function chatKeyAt(
  db: Database,
  chatId: string,
  epoch: number,
): Promise<ChatKey | undefined> {
  const [row] = await db
    .select()
    .from(e2eeChatKeys)
    .where(and(eq(e2eeChatKeys.chat, chatId), eq(e2eeChatKeys.epoch, epoch)));
  return row;
}

/**
 * The exact public recipient an authenticated client prepared one `/api/chat` turn for: the turn
 * is sealed only while the chat's current epoch is still this key.
 */
export type PinnedChatRecipient = {
  userId: string;
  e2eeId: string;
  epoch: number;
  publicKey: Uint8Array;
};

/** Where server-side sealing of NEW content (turns, titles) goes. No secret material. */
export type ChatPublicKey = { epoch: number; keyId: string; publicKey: Uint8Array };

/**
 * The current public key for server-side sealing of new content, or null while there is no key,
 * it is stale ({@link chatKeyIsStale}), a workspace chat's member key is unavailable, or the
 * current epoch is not the chat's authenticated bound epoch ({@link chatEpochIsBound}): unbound
 * keys are read-only history a rotation must replace. With a client `pinned` recipient the
 * current epoch must also be exactly that key, and only then may the creator's own unsigned epoch
 * one, still recoverable by its current recipients, be used.
 */
export async function currentChatPublicKey(
  db: Database,
  chat: Chat,
  workspace: ChatWorkspace,
  pinned?: PinnedChatRecipient,
): Promise<ChatPublicKey | null> {
  if (!chat.e2eeId || !chat.keyEpoch || (await chatKeyIsStale(db, chat, workspace))) {
    return null;
  }
  if (chat.scope === "workspace" && !(await workspaceKeyAvailable(db, workspace, "member"))) {
    return null;
  }
  const key = await chatKeyAt(db, chat.id, chat.keyEpoch);
  if (
    !key ||
    (pinned &&
      (pinned.e2eeId !== chat.e2eeId ||
        pinned.epoch !== key.epoch ||
        !equalBytes(pinned.publicKey, key.publicKey)))
  ) {
    return null;
  }
  if (
    !(await chatEpochIsBound(db, chat, workspace, key)) &&
    !(pinned && (await ownUnsignedRootRecoverable(db, chat, workspace, key, pinned.userId)))
  ) {
    return null;
  }
  return { epoch: key.epoch, keyId: key.keyId, publicKey: key.publicKey };
}

/**
 * The one unbound epoch a client may still pin: its creator continuing a chat made on a locked
 * device. Requires the creator's current access, epoch one with no signer fields at all, the
 * right suite and key size, and a wrap its current recipients can open: the creator's active
 * identity, or for workspace chats the current workspace epoch.
 */
async function ownUnsignedRootRecoverable(
  db: Database,
  chat: Chat,
  workspace: ChatWorkspace,
  key: ChatKey,
  userId: string,
): Promise<boolean> {
  if (
    userId !== chat.userId ||
    key.epoch !== 1 ||
    key.suite !== 1 ||
    key.publicKey.byteLength !== CHAT_PUBLIC_KEY_BYTES ||
    key.signature ||
    key.signerKeyId ||
    key.signerUserId ||
    key.bindingSignature ||
    key.bindingMembers ||
    !(await chatAccess(db, userId, chat.id))
  ) {
    return false;
  }
  if (chat.scope === "workspace") {
    const wrap = await newestWorkspaceWrap(db, chat.id, key.epoch);
    return !!workspace.keyEpoch && wrap?.workspaceEpoch === workspace.keyEpoch;
  }
  const identity = await activeIdentity(db, userId);
  if (!identity) return false;
  const [wrap] = await db
    .select({ recipient: e2eeChatKeyWraps.recipient, userId: e2eeChatKeyWraps.userId })
    .from(e2eeChatKeyWraps)
    .where(
      and(
        eq(e2eeChatKeyWraps.chat, chat.id),
        eq(e2eeChatKeyWraps.chatEpoch, key.epoch),
        eq(e2eeChatKeyWraps.recipientKeyId, identity.keyId),
      ),
    );
  return wrap?.recipient === "identity" && wrap.userId === userId;
}

/**
 * Every key epoch number of a keyed chat. Epochs are contiguous: setup creates epoch 1 and every
 * later epoch is exactly `key_epoch + 1`.
 */
export function chatEpochNumbers(chat: Pick<Chat, "keyEpoch">): number[] {
  return Array.from({ length: chat.keyEpoch ?? 0 }, (_, index) => index + 1);
}

/** The newest workspace wrap of one chat key epoch. */
export async function newestWorkspaceWrap(db: Database, chatId: string, chatEpoch: number) {
  const [row] = await db
    .select()
    .from(e2eeChatKeyWraps)
    .where(
      and(
        eq(e2eeChatKeyWraps.chat, chatId),
        eq(e2eeChatKeyWraps.chatEpoch, chatEpoch),
        gt(e2eeChatKeyWraps.workspaceEpoch, 0),
      ),
    )
    .orderBy(desc(e2eeChatKeyWraps.workspaceEpoch))
    .limit(1);
  return row;
}

/**
 * Whether a workspace chat's current key epoch predates the workspace's current key epoch. A
 * rotation (for example after a member's removal) leaves earlier workspace keys able to open it,
 * so it needs a new chat epoch whatever the owner's rewrap has since added to older ones.
 */
export async function chatPredatesWorkspaceKey(
  db: Database,
  chat: Chat,
  workspace: ChatWorkspace,
): Promise<boolean> {
  if (chat.scope !== "workspace" || !chat.e2eeId || !workspace.keyEpoch || !chat.keyEpoch) {
    return false;
  }
  const [row] = await db
    .select({ keyCreatedAt: e2eeChatKeys.createdAt, epochCreatedAt: e2eeWorkspaceEpochs.createdAt })
    .from(e2eeChatKeys)
    .innerJoin(
      e2eeWorkspaceEpochs,
      and(
        eq(e2eeWorkspaceEpochs.workspace, workspace.id),
        eq(e2eeWorkspaceEpochs.epoch, workspace.keyEpoch),
      ),
    )
    .where(and(eq(e2eeChatKeys.chat, chat.id), eq(e2eeChatKeys.epoch, chat.keyEpoch)));
  return !!row && row.keyCreatedAt < row.epochCreatedAt;
}

/**
 * A keyed chat must start a new chat key epoch before anything is sealed to it when a recipient
 * lost access (`rekey`) or its workspace key rotated since the chat's current epoch was made.
 */
export async function chatKeyIsStale(
  db: Database,
  chat: Chat,
  workspace: ChatWorkspace,
): Promise<boolean> {
  if (!chat.e2eeId) return false;
  return chat.rekey || (await chatPredatesWorkspaceKey(db, chat, workspace));
}

/**
 * The raw audience a `bindingSignature` covers: the server-assigned chat id, scope, creator and
 * the chat's declared picked members (not filtered workspace users). Members only matter for
 * `shared`.
 */
export type ChatBindingPolicy = {
  chat: string;
  scope: Chat["scope"];
  creatorId: string;
  members: string[];
};

/**
 * Whether `bindingMembers` is exactly what the binding signed: the canonical (sorted, unique) raw
 * members for `shared`, and empty or absent for other scopes.
 */
function bindingMembersMatch(policy: ChatBindingPolicy, supplied: string[] | null | undefined) {
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
export async function currentBindingPolicy(db: Database, chat: Chat): Promise<ChatBindingPolicy> {
  return {
    chat: chat.id,
    scope: chat.scope,
    creatorId: chat.userId,
    members: await chatMemberIds(db, chat.id),
  };
}

async function verifyChatBinding(
  signingPublicKey: Uint8Array,
  workspaceId: string,
  e2eeId: string,
  key: { epoch: number; keyId: string; suite: number; publicKey: Uint8Array },
  bindingSignature: Uint8Array,
  policy: ChatBindingPolicy,
): Promise<boolean> {
  return (
    bindingSignature.byteLength === SIGNATURE_BYTES &&
    (await verify(
      signingPublicKey,
      chatKeyBindingStatement({
        chatId: policy.chat,
        workspaceId,
        chatE2eeId: e2eeId,
        epoch: key.epoch,
        keyId: key.keyId,
        suite: key.suite,
        publicKey: key.publicKey,
        scope: policy.scope,
        creatorId: policy.creatorId,
        members: policy.members,
      }),
      bindingSignature,
    ))
  );
}

/**
 * Whether a stored epoch is safe to encrypt new content to: right suite and key size, an original
 * signature by an active identity that is the recorded signer, a signer that still has access to
 * the chat under its current scope, and a binding proof over the exact current chat id and
 * audience. Anything else (unsigned, retired signer, forged or replayed metadata) is read-only
 * history that needs a fresh bound epoch.
 */
export async function chatEpochIsBound(
  db: Database,
  chat: Chat,
  workspace: ChatWorkspace,
  key: ChatKey,
): Promise<boolean> {
  if (
    !chat.e2eeId ||
    key.chat !== chat.id ||
    key.suite !== 1 ||
    key.publicKey.byteLength !== CHAT_PUBLIC_KEY_BYTES ||
    !key.signature ||
    key.signature.byteLength !== SIGNATURE_BYTES ||
    !key.signerKeyId ||
    !key.signerUserId ||
    !key.bindingSignature
  ) {
    return false;
  }
  const [signer] = await db
    .select()
    .from(e2eeIdentities)
    .where(eq(e2eeIdentities.keyId, key.signerKeyId));
  if (!signer || signer.userId !== key.signerUserId || signer.status !== "active") {
    return false;
  }
  const original = await verify(
    signer.signingPublicKey,
    chatKeyStatement({
      workspaceId: workspace.id,
      chatE2eeId: chat.e2eeId,
      epoch: key.epoch,
      keyId: key.keyId,
      suite: key.suite,
      publicKey: key.publicKey,
    }),
    key.signature,
  );
  if (!original || !(await chatAccess(db, key.signerUserId, chat.id))) {
    return false;
  }
  const policy = await currentBindingPolicy(db, chat);
  // Verified over the current raw members; the stored copy must be the same canonical list.
  return (
    (await verifyChatBinding(
      signer.signingPublicKey,
      workspace.id,
      chat.e2eeId,
      key,
      key.bindingSignature,
      policy,
    )) && bindingMembersMatch(policy, key.bindingMembers)
  );
}

/**
 * Creators may always rotate. Other accessors may only when the key is stale or its current
 * epoch is not bound; otherwise any member could rotate a chat to a key only they hold. The
 * workspace owner may also replace a bound epoch signed by neither the creator nor the owner.
 */
export async function canRotateChatKey(
  db: Database,
  chat: Chat,
  workspace: ChatWorkspace,
  userId: string,
): Promise<boolean> {
  if (chat.userId === userId || (await chatKeyIsStale(db, chat, workspace))) {
    return true;
  }
  const current = chat.keyEpoch ? await chatKeyAt(db, chat.id, chat.keyEpoch) : undefined;
  if (!current) return false;
  if (userId === workspace.ownerId) {
    const trustedSigner =
      current.signerUserId === chat.userId || current.signerUserId === workspace.ownerId;
    return !(trustedSigner && (await chatEpochIsBound(db, chat, workspace, current)));
  }
  return !(await chatEpochIsBound(db, chat, workspace, current));
}

/**
 * Validates a public epoch and any supplied signatures against the authenticated signer. A
 * `bindingSignature` must come with the original signature, by the same signer, and verify over
 * `binding.policy` (the audience the epoch will serve: the next scope and members when it comes
 * with a scope change). `binding.required` refuses epochs without one.
 */
export async function validateChatEpoch(
  db: Database,
  workspace: ChatWorkspace,
  e2eeId: string,
  epoch: ChatKeyInput,
  userId: string,
  binding?: { policy: ChatBindingPolicy; required: boolean },
): Promise<void> {
  requirePositive(epoch.epoch);
  requireKeyId(epoch.keyId);
  if (
    epoch.suite !== 1 ||
    epoch.publicKey.byteLength !== CHAT_PUBLIC_KEY_BYTES ||
    !!epoch.signerKeyId !== !!epoch.signature ||
    (epoch.bindingSignature && !epoch.signature) ||
    (epoch.bindingMembers &&
      (!epoch.bindingSignature || epoch.bindingMembers.length > MAX_BINDING_MEMBERS)) ||
    (binding?.required && !epoch.bindingSignature)
  ) {
    invalidKeys();
  }
  if (!epoch.signerKeyId || !epoch.signature) return;
  requireKeyId(epoch.signerKeyId);
  const signer = await activeIdentity(db, userId);
  if (
    !signer ||
    signer.keyId !== epoch.signerKeyId ||
    epoch.signature.byteLength !== SIGNATURE_BYTES ||
    !(await verify(
      signer.signingPublicKey,
      chatKeyStatement({
        workspaceId: workspace.id,
        chatE2eeId: e2eeId,
        epoch: epoch.epoch,
        keyId: epoch.keyId,
        suite: epoch.suite,
        publicKey: epoch.publicKey,
      }),
      epoch.signature,
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
        workspace.id,
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

/**
 * Validates recipient identities, current workspace epochs and scope coverage. `chat` carries
 * the scope being written; `members` is its raw picked list. The identity audience of an epoch is
 * the creator and those members that are still workspace users: removal revokes future epochs
 * even from a shared chat's creator. With `coverage`, every epoch in `epochs` must be wrapped to
 * the whole audience.
 */
export async function validateChatWraps(
  db: Database,
  chat: Pick<Chat, "userId" | "scope">,
  workspace: ChatWorkspace,
  members: string[],
  wraps: WrapInput[],
  epochs: number[],
  coverage = true,
): Promise<void> {
  if (wraps.length > MAX_WRAPS) invalidKeys();
  const candidates = [...new Set([chat.userId, ...members])];
  const workspaceUsers = new Set(await workspaceUsersAmong(db, workspace, candidates));
  const recipients = new Set(candidates.filter((userId) => workspaceUsers.has(userId)));
  const identityTargets = [
    ...new Set(wraps.flatMap((wrap) => (wrap.recipient === "identity" ? [wrap.userId] : []))),
  ];
  const targetUsers = new Set(await workspaceUsersAmong(db, workspace, identityTargets));
  const identities = new Map(
    identityTargets.length === 0
      ? []
      : (
          await db
            .select({ userId: e2eeIdentities.userId, keyId: e2eeIdentities.keyId })
            .from(e2eeIdentities)
            .where(
              and(
                inArray(e2eeIdentities.userId, identityTargets),
                eq(e2eeIdentities.status, "active"),
              ),
            )
        ).map((row) => [row.userId, row.keyId]),
  );
  const workspaceEpoch = workspace.keyEpoch
    ? (
        await db
          .select({ memberKeyId: e2eeWorkspaceEpochs.memberKeyId })
          .from(e2eeWorkspaceEpochs)
          .where(
            and(
              eq(e2eeWorkspaceEpochs.workspace, workspace.id),
              eq(e2eeWorkspaceEpochs.epoch, workspace.keyEpoch),
            ),
          )
      )[0]
    : undefined;

  for (const wrap of wraps) {
    requirePositive(wrap.chatEpoch);
    requireKeyId(wrap.recipientKeyId);
    requireSealedKey(wrap.sealed);
    if (!epochs.includes(wrap.chatEpoch)) invalidKeys();
    if (wrap.recipient === "workspace") {
      if (
        chat.scope !== "workspace" ||
        !workspace.keyEpoch ||
        wrap.workspaceEpoch !== workspace.keyEpoch ||
        workspaceEpoch?.memberKeyId !== wrap.recipientKeyId
      ) {
        invalidKeys();
      }
    } else {
      if (chat.scope !== "workspace" && !recipients.has(wrap.userId)) invalidKeys();
      if (!targetUsers.has(wrap.userId)) invalidKeys();
      if (identities.get(wrap.userId) !== wrap.recipientKeyId) invalidKeys();
    }
  }
  if (!coverage) return;
  for (const epoch of epochs) {
    if (chat.scope === "workspace") {
      if (
        !wraps.some(
          (wrap) =>
            wrap.chatEpoch === epoch &&
            wrap.recipient === "workspace" &&
            wrap.workspaceEpoch === workspace.keyEpoch,
        )
      ) {
        invalidKeys();
      }
    } else {
      for (const userId of recipients) {
        if (
          !wraps.some(
            (wrap) =>
              wrap.chatEpoch === epoch && wrap.recipient === "identity" && wrap.userId === userId,
          )
        ) {
          invalidKeys();
        }
      }
    }
  }
}

/** The users among `userIds` that own or are direct members of `workspace`. */
async function workspaceUsersAmong(
  db: Database,
  workspace: ChatWorkspace,
  userIds: string[],
): Promise<string[]> {
  const others = userIds.filter((userId) => userId !== workspace.ownerId);
  const members =
    others.length === 0
      ? []
      : await db
          .select({ userId: workspaceMembers.userId })
          .from(workspaceMembers)
          .where(
            and(
              eq(workspaceMembers.workspace, workspace.id),
              inArray(workspaceMembers.userId, others),
            ),
          );
  return [
    ...(userIds.includes(workspace.ownerId) ? [workspace.ownerId] : []),
    ...members.map((row) => row.userId),
  ];
}

/**
 * Inserts validated wraps and returns how many were stored; callers authorize and validate first.
 * A wrap for an existing `(chat, chat_epoch, recipient_key_id)` is replaced when the writer is the
 * chat creator or the workspace owner and skipped otherwise, so another accessor's junk ciphertext
 * can neither overwrite nor shadow a trusted wrap.
 */
export async function insertChatWraps(
  tx: Database,
  chat: Chat,
  workspace: ChatWorkspace,
  wraps: WrapInput[],
  writerId: string,
): Promise<number> {
  if (wraps.length === 0) return 0;
  const trustedWriter = writerId === chat.userId || writerId === workspace.ownerId;
  const rows = wraps.map((wrap) => ({
    chat: chat.id,
    workspace: workspace.id,
    chatEpoch: wrap.chatEpoch,
    recipient: wrap.recipient,
    userId: wrap.recipient === "identity" ? wrap.userId : null,
    workspaceEpoch: wrap.recipient === "workspace" ? wrap.workspaceEpoch : null,
    recipientKeyId: wrap.recipientKeyId,
    sealed: wrap.sealed,
  }));
  const target = [e2eeChatKeyWraps.chat, e2eeChatKeyWraps.chatEpoch, e2eeChatKeyWraps.recipientKeyId];
  let inserted = 0;
  // One row at a time: a batch naming the same recipient twice must behave like two writes.
  for (const row of rows) {
    const written = trustedWriter
      ? await tx
          .insert(e2eeChatKeyWraps)
          .values(row)
          .onConflictDoUpdate({
            target,
            set: {
              recipient: row.recipient,
              userId: row.userId,
              workspaceEpoch: row.workspaceEpoch,
              sealed: row.sealed,
            },
          })
          .returning({ id: e2eeChatKeyWraps.id })
      : await tx
          .insert(e2eeChatKeyWraps)
          .values(row)
          .onConflictDoNothing({ target })
          .returning({ id: e2eeChatKeyWraps.id });
    inserted += written.length;
  }
  return inserted;
}

/**
 * Inserts a verified chat epoch; callers enforce the epoch sequence (under the chat row lock) and
 * authorization. The unique `(chat, epoch)` refuses a second insert of the same epoch.
 */
export async function insertChatEpoch(
  tx: Database,
  chat: Chat,
  epoch: ChatKeyInput,
  userId: string,
): Promise<void> {
  await tx.insert(e2eeChatKeys).values({
    chat: chat.id,
    epoch: epoch.epoch,
    keyId: epoch.keyId,
    suite: epoch.suite,
    publicKey: epoch.publicKey,
    signerUserId: epoch.signature ? userId : null,
    signerKeyId: epoch.signerKeyId ?? null,
    signature: epoch.signature ?? null,
    bindingSignature: epoch.bindingSignature ?? null,
    bindingMembers: epoch.bindingMembers ?? null,
  });
}

/**
 * Validates initial scope coverage, stores epoch one and marks the chat encrypted, in the
 * caller's transaction. `actor` supplies the keys (the creator at chat creation). A supplied
 * signature must be the actor's active identity. `requireBinding` (setup of an existing chat,
 * whose id the client knows) demands a binding proof over its current scope, creator and raw
 * `members`; creation cannot have one yet and the first writable path rotates. An existing epoch
 * is never replaced: the caller holds the chat row lock and the unique `(chat, epoch)` backs it.
 */
export async function insertChatKeysSetup(
  tx: Database,
  input: {
    chat: Chat;
    workspace: ChatWorkspace;
    members: string[];
    keys: ChatKeysSetup;
    actor?: string;
    requireBinding?: boolean;
  },
): Promise<Chat> {
  const { chat, workspace, members, keys } = input;
  const actor = input.actor ?? chat.userId;
  if (chat.e2eeId || chat.keyEpoch || keys.epoch.epoch !== 1) invalidKeys();
  const [existing] = await tx
    .select({ id: e2eeChatKeys.id })
    .from(e2eeChatKeys)
    .where(eq(e2eeChatKeys.chat, chat.id))
    .limit(1);
  if (existing) invalidKeys();
  requireKeyId(keys.e2eeId);
  await validateChatEpoch(tx, workspace, keys.e2eeId, keys.epoch, actor, {
    policy: { chat: chat.id, scope: chat.scope, creatorId: chat.userId, members },
    required: input.requireBinding ?? false,
  });
  await validateChatWraps(tx, chat, workspace, members, keys.wraps, [1]);
  await insertChatEpoch(tx, chat, keys.epoch, actor);
  const [updated] = await tx
    .update(chats)
    .set({ e2eeId: keys.e2eeId, keyEpoch: 1 })
    .where(eq(chats.id, chat.id))
    .returning();
  await insertChatWraps(tx, updated!, workspace, keys.wraps, actor);
  return updated!;
}

/**
 * Gives an existing keyless chat its first key epoch (Convex `setupChatKeys`). Any current reader
 * may: the access function refuses removed users and outsiders. The epoch must be signed and bound
 * to the chat's current audience.
 */
export async function setupChatKeys(
  db: Database,
  userId: string,
  input: { chatId: string; keys: ChatKeysSetup },
): Promise<void> {
  await db.transaction(async (tx) => {
    const { chat, workspace } = await requireChatAccess(tx, userId, input.chatId, "update");
    if (!input.keys.epoch.signature || !input.keys.epoch.signerKeyId) invalidKeys();
    await insertChatKeysSetup(tx, {
      chat,
      workspace,
      members: await chatMemberIds(tx, chat.id),
      keys: input.keys,
      actor: userId,
      requireBinding: true,
    });
  });
}

/**
 * Starts the next epoch with complete recipient coverage and clears `rekey` (Convex
 * `rotateChatKey`). The epoch must be bound to the chat's current scope and audience. Two
 * concurrent rotations to the same epoch serialize on the chat row; the second is refused.
 */
export async function rotateChatKey(
  db: Database,
  userId: string,
  input: { chatId: string; epoch: ChatKeyInput; wraps: WrapInput[] },
): Promise<void> {
  await db.transaction(async (tx) => {
    const { chat, workspace } = await requireChatAccess(tx, userId, input.chatId, "update");
    if (
      !chat.e2eeId ||
      input.epoch.epoch !== (chat.keyEpoch ?? 0) + 1 ||
      !input.epoch.signature
    ) {
      invalidKeys();
    }
    if (!(await canRotateChatKey(tx, chat, workspace, userId))) invalidKeys();
    const policy = await currentBindingPolicy(tx, chat);
    await validateChatEpoch(tx, workspace, chat.e2eeId, input.epoch, userId, {
      policy,
      required: true,
    });
    await validateChatWraps(tx, chat, workspace, policy.members, input.wraps, [input.epoch.epoch]);
    await insertChatEpoch(tx, chat, input.epoch, userId);
    await tx
      .update(chats)
      .set({ keyEpoch: input.epoch.epoch, rekey: false })
      .where(eq(chats.id, chat.id));
    await insertChatWraps(tx, chat, workspace, input.wraps, userId);
  });
}

/**
 * Deletes the workspace wraps of `epochs` when a chat leaves workspace scope, so no member key can
 * open them any more. Bounded per epoch.
 */
export async function deleteWorkspaceWraps(tx: Database, chatId: string, epochs: number[]) {
  for (const epoch of epochs) {
    const stale = await tx
      .select({ id: e2eeChatKeyWraps.id })
      .from(e2eeChatKeyWraps)
      .where(
        and(
          eq(e2eeChatKeyWraps.chat, chatId),
          eq(e2eeChatKeyWraps.chatEpoch, epoch),
          isNotNull(e2eeChatKeyWraps.workspaceEpoch),
        ),
      )
      .limit(MAX_EPOCH_WORKSPACE_WRAPS + 1);
    if (stale.length > MAX_EPOCH_WORKSPACE_WRAPS) invalidKeys();
    if (stale.length > 0) {
      await tx.delete(e2eeChatKeyWraps).where(
        inArray(
          e2eeChatKeyWraps.id,
          stale.map((row) => row.id),
        ),
      );
    }
  }
}

/**
 * The one wrap a Home row needs to open a chat's title: the caller's identity wrap, else the
 * newest workspace wrap for workspace chats. Point lookups.
 */
export async function callerTitleWrap(
  db: Database,
  chat: Chat,
  chatEpoch: number,
  userId: string,
  identityKeyId: string | undefined,
) {
  if (identityKeyId) {
    const [own] = await db
      .select()
      .from(e2eeChatKeyWraps)
      .where(
        and(
          eq(e2eeChatKeyWraps.chat, chat.id),
          eq(e2eeChatKeyWraps.chatEpoch, chatEpoch),
          eq(e2eeChatKeyWraps.recipientKeyId, identityKeyId),
        ),
      );
    if (own?.recipient === "identity" && own.userId === userId) return own;
  }
  return chat.scope === "workspace" ? await newestWorkspaceWrap(db, chat.id, chatEpoch) : undefined;
}

/** Newest chat key epochs {@link chatKeys} returns without an explicit `epoch`. */
export const CHAT_KEY_EPOCH_WINDOW = 32;
/** Stale workspace wraps per {@link staleWorkspaceWraps} page, and replacements per call. */
export const MAX_REWRAP_PAGE = 100;

/**
 * Public epochs of a chat the caller can read and only the wraps usable by the caller (workspace
 * wraps, and identity wraps addressed to the caller): exactly `epoch` when given (empty when it
 * does not exist), otherwise the newest {@link CHAT_KEY_EPOCH_WINDOW} epochs ascending. Clients
 * read older epochs one at a time by `epoch`.
 */
export async function chatKeys(
  db: Database,
  userId: string,
  input: { chatId: string; epoch?: number },
) {
  const { chat, workspace } = await requireChatAccess(db, userId, input.chatId);
  const epochs =
    input.epoch === undefined
      ? (
          await db
            .select()
            .from(e2eeChatKeys)
            .where(eq(e2eeChatKeys.chat, chat.id))
            .orderBy(desc(e2eeChatKeys.epoch))
            .limit(CHAT_KEY_EPOCH_WINDOW)
        ).reverse()
      : await db
          .select()
          .from(e2eeChatKeys)
          .where(and(eq(e2eeChatKeys.chat, chat.id), eq(e2eeChatKeys.epoch, input.epoch)));
  const wraps =
    epochs.length === 0
      ? []
      : await db
          .select()
          .from(e2eeChatKeyWraps)
          .where(
            and(
              eq(e2eeChatKeyWraps.chat, chat.id),
              inArray(
                e2eeChatKeyWraps.chatEpoch,
                epochs.map((row) => row.epoch),
              ),
              or(eq(e2eeChatKeyWraps.recipient, "workspace"), eq(e2eeChatKeyWraps.userId, userId)),
            ),
          )
          .orderBy(asc(e2eeChatKeyWraps.chatEpoch), asc(e2eeChatKeyWraps.id));
  return {
    chat: chat.id,
    workspace: workspace.id,
    e2eeId: chat.e2eeId,
    keyEpoch: chat.keyEpoch,
    scope: chat.scope,
    creatorId: chat.userId,
    rekey: chat.rekey,
    workspaceKeyEpoch: workspace.keyEpoch,
    /** The chat's current key epoch predates the workspace's current key; rotate before writing. */
    staleForWorkspace: await chatPredatesWorkspaceKey(db, chat, workspace),
    members: await chatMemberIds(db, chat.id),
    epochs: epochs.map(chatKeyWire),
    wraps: wraps.map(chatWrapWire),
  };
}

/**
 * Adds wraps of existing epochs for current recipients (Convex `addChatKeyWraps`); coverage is
 * not required. A wrap for a recipient key that already has one is replaced only by the chat
 * creator or workspace owner ({@link insertChatWraps}). Holds the chat row in share mode, so a
 * concurrent scope change or rotation cannot change the audience being checked.
 */
export async function addChatKeyWraps(
  db: Database,
  userId: string,
  input: { chatId: string; wraps: WrapInput[] },
): Promise<void> {
  await db.transaction(async (tx) => {
    const { chat, workspace } = await requireChatAccess(tx, userId, input.chatId, "share");
    if (!chat.e2eeId) invalidKeys();
    await validateChatWraps(
      tx,
      chat,
      workspace,
      await chatMemberIds(tx, chat.id),
      input.wraps,
      chatEpochNumbers(chat),
      false,
    );
    await insertChatWraps(tx, chat, workspace, input.wraps, userId);
  });
}

export const signChatKeyInput = z.object({
  epoch: z.number().int(),
  signerKeyId: keyIdInput,
  signature: base64urlBytes(SIGNATURE_BYTES),
  bindingSignature: base64urlBytes(SIGNATURE_BYTES).optional(),
  bindingMembers: z.array(userIdInput).max(MAX_BINDING_MEMBERS).optional(),
});

/**
 * Lets the creator certify an epoch created on a locked device; an existing signature is never
 * replaced. The optional binding proof (over the chat's current scope, creator and picked members)
 * is accepted for the current epoch only, so an old or already-disclosed key is never newly
 * certified for new content.
 */
export async function signChatKey(
  db: Database,
  userId: string,
  input: z.output<typeof signChatKeyInput> & { chatId: string },
): Promise<void> {
  await db.transaction(async (tx) => {
    const { chat, workspace } = await requireChatAccess(tx, userId, input.chatId, "update");
    const key = await chatKeyAt(tx, chat.id, input.epoch);
    if (
      chat.userId !== userId ||
      !chat.e2eeId ||
      !key ||
      key.signature ||
      (input.bindingSignature && input.epoch !== chat.keyEpoch)
    ) {
      invalidKeys();
    }
    await validateChatEpoch(
      tx,
      workspace,
      chat.e2eeId,
      {
        epoch: key.epoch,
        keyId: key.keyId,
        suite: key.suite,
        publicKey: key.publicKey,
        signerKeyId: input.signerKeyId,
        signature: input.signature,
        bindingSignature: input.bindingSignature,
        bindingMembers: input.bindingMembers,
      },
      userId,
      { policy: await currentBindingPolicy(tx, chat), required: false },
    );
    await tx
      .update(e2eeChatKeys)
      .set({
        signerUserId: userId,
        signerKeyId: input.signerKeyId,
        signature: input.signature,
        bindingSignature: input.bindingSignature ?? null,
        bindingMembers: input.bindingMembers ?? null,
      })
      .where(and(eq(e2eeChatKeys.id, key.id), isNull(e2eeChatKeys.signature)));
  });
}

/** Keyset position in {@link staleWorkspaceWraps}: the last wrap of the previous page. */
export const staleWrapCursorInput = z.object({
  workspaceEpoch: z.number().int(),
  id: z.string().min(1).max(64),
});

/**
 * Owner-only: one page of workspace wraps sealed to a member key older than the current epoch,
 * for the owner's background rewrap, ordered by `(workspace_epoch, id)`. `cursor` is `null` on the
 * last page.
 */
export async function staleWorkspaceWraps(
  db: Database,
  workspace: ChatWorkspace,
  input: { cursor?: z.output<typeof staleWrapCursorInput> | null; limit: number },
) {
  const { cursor } = input;
  const limit = Math.min(input.limit, MAX_REWRAP_PAGE);
  const rows = await db
    .select()
    .from(e2eeChatKeyWraps)
    .where(
      and(
        eq(e2eeChatKeyWraps.workspace, workspace.id),
        gt(e2eeChatKeyWraps.workspaceEpoch, 0),
        lt(e2eeChatKeyWraps.workspaceEpoch, workspace.keyEpoch ?? 0),
        cursor
          ? sql`(${e2eeChatKeyWraps.workspaceEpoch}, ${e2eeChatKeyWraps.id}) > (${cursor.workspaceEpoch}, ${cursor.id})`
          : undefined,
      ),
    )
    .orderBy(asc(e2eeChatKeyWraps.workspaceEpoch), asc(e2eeChatKeyWraps.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    page: page.map(chatWrapWire),
    cursor:
      rows.length > limit && last ? { workspaceEpoch: last.workspaceEpoch!, id: last.id } : null,
  };
}

/**
 * Owner-only: replaces stale workspace wraps with wraps of the same chat epoch sealed to the
 * current member key. The owner's wrap replaces any junk stored for the same recipient; a stale
 * wrap of a chat that left workspace scope is dropped instead. Holds the workspace row lock, so
 * the current epoch cannot move during the replacement.
 */
export async function replaceWorkspaceWraps(
  db: Database,
  workspaceId: string,
  userId: string,
  replacements: { oldWrap: string; wrap: WrapInput }[],
): Promise<void> {
  if (replacements.length > MAX_REWRAP_PAGE) invalidKeys();
  await db.transaction(async (tx) => {
    const workspace = await lockWorkspaceKeys(tx, workspaceId, userId, true);
    for (const { oldWrap, wrap } of replacements) {
      const [old] = await tx
        .select()
        .from(e2eeChatKeyWraps)
        .where(and(eq(e2eeChatKeyWraps.id, oldWrap), eq(e2eeChatKeyWraps.workspace, workspace.id)));
      if (
        !old ||
        old.recipient !== "workspace" ||
        !old.workspaceEpoch ||
        old.workspaceEpoch >= (workspace.keyEpoch ?? 0) ||
        wrap.recipient !== "workspace" ||
        wrap.chatEpoch !== old.chatEpoch ||
        wrap.recipientKeyId === old.recipientKeyId
      ) {
        invalidKeys();
      }
      const access = await chatAccess(tx, workspace.ownerId, old.chat, "share");
      if (access?.chat.scope === "workspace") {
        await validateChatWraps(tx, access.chat, workspace, [], [wrap], [old.chatEpoch]);
        if ((await insertChatWraps(tx, access.chat, workspace, [wrap], workspace.ownerId)) === 0) {
          continue;
        }
      }
      // Replaced, or the chat no longer needs workspace wraps.
      await tx.delete(e2eeChatKeyWraps).where(eq(e2eeChatKeyWraps.id, old.id));
    }
  });
}
