import {
  chatKeyBindingStatement,
  chatKeyStatement,
  ENCRYPTION_PUBLIC_KEY_BYTES,
  SUITE_1,
  type ChatScopeName,
} from "radium-crypto";
import type { WorkerTrust } from "./trust.js";

/**
 * A chat key epoch as the server serves it, with the policy its binding signature covers. Everything
 * here is untrusted until {@link verifyChatKey} accepted it.
 */
export interface UntrustedChatKey {
  /** Server-assigned chat ID the epoch is bound to. */
  chatId: string;
  e2eeId: string;
  epoch: number;
  keyId: string;
  suite: number;
  publicKey: Uint8Array;
  signerKeyId: string | null;
  signature: Uint8Array | null;
  /** Missing on every epoch created before binding: such an epoch is read-only. */
  bindingSignature: Uint8Array | null;
  scope: ChatScopeName;
  creatorId: string;
  /** Raw picked members the binding signed (`bindingMembers`); ignored unless `scope` is shared. */
  members: readonly string[];
}

/** Whether `userId` may author an epoch of a chat with this audience (workspace: any roster user). */
export function chatAudienceIncludes(
  chat: { scope: ChatScopeName; creatorId: string; members: readonly string[] },
  userId: string,
): boolean {
  if (chat.scope === "workspace") return true;
  if (userId === chat.creatorId) return true;
  return chat.scope === "shared" && chat.members.includes(userId);
}

/**
 * Authenticates the recipient key of new content: the original epoch signature AND the binding
 * signature over this exact chat ID, workspace, e2ee ID, epoch, key, scope, creator and members must
 * verify under the same roster-verified signer, who must belong to the chat's audience. An epoch
 * without a binding (every earlier state) never verifies: it stays readable but nothing new may be
 * sealed to it until the browser rotates to a bound epoch.
 * @returns the signer's user ID, or `null` when the key must not be used.
 */
export async function verifyChatKey(
  trust: Pick<WorkerTrust, "workspaceId" | "verifyUser">,
  key: UntrustedChatKey,
): Promise<string | null> {
  const { signerKeyId, signature, bindingSignature } = key;
  if (
    !signerKeyId ||
    !signature ||
    !bindingSignature ||
    key.suite !== SUITE_1 ||
    key.publicKey.length !== ENCRYPTION_PUBLIC_KEY_BYTES ||
    !Number.isSafeInteger(key.epoch) ||
    key.epoch < 1 ||
    // Only a shared chat has raw picked members; any other scope must not carry them.
    (key.scope !== "shared" && key.members.length > 0)
  )
    return null;
  const members = key.members;
  let bindingMessage: Uint8Array;
  try {
    bindingMessage = chatKeyBindingStatement({
      chatId: key.chatId,
      workspaceId: trust.workspaceId,
      chatE2eeId: key.e2eeId,
      epoch: key.epoch,
      keyId: key.keyId,
      suite: key.suite,
      publicKey: key.publicKey,
      scope: key.scope,
      creatorId: key.creatorId,
      members,
    });
  } catch {
    return null;
  }
  const original = await trust.verifyUser({
    signerKeyId,
    message: chatKeyStatement({
      workspaceId: trust.workspaceId,
      chatE2eeId: key.e2eeId,
      epoch: key.epoch,
      keyId: key.keyId,
      suite: key.suite,
      publicKey: key.publicKey,
    }),
    signature,
  });
  if (!original) return null;
  const bound = await trust.verifyUser({
    signerKeyId,
    message: bindingMessage,
    signature: bindingSignature,
  });
  if (bound?.userId !== original.userId) return null;
  return chatAudienceIncludes({ scope: key.scope, creatorId: key.creatorId, members }, bound.userId)
    ? bound.userId
    : null;
}
