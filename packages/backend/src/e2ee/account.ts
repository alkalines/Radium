import { v } from "convex/values";
import { AMK_WRAPPER_BYTES, KEY_ID_BYTES } from "radium-crypto";
import { mutation, query } from "../../convex/_generated/server";
import { authComponent } from "../../convex/auth";
import { decodeExactBytes } from "./contract";

/**
 * Account key status of the signed-in user for the web key manager: whether keys exist and the
 * public keys its fingerprint is computed from. `null` when signed out. Only the active identity
 * counts; a pending one is promoted by the next sign-in (`loadPayload`).
 */
export const myKeyStatus = query({
  args: {},
  returns: v.union(
    v.null(),
    v.object({ state: v.literal("none") }),
    v.object({
      state: v.literal("ready"),
      keyId: v.string(),
      fingerprintInputs: v.object({
        encryptionPublicKey: v.bytes(),
        signingPublicKey: v.bytes(),
      }),
    }),
  ),
  handler: async (ctx) => {
    const user = await authComponent.safeGetAuthUser(ctx);
    if (!user) {
      return null;
    }

    const identity = await ctx.db
      .query("e2ee_identities")
      .withIndex("by_userId_and_status", (q) => q.eq("userId", user._id).eq("status", "active"))
      .first();
    if (!identity) {
      return { state: "none" as const };
    }

    return {
      state: "ready" as const,
      keyId: identity.keyId,
      fingerprintInputs: {
        encryptionPublicKey: identity.encryptionPublicKey,
        signingPublicKey: identity.signingPublicKey,
      },
    };
  },
});

/**
 * Replaces the recovery-key wrapper of the signed-in user's active identity after the client
 * regenerated the recovery key. The wrapper is an AMK envelope the server cannot open or check
 * beyond its length; the old recovery key stops working once this commits.
 *
 * @throws when signed out, or when `keyId` is not the caller's active identity.
 */
export const setRecoveryWrapper = mutation({
  args: { keyId: v.string(), recoveryWrapper: v.bytes() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const user = await authComponent.getAuthUser(ctx);
    if (!user) {
      throw new Error("Not logged in.");
    }
    if (
      decodeExactBytes(args.keyId, KEY_ID_BYTES) === null ||
      args.recoveryWrapper.byteLength !== AMK_WRAPPER_BYTES
    ) {
      throw new Error("Invalid recovery wrapper");
    }

    const identity = await ctx.db
      .query("e2ee_identities")
      .withIndex("by_keyId", (q) => q.eq("keyId", args.keyId))
      .unique();
    if (!identity || identity.userId !== user._id || identity.status !== "active") {
      throw new Error("Key id is not your active identity");
    }

    await ctx.db.patch("e2ee_identities", identity._id, { recoveryWrapper: args.recoveryWrapper });
    return null;
  },
});
