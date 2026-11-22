import { and, eq, ne, sql } from "drizzle-orm";
import {
  MAX_CREDENTIAL_VERSION_LENGTH,
  parseRegistrationPayload,
  type IdentityRecordWire,
  type NewKeysPayload,
  type RegistrationFlow,
  type RegistrationPayload,
  type ResetPayloadWire,
  type SignInPayloadWire,
} from "contracts/e2ee/contract";
import { equalBytes, toBase64Url } from "radium-crypto";
import type { Database } from "../drivers/types";
import { e2eeIdentities, e2eeKeyBundles } from "./schema";

/**
 * Account key records behind the OPAQUE payload hooks (audit I2). One `e2ee_key_bundles` row per
 * `(userId, credentialVersion)` holds that credential's password wrapper and points at an
 * `e2ee_identities` row. Rows are written before the plugin switches the account to the new
 * version and cleaned up only afterwards, so whatever version the account points at always has
 * its bundle. Only the auth hooks call these, with a userId the plugin already authenticated
 * (session, OPAQUE proof or reset token).
 *
 * Every write runs in one transaction holding the user's advisory lock, so concurrent flows of
 * one user apply one after the other, as Convex's serialized mutations did.
 */

type Identity = typeof e2eeIdentities.$inferSelect;
type Bundle = typeof e2eeKeyBundles.$inferSelect;

