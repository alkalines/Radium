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
  rosterStatement,
  sealSym,
  sha256,
  sign,
  toBase64Url,
  utf8,
  verify,
  type AadParts,
} from "radium-crypto";
import type { PublicIdentity } from "./trust-store";
/** Owner-signed public roster body, serialized in this declaration's property order. */
export type WorkspaceRoster = {
  v: 1;
  workspace: string;
  version: number;
  epoch: number;
  owner: RosterMember;
  epochs: {
    epoch: number;
    memberKeyId: string;
    memberKeyHash: string;
    ownerKeyId: string;
    ownerKeyHash: string;
  }[];
  members: RosterMember[];
};
/** Identity binding endorsed by the owner. */
export type RosterMember = { userId: string; keyId: string; fingerprint: string };
/** Access secret plaintext; only encrypted forms may leave this module's caller. */
export type InvitePayload = {
  v: 1;
  workspace: string;
  epoch: number;
  memberSeed: string;
  owner: RosterMember;
};
/** Creates a canonical, signed roster. The caller must have approved every listed identity. */
export async function signRoster(
  body: WorkspaceRoster,
  signingSeed: Uint8Array,
): Promise<{ version: number; body: Uint8Array; signature: Uint8Array; signerKeyId: string }> {
  const canonical: WorkspaceRoster = {
    v: 1,
    workspace: body.workspace,
    version: body.version,
    epoch: body.epoch,
    owner: {
      userId: body.owner.userId,
      keyId: body.owner.keyId,
      fingerprint: body.owner.fingerprint,
    },
    epochs: body.epochs.map((entry) => ({
      epoch: entry.epoch,
      memberKeyId: entry.memberKeyId,
      memberKeyHash: entry.memberKeyHash,
      ownerKeyId: entry.ownerKeyId,
      ownerKeyHash: entry.ownerKeyHash,
    })),
    members: body.members.map((member) => ({
      userId: member.userId,
      keyId: member.keyId,
      fingerprint: member.fingerprint,
    })),
  };
  const encoded = utf8(JSON.stringify(canonical));
  return {
    version: canonical.version,
    body: encoded,
    signature: await sign(
      signingSeed,
      rosterStatement({ workspaceId: canonical.workspace, body: encoded }),
    ),
    signerKeyId: canonical.owner.keyId,
  };
}
/** Verifies owner binding, signature, workspace and monotonic version before trusting a roster. */
export async function verifyRoster(input: {
  workspaceId: string;
  version: number;
  body: Uint8Array;
  signature: Uint8Array;
  signerKeyId: string;
  owner: PublicIdentity;
  highWater: number;
}): Promise<WorkspaceRoster> {
  if (
    input.version < input.highWater ||
    input.signerKeyId !== input.owner.keyId ||
    !(await verify(
      input.owner.signingPublicKey,
      rosterStatement({ workspaceId: input.workspaceId, body: input.body }),
      input.signature,
    ))
  )
    throw new CryptoError("DECRYPT_FAILED", "Roster signature or version failed");
  const body = JSON.parse(new TextDecoder().decode(input.body)) as WorkspaceRoster;
  if (
    body.v !== 1 ||
    body.workspace !== input.workspaceId ||
    body.version !== input.version ||
    !Number.isSafeInteger(body.version) ||
    body.version < 1 ||
    !Number.isSafeInteger(body.epoch) ||
    body.epoch < 1 ||
    body.owner.userId !== input.owner.userId ||
    body.owner.keyId !== input.owner.keyId ||
    body.owner.fingerprint !== input.owner.fingerprint ||
    !Array.isArray(body.epochs) ||
    !Array.isArray(body.members)
  )
    throw new CryptoError("BAD_ENVELOPE", "Invalid roster body");
  const epochIds = new Set<number>();
  for (const epoch of body.epochs) {
    if (
      !Number.isSafeInteger(epoch.epoch) ||
      epoch.epoch < 1 ||
      epoch.epoch > body.epoch ||
      epochIds.has(epoch.epoch) ||
      fromBase64Url(epoch.memberKeyId).length !== 16 ||
      fromBase64Url(epoch.ownerKeyId).length !== 16 ||
      fromBase64Url(epoch.memberKeyHash).length !== 32 ||
      fromBase64Url(epoch.ownerKeyHash).length !== 32
    )
      throw new CryptoError("BAD_ENVELOPE", "Invalid roster epoch");
    epochIds.add(epoch.epoch);
  }
  if (!epochIds.has(body.epoch))
    throw new CryptoError("BAD_ENVELOPE", "Roster current epoch missing");
  const members = new Set<string>();
  for (const member of body.members) {
    if (
      !member ||
      typeof member.userId !== "string" ||
      typeof member.fingerprint !== "string" ||
      member.userId === body.owner.userId ||
      members.has(member.userId) ||
      fromBase64Url(member.keyId).length !== 16
    )
      throw new CryptoError("BAD_ENVELOPE", "Invalid roster member");
    members.add(member.userId);
  }
  return body;
}
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
