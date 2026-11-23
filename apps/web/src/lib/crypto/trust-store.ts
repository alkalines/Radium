import {
  CryptoError,
  decodeEnvelope,
  equalBytes,
  fingerprint,
  fromBase64Url,
  hkdf,
  LABELS,
  openSym,
  sealSym,
  toBase64Url,
  utf8,
} from "radium-crypto";
import { trpcClient } from "@/lib/trpc-client";
import { keyManager } from "./key-manager";
import { advanceHighWater, currentUserId, highWater, onSecretsCleared, trpcFailure } from "./runtime";
/** A stale writer: the server refuses a compare-and-swap with CONFLICT "TRUST_STORE_CONFLICT". */
function isTrustStoreConflict(error: unknown): boolean {
  const failure = trpcFailure(error);
  return failure?.code === "CONFLICT" && failure.message === "TRUST_STORE_CONFLICT";
}
/** Public identity used by pin decisions, never private material. */
export type PublicIdentity = {
  userId: string;
  keyId: string;
  suite: number;
  encryptionPublicKey: Uint8Array;
  signingPublicKey: Uint8Array;
  selfSignature?: Uint8Array;
  fingerprint: string;
  status?: string;
};
/** Explicitly accepted pin, persisted only inside the AMK-encrypted envelope. */
export type TrustPin = {
  keyId: string;
  fingerprint: string;
  state: "tofu" | "verified";
  updatedAt: number;
};
/**
 * Authenticated versioned pin map, keyed by user ID, or by `workerPinKey(workerId)` for a Worker's
 * E2EE key set (its `keyId` and the fingerprint of its two public keys).
 */
export type TrustStore = { v: 1; version: number; pins: Record<string, TrustPin> };
/** Pin key of a Worker; the prefix keeps Worker pins apart from user IDs. */
export function workerPinKey(workerId: string): string {
  return `worker:${workerId}`;
}
/** Rollback is blocking and cannot be dismissed by replacing a pin. */
export type TrustStatus = "locked" | "ready" | "rollback";
const listeners = new Set<() => void>();
let store: TrustStore | null = null;
let owner: string | null = null;
let status: TrustStatus = "locked";
let loading: Promise<void> | null = null;
function emit() {
  for (const listener of listeners) listener();
}
onSecretsCleared(() => {
  store = null;
  owner = null;
  status = "locked";
  loading = null;
  emit();
});
const aad = (userId: string, version: number) => ({
  table: "e2ee_trust_stores",
  workspace: "",
  parent: userId,
  record: String(version),
  field: "pins",
});

/** Encrypts a trust store with an AMK-derived purpose key and identity-bound keyRef. */
export async function sealTrustStore(input: {
  amk: Uint8Array;
  keyId: string;
  userId: string;
  store: TrustStore;
}): Promise<Uint8Array> {
  const key = await hkdf(input.amk, LABELS.trustStore);
  try {
    return await sealSym({
      key,
      keyRef: fromBase64Url(input.keyId),
      plaintext: utf8(JSON.stringify(input.store)),
      aad: aad(input.userId, input.store.version),
      pad: "content",
    });
  } finally {
    key.fill(0);
  }
}
/** Opens and validates a trust store, refusing versions below the caller's device high-water mark. */
export async function openTrustStore(input: {
  amk: Uint8Array;
  keyId: string;
  userId: string;
  version: number;
  envelope: Uint8Array;
  highWater: number;
}): Promise<TrustStore> {
  if (input.version < input.highWater)
    throw new CryptoError("DECRYPT_FAILED", "Trust store rollback detected");
  if (!equalBytes(decodeEnvelope(input.envelope).keyRef, fromBase64Url(input.keyId)))
    throw new CryptoError("DECRYPT_FAILED", "Trust store identity mismatch");
  const key = await hkdf(input.amk, LABELS.trustStore);
  let plaintext: Uint8Array | undefined;
  try {
    plaintext = await openSym({
      key,
      envelope: input.envelope,
      aad: aad(input.userId, input.version),
      pad: "content",
    });
    const parsed = JSON.parse(new TextDecoder().decode(plaintext)) as TrustStore;
    if (
      parsed.v !== 1 ||
      parsed.version !== input.version ||
      !parsed.pins ||
      Array.isArray(parsed.pins) ||
      typeof parsed.pins !== "object"
    )
      throw new CryptoError("BAD_ENVELOPE", "Invalid trust store");
    for (const pin of Object.values(parsed.pins)) {
      if (
        !pin ||
        typeof pin.keyId !== "string" ||
        fromBase64Url(pin.keyId).length !== 16 ||
        typeof pin.fingerprint !== "string" ||
        !["tofu", "verified"].includes(pin.state) ||
        !Number.isFinite(pin.updatedAt)
      )
        throw new CryptoError("BAD_ENVELOPE", "Invalid trust pin");
    }
    return parsed;
  } finally {
    key.fill(0);
    plaintext?.fill(0);
  }
}

