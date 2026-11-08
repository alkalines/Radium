import { v } from "convex/values";
import { equalBytes } from "radium-crypto";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "../../convex/_generated/server";
import {
  encodeBytes,
  MAX_CREDENTIAL_VERSION_LENGTH,
  type IdentityRecord,
  type IdentityRecordWire,
  type NewKeysPayload,
  parseRegistrationPayload,
  registrationFlowValidator,
  type RegistrationPayload,
  type ResetPayloadWire,
  type SignInPayloadWire,
} from "./contract";

/**
 * Account key records behind the OPAQUE payload hooks (audit I2). One `e2ee_key_bundles` row per
 * `(userId, credentialVersion)` holds that credential's password wrapper and points at an
 * `e2ee_identities` row. Rows are written before the plugin switches the account to the new
 * version and cleaned up only afterwards, so whatever version the account points at always has
 * its bundle. These functions are internal: only the auth HTTP action calls them, with a userId
 * the plugin already authenticated (session, OPAQUE proof or reset token).
 */

function sameBytes(a: ArrayBuffer, b: ArrayBuffer) {
  return equalBytes(new Uint8Array(a), new Uint8Array(b));
}

async function findBundle(ctx: { db: QueryCtx["db"] }, userId: string, credentialVersion: string) {
  return await ctx.db
    .query("e2ee_key_bundles")
    .withIndex("by_userId_and_credentialVersion", (q) =>
      q.eq("userId", userId).eq("credentialVersion", credentialVersion),
    )
    .unique();
}

function identityMatches(
  identity: Doc<"e2ee_identities">,
  record: IdentityRecord,
  recoveryWrapper: ArrayBuffer,
) {
  return (
    identity.keyId === record.keyId &&
    identity.suite === record.suite &&
    sameBytes(identity.encryptionPublicKey, record.encryptionPublicKey) &&
    sameBytes(identity.signingPublicKey, record.signingPublicKey) &&
    sameBytes(identity.secrets, record.secrets) &&
    sameBytes(identity.selfSignature, record.selfSignature) &&
    sameBytes(identity.recoveryWrapper, recoveryWrapper)
  );
}

/** Whether an already stored bundle is exactly what `payload` would commit (a retried commit). */
async function isSameCommit(
  ctx: MutationCtx,
  bundle: Doc<"e2ee_key_bundles">,
  payload: RegistrationPayload,
) {
  const identity = await ctx.db.get("e2ee_identities", bundle.identity);
  if (!identity || !sameBytes(bundle.passwordWrapper, payload.passwordWrapper)) {
    return false;
  }
  if (payload.kind === "rewrap") {
    return identity.keyId === payload.keyId;
  }
  return identityMatches(identity, payload.identity, payload.recoveryWrapper);
}

/**
 * Inserts the identity of a `new-keys` payload as `pending`. A key id that already exists is
 * reused only for a byte-identical pending identity of the same user (a retry); anything else is
 * a collision or an attempt to adopt someone else's or a replaced identity and fails.
 */
async function insertPendingIdentity(ctx: MutationCtx, userId: string, payload: NewKeysPayload) {
  const existing = await ctx.db
    .query("e2ee_identities")
    .withIndex("by_keyId", (q) => q.eq("keyId", payload.identity.keyId))
    .unique();
  if (existing) {
    const isRetry =
      existing.userId === userId &&
      existing.status === "pending" &&
      identityMatches(existing, payload.identity, payload.recoveryWrapper);
    if (!isRetry) {
      throw new Error("Key id already in use");
    }
    return existing._id;
  }

  return await ctx.db.insert("e2ee_identities", {
    userId,
    ...payload.identity,
    recoveryWrapper: payload.recoveryWrapper,
    status: "pending",
    createdAt: Date.now(),
  });
}

/**
 * The identity a `rewrap` payload keeps: the one referenced by the bundle of the credential the
 * account points at right now. The client proved the current password (or recovered the AMK), so
 * any other key id is a client bug or a forged payload.
 */
async function currentIdentityForRewrap(
  ctx: MutationCtx,
  userId: string,
  currentCredentialVersion: string | null,
  keyId: string,
) {
  if (currentCredentialVersion === null) {
    throw new Error("Account has no keys to keep");
  }
  const current = await findBundle(ctx, userId, currentCredentialVersion);
  const identity = current ? await ctx.db.get("e2ee_identities", current.identity) : null;
  if (
    !identity ||
    identity.userId !== userId ||
    identity.keyId !== keyId ||
    identity.status === "retired"
  ) {
    throw new Error("Key id is not the account's current identity");
  }
  return identity._id;
}

/**
 * `commitPayload`: stores the bundle of a credential version that is not active yet. Idempotent
 * per `(userId, credentialVersion)`: repeating the same commit is a no-op, a different payload
 * for an already committed version fails. The payload is parsed again here so the stored rows
 * never depend on the caller having run `validatePayload`.
 *
 * `currentCredentialVersion` is the version the account points at while this runs (`null` on
 * sign-up); a `rewrap` must keep that version's identity.
 */
