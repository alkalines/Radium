import { api } from "backend/convex/_generated/api";
import type { Id } from "backend/convex/_generated/dataModel";
import {
  CryptoError,
  fingerprint,
  fromBase64Url,
  toBase64Url,
  verifyIdentitySelfSignature,
} from "radium-crypto";
import { keyManager, KeysLockedError } from "./key-manager";
import { bytes, cryptoClient, currentUserId } from "./runtime";
import type { PublicIdentity } from "./trust-store";
type PublicCache = {
  identity?: { keyId: string; encryptionPublicKey: string };
  workspaces: Record<string, { epoch: number; memberKeyId: string; memberPublicKey: string }>;
};
function readCache(): PublicCache {
  try {
    const value = JSON.parse(
      localStorage.getItem(`radium.e2ee.pub.v1:${currentUserId()}`) ?? "null",
    );
    return value && typeof value.workspaces === "object" ? value : { workspaces: {} };
  } catch {
    return { workspaces: {} };
  }
}
function writeCache(cache: PublicCache) {
  if (keyManager.getSnapshot().state !== "unlocked") throw new KeysLockedError();
  try {
    localStorage.setItem(`radium.e2ee.pub.v1:${currentUserId()}`, JSON.stringify(cache));
  } catch {
    /* Public cache is optional; locked creation will require unlock. */
  }
}
/** Fetches and verifies active identity self-signatures; this alone does not establish trust. */
export async function fetchIdentities(userIds: string[]): Promise<Map<string, PublicIdentity>> {
  const result = new Map<string, PublicIdentity>();
  const unique = [...new Set(userIds)];
  for (let start = 0; start < unique.length; start += 200) {
    const rows = await cryptoClient().query(api.e2ee.identityKeys, {
      userIds: unique.slice(start, start + 200),
    });
    for (const row of rows) {
      if (!row) continue;
      const identity = await verifyPublicIdentity(row);
      result.set(row.userId, identity);
    }
  }
  return result;
}

type PublicIdentityRow = {
  userId: string;
  keyId: string;
  suite: number;
  encryptionPublicKey: ArrayBuffer;
  signingPublicKey: ArrayBuffer;
  selfSignature: ArrayBuffer;
  status?: string;
};

async function verifyPublicIdentity(row: PublicIdentityRow): Promise<PublicIdentity> {
  const identity = {
    userId: row.userId,
    keyId: row.keyId,
    suite: row.suite,
    encryptionPublicKey: bytes(row.encryptionPublicKey),
    signingPublicKey: bytes(row.signingPublicKey),
    selfSignature: bytes(row.selfSignature),
  };
  const valid = await verifyIdentitySelfSignature({
    keyId: fromBase64Url(row.keyId),
    suite: row.suite as 1,
    encryptionPublicKey: identity.encryptionPublicKey,
    signingPublicKey: identity.signingPublicKey,
    signature: identity.selfSignature,
  });
  if (fromBase64Url(row.keyId).length !== 16 || !valid) {
    throw new CryptoError("DECRYPT_FAILED", "Identity signature failed");
  }
  return { ...identity, fingerprint: await fingerprint(identity), status: row.status };
}

/** Fetches self-authenticated historical signing keys; callers still enforce roster authorization. */
export async function fetchHistoricalIdentities(
  keyIds: string[],
  chatId?: Id<"aisdk_chats">,
): Promise<Map<string, PublicIdentity>> {
  const result = new Map<string, PublicIdentity>();
  const unique = [...new Set(keyIds)];
  for (let start = 0; start < unique.length; start += 200) {
    const rows = await cryptoClient().query(api.e2ee.identityKeysByKeyId, {
      keyIds: unique.slice(start, start + 200),
      chatId,
    });
    for (const row of rows) {
      // The server never returns pending identities; a missing row is simply unknown.
      if (!row) continue;
      result.set(row.keyId, await verifyPublicIdentity(row));
    }
  }
  return result;
}
/** Refreshes only this account's locally derived public identity in the locked-write cache. */
export async function refreshOwnPublicKey(): Promise<void> {
  await keyManager.useAmk(async (_, identity) => {
    const cache = readCache();
    cache.identity = {
      keyId: toBase64Url(identity.keyId),
      encryptionPublicKey: toBase64Url(identity.encryption.publicKey),
    };
    writeCache(cache);
  });
}
/** Returns the unlocked local identity public key or its last verified locked-write cache. */
export async function getOwnPublicKey(): Promise<{
  keyId: string;
  encryptionPublicKey: Uint8Array;
}> {
  if (keyManager.getSnapshot().state === "unlocked") {
    await refreshOwnPublicKey();
    return keyManager.useAmk(async (_, identity) => ({
      keyId: toBase64Url(identity.keyId),
      encryptionPublicKey: identity.encryption.publicKey,
    }));
  }
  const identity = readCache().identity;
  if (!identity) throw new KeysLockedError();
  const encryptionPublicKey = fromBase64Url(identity.encryptionPublicKey);
  if (encryptionPublicKey.length !== 1216 || fromBase64Url(identity.keyId).length !== 16)
    throw new KeysLockedError();
  return { keyId: identity.keyId, encryptionPublicKey };
}
/** Stores a workspace public key only after owner roster and epoch verification. */
export function cacheWorkspacePublicKey(
  workspaceId: string,
  key: { epoch: number; keyId: string; publicKey: Uint8Array },
): void {
  const cache = readCache();
  cache.workspaces[workspaceId] = {
    epoch: key.epoch,
    memberKeyId: key.keyId,
    memberPublicKey: toBase64Url(key.publicKey),
  };
  writeCache(cache);
}
/** Retrieves the last verified public workspace key without unlocking private material. */
export function cachedWorkspacePublicKey(
  workspaceId: string,
): { epoch: number; keyId: string; publicKey: Uint8Array } | null {
  const value = readCache().workspaces[workspaceId];
  if (!value) return null;
  const publicKey = fromBase64Url(value.memberPublicKey);
  if (
    !Number.isSafeInteger(value.epoch) ||
    value.epoch < 1 ||
    publicKey.length !== 1216 ||
    fromBase64Url(value.memberKeyId).length !== 16
  )
    return null;
  return { epoch: value.epoch, keyId: value.memberKeyId, publicKey };
}
