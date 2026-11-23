import { toBase64Url } from "radium-crypto";
import type {
  e2eeChatKeys,
  e2eeChatKeyWraps,
  e2eeJoinRequests,
  e2eeRosters,
  e2eeWorkspaceEpochs,
  e2eeWorkspaceGrants,
} from "./schema";

/**
 * Wire form of E2EE rows returned by `e2ee.*`: bytes as unpadded base64url, times as epoch
 * milliseconds, absent values as `null`. Only public keys, signatures and ciphertext appear here.
 */

const b64OrNull = (value: Uint8Array | null) => (value ? toBase64Url(value) : null);

export function epochWire(row: typeof e2eeWorkspaceEpochs.$inferSelect) {
  return {
    id: row.id,
    workspace: row.workspace,
    epoch: row.epoch,
    suite: row.suite,
    memberKeyId: row.memberKeyId,
    memberPublicKey: toBase64Url(row.memberPublicKey),
    ownerKeyId: row.ownerKeyId,
    ownerPublicKey: toBase64Url(row.ownerPublicKey),
    createdBy: row.createdBy,
    rosterArchiveHash: row.rosterArchiveHash,
    createdAt: row.createdAt.getTime(),
  };
}

export function grantWire(row: typeof e2eeWorkspaceGrants.$inferSelect) {
  return {
    id: row.id,
    workspace: row.workspace,
    epoch: row.epoch,
    purpose: row.purpose,
    userId: row.userId,
    recipientKeyId: row.recipientKeyId,
    granterUserId: row.granterUserId,
    granterKeyId: row.granterKeyId,
    sealed: toBase64Url(row.sealed),
    signature: toBase64Url(row.signature),
    createdAt: row.createdAt.getTime(),
  };
}

export function rosterWire(row: typeof e2eeRosters.$inferSelect) {
  return {
    id: row.id,
    workspace: row.workspace,
    version: row.version,
    body: toBase64Url(row.body),
    signature: toBase64Url(row.signature),
    signerKeyId: row.signerKeyId,
    createdAt: row.createdAt.getTime(),
  };
}

export function joinRequestWire(row: typeof e2eeJoinRequests.$inferSelect) {
  return {
    id: row.id,
    workspace: row.workspace,
    userId: row.userId,
    keyId: row.keyId,
    source: row.source,
    mac: b64OrNull(row.mac),
    ownerSecret: b64OrNull(row.ownerSecret),
    sourceId: row.sourceId,
    epoch: row.epoch,
    createdAt: row.createdAt.getTime(),
  };
}

export function chatKeyWire(row: typeof e2eeChatKeys.$inferSelect) {
  return {
    id: row.id,
    chat: row.chat,
    epoch: row.epoch,
    keyId: row.keyId,
    suite: row.suite,
    publicKey: toBase64Url(row.publicKey),
    signerUserId: row.signerUserId,
    signerKeyId: row.signerKeyId,
    signature: b64OrNull(row.signature),
    bindingSignature: b64OrNull(row.bindingSignature),
    bindingMembers: row.bindingMembers,
    createdAt: row.createdAt.getTime(),
  };
}

export function chatWrapWire(row: typeof e2eeChatKeyWraps.$inferSelect) {
  return {
    id: row.id,
    chat: row.chat,
    workspace: row.workspace,
    chatEpoch: row.chatEpoch,
    recipient: row.recipient,
    userId: row.userId,
    workspaceEpoch: row.workspaceEpoch,
    recipientKeyId: row.recipientKeyId,
    sealed: toBase64Url(row.sealed),
    createdAt: row.createdAt.getTime(),
  };
}

/** Public identity keys, as `identityKeys`, `identityKeysByKeyId` and Worker reads return them. */
export function identityWire(row: {
  userId: string;
  keyId: string;
  suite: number;
  encryptionPublicKey: Uint8Array;
  signingPublicKey: Uint8Array;
  selfSignature: Uint8Array;
}) {
  return {
    userId: row.userId,
    keyId: row.keyId,
    suite: row.suite,
    encryptionPublicKey: toBase64Url(row.encryptionPublicKey),
    signingPublicKey: toBase64Url(row.signingPublicKey),
    selfSignature: toBase64Url(row.selfSignature),
  };
}