async function load(force = false): Promise<void> {
  const userId = currentUserId();
  if (!force && store && owner === userId) return;
  if (loading) return loading;
  loading = keyManager
    .useAmk(async (amk, identity) => {
      const row = await trpcClient().e2ee.getTrustStore.query();
      const marker = `radium.e2ee.trust.v1:${userId}`;
      if ((row?.version ?? 0) < highWater(marker)) {
        status = "rollback";
        store = null;
        emit();
        throw new CryptoError("DECRYPT_FAILED", "Trust store rollback detected");
      }
      const next = row
        ? await openTrustStore({
            amk,
            keyId: toBase64Url(identity.keyId),
            userId,
            version: row.version,
            envelope: fromBase64Url(row.envelope),
            highWater: highWater(marker),
          })
        : { v: 1 as const, version: 0, pins: {} };
      if (keyManager.getSnapshot().state !== "unlocked" || currentUserId() !== userId)
        throw new CryptoError("DECRYPT_FAILED", "Keys locked during trust sync");
      store = next;
      owner = userId;
      status = "ready";
      advanceHighWater(marker, next.version);
      emit();
    })
    .finally(() => {
      loading = null;
    });
  return loading;
}

/** Account-scoped trust decisions; only explicit user approval or a verified join proof creates pins. */
export const trust = {
  load,
  getSnapshot: (): TrustStatus => status,
  /** Previous fingerprint for a changed-key comparison; contains no secret key material. */
  pinnedFingerprint(userId: string): string | null {
    return store?.pins[userId]?.fingerprint ?? null;
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  async check(
    userId: string,
    identity: PublicIdentity,
  ): Promise<"self" | "first-contact" | "tofu" | "verified" | "changed"> {
    await load();
    const digest = await fingerprint(identity);
    if (digest !== identity.fingerprint)
      throw new CryptoError("DECRYPT_FAILED", "Identity fingerprint mismatch");
    if (userId === currentUserId()) {
      return keyManager.useAmk(async (_, own) =>
        equalBytes(own.encryption.publicKey, identity.encryptionPublicKey) &&
        equalBytes(own.signing.publicKey, identity.signingPublicKey)
          ? "self"
          : "changed",
      );
    }
    const pin = store?.pins[userId];
    if (!pin) return "first-contact";
    if (pin.keyId !== identity.keyId || pin.fingerprint !== digest) return "changed";
    return pin.state;
  },
  async pin(userId: string, identity: PublicIdentity, state: "tofu" | "verified"): Promise<void> {
    for (let attempt = 0; attempt < 5; attempt++) {
      await load(attempt > 0);
      if (status !== "ready" || !store)
        throw new CryptoError("DECRYPT_FAILED", "Trust store unavailable");
      const expectedVersion = store.version || null;
      const next: TrustStore = {
        v: 1,
        version: store.version + 1,
        pins: {
          ...store.pins,
          [userId]: {
            keyId: identity.keyId,
            fingerprint: await fingerprint(identity),
            state,
            updatedAt: Date.now(),
          },
        },
      };
      try {
        await keyManager.useAmk(async (amk, own) => {
          const envelope = await sealTrustStore({
            amk,
            keyId: toBase64Url(own.keyId),
            userId: currentUserId(),
            store: next,
          });
          await trpcClient().e2ee.saveTrustStore.mutate({
            expectedVersion,
            version: next.version,
            envelope: toBase64Url(envelope),
          });
        });
        if (keyManager.getSnapshot().state !== "unlocked")
          throw new CryptoError("DECRYPT_FAILED", "Keys locked during trust update");
        store = next;
        advanceHighWater(`radium.e2ee.trust.v1:${currentUserId()}`, next.version);
        emit();
        return;
      } catch (error) {
        if (!isTrustStoreConflict(error)) throw error;
      }
    }
    throw new CryptoError("BAD_INPUT", "Trust store changed concurrently; try again");
  },
};