export const commitBundle = internalMutation({
  args: {
    userId: v.string(),
    credentialVersion: v.string(),
    currentCredentialVersion: v.union(v.string(), v.null()),
    flow: registrationFlowValidator,
    payload: v.any(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const versionLength = args.credentialVersion.length;
    if (versionLength === 0 || versionLength > MAX_CREDENTIAL_VERSION_LENGTH) {
      throw new Error("Invalid credential version");
    }
    const payload = parseRegistrationPayload(args.payload, args.flow);

    const existing = await findBundle(ctx, args.userId, args.credentialVersion);
    if (existing) {
      if (await isSameCommit(ctx, existing, payload)) {
        return null;
      }
      throw new Error("A different key bundle is already committed for this credential");
    }

    let identity: Id<"e2ee_identities">;
    if (payload.kind === "new-keys") {
      identity = await insertPendingIdentity(ctx, args.userId, payload);
    } else {
      identity = await currentIdentityForRewrap(
        ctx,
        args.userId,
        args.currentCredentialVersion,
        payload.keyId,
      );
    }

    await ctx.db.insert("e2ee_key_bundles", {
      userId: args.userId,
      credentialVersion: args.credentialVersion,
      identity,
      passwordWrapper: payload.passwordWrapper,
      createdAt: Date.now(),
    });
    return null;
  },
});

/**
 * Makes `identity` the user's only active identity and retires the previously active ones.
 * Pending identities of other versions are left alone: they may belong to a concurrent flow that
 * has committed but not switched yet, and its own activation settles them.
 */
async function activateIdentity(ctx: MutationCtx, identity: Doc<"e2ee_identities">) {
  const now = Date.now();
  const active = await ctx.db
    .query("e2ee_identities")
    .withIndex("by_userId_and_status", (q) =>
      q.eq("userId", identity.userId).eq("status", "active"),
    )
    .collect();
  for (const other of active) {
    if (other._id !== identity._id) {
      await ctx.db.patch("e2ee_identities", other._id, { status: "retired", retiredAt: now });
    }
  }
  if (identity.status !== "active") {
    await ctx.db.patch("e2ee_identities", identity._id, { status: "active" });
  }
}

/**
 * `activatePayload`, and the repair path of `loadPayload` (with `previousCredentialVersion:
 * null`). Runs after the account switched to `credentialVersion`.
 *
 * - Deletes only the bundle of `previousCredentialVersion`: its wrapper opens the AMK with the
 *   replaced password. Other versions may belong to flows still in progress.
 * - Retires (never deletes) the previous identity when the new credential carries a different one.
 * - Activates the new identity unless it was already retired. That happens only when this
 *   activation is stale: a later switch replaced this version's identity and settled first.
 *
 * Safe to repeat. When the new bundle is gone, a later activation already deleted it as its own
 * previous version and settled the identities; only the previous bundle is deleted then.
 */
export const activateBundle = internalMutation({
  args: {
    userId: v.string(),
    credentialVersion: v.string(),
    previousCredentialVersion: v.union(v.string(), v.null()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const bundle = await findBundle(ctx, args.userId, args.credentialVersion);
    const identity = bundle ? await ctx.db.get("e2ee_identities", bundle.identity) : null;

    if (args.previousCredentialVersion !== null) {
      const previous = await findBundle(ctx, args.userId, args.previousCredentialVersion);
      if (previous) {
        await ctx.db.delete("e2ee_key_bundles", previous._id);
        const previousIdentity = await ctx.db.get("e2ee_identities", previous.identity);
        const replaced =
          identity !== null &&
          previousIdentity !== null &&
          previousIdentity._id !== identity._id &&
          previousIdentity.status !== "retired";
        if (replaced) {
          await ctx.db.patch("e2ee_identities", previousIdentity._id, {
            status: "retired",
            retiredAt: Date.now(),
          });
        }
      }
    }

    if (identity && identity.status !== "retired") {
      await activateIdentity(ctx, identity);
    }
    return null;
  },
});

/** Stored bundle and identity of exactly one credential version, for `loadPayload`. */
export const loadBundle = internalQuery({
  args: { userId: v.string(), credentialVersion: v.string() },
  handler: async (ctx, args) => {
    const bundle = await findBundle(ctx, args.userId, args.credentialVersion);
    if (!bundle) {
      return null;
    }
    const identity = await ctx.db.get("e2ee_identities", bundle.identity);
    if (!identity || identity.userId !== args.userId) {
      return null;
    }
    return { passwordWrapper: bundle.passwordWrapper, identity };
  },
});

/** Wire form of a stored identity; never includes the recovery wrapper. */
export function identityToWire(identity: Doc<"e2ee_identities">): IdentityRecordWire {
  return {
    keyId: identity.keyId,
    suite: identity.suite,
    encryptionPublicKey: encodeBytes(identity.encryptionPublicKey),
    signingPublicKey: encodeBytes(identity.signingPublicKey),
    secrets: encodeBytes(identity.secrets),
    selfSignature: encodeBytes(identity.selfSignature),
  };
}

/** `loadPayload` result for sign-in, or `null` when the credential has no bundle. */
export function signInPayload(
  loaded: { passwordWrapper: ArrayBuffer; identity: Doc<"e2ee_identities"> } | null,
): SignInPayloadWire | null {
  if (!loaded) {
    return null;
  }
  return {
    v: 1,
    passwordWrapper: encodeBytes(loaded.passwordWrapper),
    identity: identityToWire(loaded.identity),
  };
}

/**
 * `loadPayload` result for reset verify: the current identity with its recovery wrapper. Only
 * ciphertext and public keys; a reset token holder still needs the recovery key or another
 * unlocked device to open it (audit I3).
 */
export function resetPayload(
  loaded: { identity: Doc<"e2ee_identities"> } | null,
): ResetPayloadWire {
  if (!loaded) {
    return { v: 1, identity: null };
  }
  return {
    v: 1,
    recoveryWrapper: encodeBytes(loaded.identity.recoveryWrapper),
    identity: identityToWire(loaded.identity),
  };
}
