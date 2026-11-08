import { RateLimiter } from "@convex-dev/rate-limiter";
import { v } from "convex/values";
import { AMK_WRAPPER_BYTES } from "radium-crypto";
import { components } from "../../convex/_generated/api";
import { internalMutation, mutation } from "../../convex/_generated/server";
import { authComponent } from "../../convex/auth";
import { decodeExactBytes, DEVICE_RECOVERY_SLOT_BYTES, DEVICE_RECOVERY_TTL_MS } from "./contract";

/**
 * Password reset through another device where the user is still unlocked (docs/E2EE/
 * Authentication.md "Flows"). The resetting page derives `slotId` and a wrapping key from a
 * 16-byte secret shown only on its screen; the unlocked device, given the secret's words, offers
 * the AMK wrapped under that key in the slot; the resetting page takes it once. The server only
 * relays ciphertext and never learns the secret: the slot id is a 256-bit HKDF output, so it is
 * both unguessable and useless for opening `sealedAmk`.
 */

const limiter = new RateLimiter(components.rateLimiter, {
  // A user offers once per reset; retries and typos stay well within this.
  offerDeviceRecovery: { kind: "fixed window", rate: 10, period: 15 * 60_000 },
  // The resetting page polls every few seconds while it waits.
  takeDeviceRecovery: { kind: "fixed window", rate: 60, period: 60_000 },
});

/**
 * The signed-in (unlocked) device offers its wrapped AMK for one slot, valid for
 * {@link DEVICE_RECOVERY_TTL_MS}. Offering the same slot again replaces the earlier offer; a slot
 * offered by another user is refused instead of overwritten.
 */
export const offerDeviceRecovery = mutation({
  args: { slotId: v.string(), sealedAmk: v.bytes() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const user = await authComponent.getAuthUser(ctx);
    if (!user) {
      throw new Error("Not logged in.");
    }
    const validOffer =
      decodeExactBytes(args.slotId, DEVICE_RECOVERY_SLOT_BYTES) !== null &&
      args.sealedAmk.byteLength === AMK_WRAPPER_BYTES;
    if (!validOffer) {
      throw new Error("Invalid device recovery offer");
    }
    await limiter.limit(ctx, "offerDeviceRecovery", { key: user._id, throws: true });

    const expiresAt = Date.now() + DEVICE_RECOVERY_TTL_MS;
    const existing = await ctx.db
      .query("e2ee_device_recovery")
      .withIndex("by_slotId", (q) => q.eq("slotId", args.slotId))
      .unique();
    if (existing) {
      if (existing.userId !== user._id) {
        throw new Error("Device recovery slot is taken");
      }
      await ctx.db.patch("e2ee_device_recovery", existing._id, {
        sealedAmk: args.sealedAmk,
        expiresAt,
      });
      return null;
    }

    await ctx.db.insert("e2ee_device_recovery", {
      userId: user._id,
      slotId: args.slotId,
      sealedAmk: args.sealedAmk,
      expiresAt,
    });
    return null;
  },
});

/**
 * Takes the offer of a slot, if any; the resetting page has no session, so knowing the slot id is
 * the only authorization (see the module comment). Single use: a returned offer is deleted in the
 * same transaction. Expired offers are deleted and reported as absent. Rate-limited per client
 * address, or per slot when Convex reports no address.
 *
 * @returns the wrapped AMK, or `null` while nothing (unexpired) was offered.
 */
export const takeDeviceRecovery = mutation({
  args: { slotId: v.string() },
  returns: v.union(v.null(), v.object({ sealedAmk: v.bytes() })),
  handler: async (ctx, args) => {
    if (decodeExactBytes(args.slotId, DEVICE_RECOVERY_SLOT_BYTES) === null) {
      throw new Error("Invalid device recovery slot");
    }
    const { ip } = await ctx.meta.getRequestMetadata();
    const key = ip ? `ip:${ip}` : `slot:${args.slotId}`;
    await limiter.limit(ctx, "takeDeviceRecovery", { key, throws: true });

    const offer = await ctx.db
      .query("e2ee_device_recovery")
      .withIndex("by_slotId", (q) => q.eq("slotId", args.slotId))
      .unique();
    if (!offer) {
      return null;
    }

    await ctx.db.delete("e2ee_device_recovery", offer._id);
    if (offer.expiresAt <= Date.now()) {
      return null;
    }
    return { sealedAmk: offer.sealedAmk };
  },
});

/** Cron: removes a bounded batch of expired, untaken offers. */
export const pruneDeviceRecovery = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const expired = await ctx.db
      .query("e2ee_device_recovery")
      .withIndex("by_expiresAt", (q) => q.lte("expiresAt", Date.now()))
      .take(200);

    for (const offer of expired) {
      await ctx.db.delete("e2ee_device_recovery", offer._id);
    }
    return expired.length;
  },
});
