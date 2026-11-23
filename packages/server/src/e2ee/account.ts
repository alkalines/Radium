import { and, eq } from "drizzle-orm";
import { decodeExactBytes } from "contracts/e2ee/contract";
import {
  AMK_WRAPPER_BYTES,
  KEY_ID_BYTES,
  recoveryWrapperStatement,
  sha256,
  SIGNATURE_BYTES,
  toBase64Url,
  verify,
} from "radium-crypto";
import type { Database } from "../drivers/types";
import { AppError } from "../errors";
import { e2eeIdentities } from "./schema";
import { activeIdentity } from "./workspace-keys";

/**
 * The signed-in user's account key status for the web key manager: whether an active identity
 * exists, and the public keys its fingerprint is computed from. A pending identity does not count;
 * the next sign-in promotes it. `recoveryWrapperHash` (base64url SHA-256 of the stored recovery
 * wrapper) is what a {@link setRecoveryWrapper} signature binds.
 */
export async function myKeyStatus(db: Database, userId: string) {
  const identity = await activeIdentity(db, userId);
  if (!identity) {
    return { state: "none" as const };
  }
  return {
    state: "ready" as const,
    keyId: identity.keyId,
    recoveryWrapperHash: toBase64Url(await sha256(identity.recoveryWrapper)),
    fingerprintInputs: {
      encryptionPublicKey: toBase64Url(identity.encryptionPublicKey),
      signingPublicKey: toBase64Url(identity.signingPublicKey),
    },
  };
}

function invalidRecoveryWrapper(): never {
  throw new AppError("BAD_REQUEST", "Invalid recovery wrapper.");
}

/**
 * Replaces the recovery-key wrapper of the caller's active identity after the client regenerated
 * the recovery key. The wrapper is an AMK envelope the server cannot open; the old recovery key
 * stops working once this commits.
 *
 * `signature` is the identity's signature over `recoveryWrapperStatement`, binding the new wrapper
 * to the SHA-256 of the one it replaces: a session alone (a stolen cookie) cannot overwrite the
 * recovery factor, and a captured request cannot be replayed once the wrapper has changed. The
 * update is conditional on that same previous wrapper, so of two concurrent replacements signed
 * over one state only the first lands.
 */
export async function setRecoveryWrapper(
  db: Database,
  userId: string,
  input: { keyId: string; recoveryWrapper: Uint8Array; signature: Uint8Array },
): Promise<void> {
  if (
    decodeExactBytes(input.keyId, KEY_ID_BYTES) === null ||
    input.recoveryWrapper.byteLength !== AMK_WRAPPER_BYTES ||
    input.signature.byteLength !== SIGNATURE_BYTES
  ) {
    invalidRecoveryWrapper();
  }
  const identity = await activeIdentity(db, userId);
  if (!identity || identity.keyId !== input.keyId) {
    invalidRecoveryWrapper();
  }
  const signed = await verify(
    identity.signingPublicKey,
    recoveryWrapperStatement({
      userId,
      keyId: identity.keyId,
      wrapper: input.recoveryWrapper,
      previousWrapperHash: await sha256(identity.recoveryWrapper),
    }),
    input.signature,
  );
  if (!signed) {
    invalidRecoveryWrapper();
  }
  const updated = await db
    .update(e2eeIdentities)
    .set({ recoveryWrapper: input.recoveryWrapper })
    .where(
      and(
        eq(e2eeIdentities.id, identity.id),
        eq(e2eeIdentities.status, "active"),
        eq(e2eeIdentities.recoveryWrapper, identity.recoveryWrapper),
      ),
    )
    .returning({ id: e2eeIdentities.id });
  if (updated.length === 0) {
    invalidRecoveryWrapper();
  }
}