/** Serializes key writes of one user until the transaction ends. */
async function lockUser(tx: Database, userId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`e2ee:${userId}`}, 0))`);
}

async function findBundle(
  db: Database,
  userId: string,
  credentialVersion: string,
): Promise<Bundle | undefined> {
  const [bundle] = await db
    .select()
    .from(e2eeKeyBundles)
    .where(
      and(
        eq(e2eeKeyBundles.userId, userId),
        eq(e2eeKeyBundles.credentialVersion, credentialVersion),
      ),
    );
  return bundle;
}

async function findIdentity(db: Database, id: string): Promise<Identity | undefined> {
  const [identity] = await db.select().from(e2eeIdentities).where(eq(e2eeIdentities.id, id));
  return identity;
}

function identityMatches(identity: Identity, payload: NewKeysPayload) {
  const record = payload.identity;
  return (
    identity.keyId === record.keyId &&
    identity.suite === record.suite &&
    equalBytes(identity.encryptionPublicKey, new Uint8Array(record.encryptionPublicKey)) &&
    equalBytes(identity.signingPublicKey, new Uint8Array(record.signingPublicKey)) &&
    equalBytes(identity.secrets, new Uint8Array(record.secrets)) &&
    equalBytes(identity.selfSignature, new Uint8Array(record.selfSignature)) &&
    equalBytes(identity.recoveryWrapper, new Uint8Array(payload.recoveryWrapper))
  );
}

/** Whether an already stored bundle is exactly what `payload` would commit (a retried commit). */
async function isSameCommit(db: Database, bundle: Bundle, payload: RegistrationPayload) {
  const identity = await findIdentity(db, bundle.identity);
  if (!identity || !equalBytes(bundle.passwordWrapper, new Uint8Array(payload.passwordWrapper))) {
    return false;
  }
  if (payload.kind === "rewrap") {
    return identity.keyId === payload.keyId;
  }
  return identityMatches(identity, payload);
}

/**
 * Inserts the identity of a `new-keys` payload as `pending`. A key id that already exists is
 * reused only for a byte-identical pending identity of the same user (a retry); anything else is
 * a collision or an attempt to adopt someone else's or a replaced identity and fails.
 */
async function insertPendingIdentity(tx: Database, userId: string, payload: NewKeysPayload) {
  const [existing] = await tx
    .select()
    .from(e2eeIdentities)
    .where(eq(e2eeIdentities.keyId, payload.identity.keyId));
  if (existing) {
    const isRetry =
      existing.userId === userId &&
      existing.status === "pending" &&
      identityMatches(existing, payload);
    if (!isRetry) {
      throw new Error("Key id already in use");
    }
    return existing.id;
  }

  const record = payload.identity;
  const [inserted] = await tx
    .insert(e2eeIdentities)
    .values({
      userId,
      keyId: record.keyId,
      suite: record.suite,
      encryptionPublicKey: new Uint8Array(record.encryptionPublicKey),
      signingPublicKey: new Uint8Array(record.signingPublicKey),
      secrets: new Uint8Array(record.secrets),
      selfSignature: new Uint8Array(record.selfSignature),
      recoveryWrapper: new Uint8Array(payload.recoveryWrapper),
      status: "pending",
    })
    .returning({ id: e2eeIdentities.id });
  return inserted!.id;
}

/**
 * The identity a `rewrap` payload keeps: the one referenced by the bundle of the credential the
 * account points at right now. The client proved the current password (or recovered the AMK), so
 * any other key id is a client bug or a forged payload.
 */
async function currentIdentityForRewrap(
  tx: Database,
  userId: string,
  currentCredentialVersion: string | null,
  keyId: string,
) {
  if (currentCredentialVersion === null) {
    throw new Error("Account has no keys to keep");
  }
  const current = await findBundle(tx, userId, currentCredentialVersion);
  const identity = current ? await findIdentity(tx, current.identity) : undefined;
  if (
    !identity ||
    identity.userId !== userId ||
    identity.keyId !== keyId ||
    identity.status === "retired"
  ) {
    throw new Error("Key id is not the account's current identity");
  }
  return identity.id;
}

/**
 * `commitPayload`: stores the bundle of a credential version that is not active yet. Idempotent
 * per `(userId, credentialVersion)`: repeating the same commit is a no-op, a different payload
 * for an already committed version fails. The payload is parsed again here so the stored rows
 * never depend on the caller having run `validatePayload`.
 *
 * `currentCredentialVersion` is the version the account points at while this runs (`null` on
 * sign-up and attach); a `rewrap` must keep that version's identity.
 */
export async function commitBundle(
  db: Database,
  input: {
    userId: string;
    credentialVersion: string;
    currentCredentialVersion: string | null;
    flow: RegistrationFlow;
    payload: unknown;
  },
) {
  const versionLength = input.credentialVersion.length;
  if (versionLength === 0 || versionLength > MAX_CREDENTIAL_VERSION_LENGTH) {
    throw new Error("Invalid credential version");
  }
  const payload = parseRegistrationPayload(input.payload, input.flow);

  await db.transaction(async (tx) => {
    await lockUser(tx, input.userId);

    const existing = await findBundle(tx, input.userId, input.credentialVersion);
    if (existing) {
      if (await isSameCommit(tx, existing, payload)) {
        return;
      }
      throw new Error("A different key bundle is already committed for this credential");
    }

    let identity: string;
    if (payload.kind === "new-keys") {
      identity = await insertPendingIdentity(tx, input.userId, payload);
    } else {
      identity = await currentIdentityForRewrap(
        tx,
        input.userId,
        input.currentCredentialVersion,
        payload.keyId,
      );
    }

    await tx.insert(e2eeKeyBundles).values({
      userId: input.userId,
      credentialVersion: input.credentialVersion,
      identity,
      passwordWrapper: new Uint8Array(payload.passwordWrapper),
    });
  });
}

/**
 * `activatePayload`, and the repair path of `loadPayload` (with `previousCredentialVersion:
 * null`). Runs after the account switched to `credentialVersion`.
 *
 * - Deletes only the bundle of `previousCredentialVersion`: its wrapper opens the AMK with the
 *   replaced password. Other versions may belong to flows still in progress.
 * - Retires (never deletes) the previous identity when the new credential carries a different one.
 * - Makes the new identity the user's only active one, unless it was already retired. That
 *   happens only when this activation is stale: a later switch replaced this version's identity
 *   and settled first. Pending identities of other versions are left alone; their own activation
 *   settles them.
 *
 * Safe to repeat. When the new bundle is gone, a later activation already deleted it as its own
 * previous version and settled the identities; only the previous bundle is deleted then.
 */
export async function activateBundle(
  db: Database,
  input: { userId: string; credentialVersion: string; previousCredentialVersion: string | null },
) {
  await db.transaction(async (tx) => {
    await lockUser(tx, input.userId);
    const now = new Date();

    const bundle = await findBundle(tx, input.userId, input.credentialVersion);
    const identity = bundle ? await findIdentity(tx, bundle.identity) : undefined;

    if (input.previousCredentialVersion !== null) {
      const previous = await findBundle(tx, input.userId, input.previousCredentialVersion);
      if (previous) {
        await tx.delete(e2eeKeyBundles).where(eq(e2eeKeyBundles.id, previous.id));
        const previousIdentity = await findIdentity(tx, previous.identity);
        const replaced =
          identity !== undefined &&
          previousIdentity !== undefined &&
          previousIdentity.id !== identity.id &&
          previousIdentity.status !== "retired";
        if (replaced) {
          await tx
            .update(e2eeIdentities)
            .set({ status: "retired", retiredAt: now })
            .where(eq(e2eeIdentities.id, previousIdentity.id));
        }
      }
    }

    if (!identity || identity.status === "retired") {
      return;
    }
    // Retire first: the partial unique index allows one active identity per user.
    await tx
      .update(e2eeIdentities)
      .set({ status: "retired", retiredAt: now })
      .where(
        and(
          eq(e2eeIdentities.userId, identity.userId),
          eq(e2eeIdentities.status, "active"),
          ne(e2eeIdentities.id, identity.id),
        ),
      );
    if (identity.status !== "active") {
      await tx
        .update(e2eeIdentities)
        .set({ status: "active" })
        .where(eq(e2eeIdentities.id, identity.id));
    }
  });
}

/** Stored bundle and identity of exactly one credential version, for `loadPayload`. */
export async function loadBundle(db: Database, userId: string, credentialVersion: string) {
  const bundle = await findBundle(db, userId, credentialVersion);
  if (!bundle) {
    return null;
  }
  const identity = await findIdentity(db, bundle.identity);
  if (!identity || identity.userId !== userId) {
    return null;
  }
  return { passwordWrapper: bundle.passwordWrapper, identity };
}

/** Wire form of a stored identity; never includes the recovery wrapper. */
function identityToWire(identity: Identity): IdentityRecordWire {
  return {
    keyId: identity.keyId,
    suite: identity.suite,
    encryptionPublicKey: toBase64Url(identity.encryptionPublicKey),
    signingPublicKey: toBase64Url(identity.signingPublicKey),
    secrets: toBase64Url(identity.secrets),
    selfSignature: toBase64Url(identity.selfSignature),
  };
}

/** `loadPayload` result for sign-in, or `null` when the credential has no bundle. */
export function signInPayload(
  loaded: { passwordWrapper: Uint8Array; identity: Identity } | null,
): SignInPayloadWire | null {
  if (!loaded) {
    return null;
  }
  return {
    v: 1,
    passwordWrapper: toBase64Url(loaded.passwordWrapper),
    identity: identityToWire(loaded.identity),
  };
}

/**
 * `loadPayload` result for reset verify: the current identity with its recovery wrapper. Only
 * ciphertext and public keys; a reset token holder still needs the recovery key or another
 * unlocked device to open it (audit I3).
 */
export function resetPayload(loaded: { identity: Identity } | null): ResetPayloadWire {
  if (!loaded) {
    return { v: 1, identity: null };
  }
  return {
    v: 1,
    recoveryWrapper: toBase64Url(loaded.identity.recoveryWrapper),
    identity: identityToWire(loaded.identity),
  };
}
