import {
  CryptoError,
  decodeEnvelope,
  encryptionPublicKeyFromSeed,
  equalBytes,
  fromBase64Url,
  grantStatement,
  hkdf,
  hmacSha256,
  LABELS,
  openBox,
  openSym,
  sealSym,
  sha256,
  toBase64Url,
  utf8,
  verify,
  type AadParts,
  type RosterMember,
} from "radium-crypto";
import type { PublicIdentity } from "./trust-store";
/** Access secret plaintext; only encrypted forms may leave this module's caller. */
export type InvitePayload = {
  v: 1;
  workspace: string;
  epoch: number;
  memberSeed: string;
  owner: RosterMember;
};
/** Opens a signed recipient grant and checks its seed against both the roster hash and epoch row. */
export async function openWorkspaceGrant(input: {
  workspaceId: string;
  epoch: number;
  purpose: "member" | "owner";
  userId: string;
  recipientKeyId: string;
  sealed: Uint8Array;
  signature: Uint8Array;
  granter: PublicIdentity;
  recipientSeed: Uint8Array;
  epochPublicKey: Uint8Array;
  rosterKeyHash: string;
}): Promise<Uint8Array> {
  if (
    !(await verify(
      input.granter.signingPublicKey,
      grantStatement({
        workspaceId: input.workspaceId,
        epoch: input.epoch,
        purpose: input.purpose,
        recipientUserId: input.userId,
        recipientKeyId: input.recipientKeyId,
        sealed: input.sealed,
      }),
      input.signature,
    ))
  )
    throw new CryptoError("DECRYPT_FAILED", "Grant signature failed");
  const seed = await openBox({
    seed: input.recipientSeed,
    box: input.sealed,
    aad: {
      table: "e2ee_workspace_grants",
      workspace: input.workspaceId,
      parent: input.userId,
      record: `${input.epoch}:${input.purpose}`,
      field: input.recipientKeyId,
    },
    pad: "none",
  });
  if (
    seed.length !== 32 ||
    !equalBytes(await encryptionPublicKeyFromSeed(seed), input.epochPublicKey) ||
    toBase64Url(await sha256(input.epochPublicKey)) !== input.rosterKeyHash
  ) {
    seed.fill(0);
    throw new CryptoError("DECRYPT_FAILED", "Grant key differs from roster");
  }
  return seed;
}
/** Derives the invite/phrase wrapper key, authenticating its workspace and target in AAD. */
export async function sealInvitePayload(input: {
  secret: Uint8Array;
  id: string;
  payload: InvitePayload;
  invitedUserId: string;
  phrase?: boolean;
}): Promise<Uint8Array> {
  const key = await hkdf(
    input.secret,
    input.phrase ? `${LABELS.workspacePhrase}/${input.payload.workspace}` : LABELS.invite,
  );
  try {
    return await sealSym({
      key,
      keyRef: fromBase64Url(input.id),
      plaintext: utf8(JSON.stringify(input.payload)),
      aad: inviteAad(input.payload.workspace, input.id, input.invitedUserId, input.phrase),
    });
  } finally {
    key.fill(0);
  }
}
/** Opens an access link or phrase payload; wrong secret, target, workspace or identifier fails closed. */
export async function openInvitePayload(input: {
  secret: Uint8Array;
  id: string;
  workspaceId: string;
  epoch: number;
  invitedUserId: string;
  sealed: Uint8Array;
  phrase?: boolean;
}): Promise<InvitePayload> {
  if (!equalBytes(decodeEnvelope(input.sealed).keyRef, fromBase64Url(input.id)))
    throw new CryptoError("DECRYPT_FAILED", "Access payload identifier mismatch");
  const key = await hkdf(
    input.secret,
    input.phrase ? `${LABELS.workspacePhrase}/${input.workspaceId}` : LABELS.invite,
  );
  let plaintext: Uint8Array | undefined;
  try {
    plaintext = await openSym({
      key,
      envelope: input.sealed,
      aad: inviteAad(input.workspaceId, input.id, input.invitedUserId, input.phrase),
    });
    const payload = JSON.parse(new TextDecoder().decode(plaintext)) as InvitePayload;
    if (
      payload.v !== 1 ||
      payload.workspace !== input.workspaceId ||
      payload.epoch !== input.epoch ||
      fromBase64Url(payload.memberSeed).length !== 32 ||
      !payload.owner ||
      typeof payload.owner.userId !== "string" ||
      fromBase64Url(payload.owner.keyId).length !== 16 ||
      typeof payload.owner.fingerprint !== "string"
    )
      throw new CryptoError("BAD_ENVELOPE", "Invalid access payload");
    return payload;
  } finally {
    key.fill(0);
    plaintext?.fill(0);
  }
}
function inviteAad(
  workspaceId: string,
  id: string,
  invitedUserId: string,
  phrase?: boolean,
): AadParts {
  return {
    table: phrase ? "e2ee_phrases" : "e2ee_invites",
    workspace: workspaceId,
    parent: phrase ? "" : invitedUserId,
    record: id,
    field: "member-key",
  };
}
/** Proof binds a link/phrase secret to both public keys of the joining active identity. */
export async function joinMac(input: {
  secret: Uint8Array;
  workspaceId: string;
  identity: PublicIdentity;
  phrase?: boolean;
}): Promise<Uint8Array> {
  const key = await hkdf(
    input.secret,
    input.phrase ? `${LABELS.workspacePhraseMac}/${input.workspaceId}` : LABELS.inviteMac,
  );
  try {
    return await hmacSha256(key, [
      utf8(input.workspaceId),
      utf8(input.identity.userId),
      utf8(input.identity.keyId),
      input.identity.encryptionPublicKey,
      input.identity.signingPublicKey,
    ]);
  } finally {
    key.fill(0);
  }
}
