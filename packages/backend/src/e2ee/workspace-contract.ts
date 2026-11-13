import { ConvexError, v, type Infer } from "convex/values";
import { CAPSULE_BYTES } from "radium-crypto";
import type { QueryCtx, MutationCtx } from "../../convex/_generated/server";
import { decodeExactBytes } from "./contract";
/** Signed workspace seed encrypted to one active identity. */
export const grantInputValidator = v.object({
  epoch: v.number(),
  purpose: v.union(v.literal("member"), v.literal("owner")),
  userId: v.string(),
  recipientKeyId: v.string(),
  granterKeyId: v.string(),
  sealed: v.bytes(),
  signature: v.bytes(),
});
/** Public workspace epoch; private seeds exist only in grants. */
export const epochInputValidator = v.object({
  epoch: v.number(),
  suite: v.number(),
  memberKeyId: v.string(),
  memberPublicKey: v.bytes(),
  ownerKeyId: v.string(),
  ownerPublicKey: v.bytes(),
});
/** Owner-signed roster bytes. */
export const rosterInputValidator = v.object({
  version: v.number(),
  body: v.bytes(),
  signature: v.bytes(),
  signerKeyId: v.string(),
});
/** Chat epoch, optionally unsigned when created on a locked device. */
export const chatKeyInputValidator = v.object({
  epoch: v.number(),
  keyId: v.string(),
  suite: v.number(),
  publicKey: v.bytes(),
  signerKeyId: v.optional(v.string()),
  signature: v.optional(v.bytes()),
});
/** A chat seed sealed to a workspace epoch or one identity. */
export const wrapInputValidator = v.union(
  v.object({
    chatEpoch: v.number(),
    recipient: v.literal("workspace"),
    workspaceEpoch: v.number(),
    recipientKeyId: v.string(),
    sealed: v.bytes(),
  }),
  v.object({
    chatEpoch: v.number(),
    recipient: v.literal("identity"),
    userId: v.string(),
    recipientKeyId: v.string(),
    sealed: v.bytes(),
  }),
);
/** Initial chat epoch and recipient coverage. */
export const chatKeysSetupValidator = v.object({
  e2eeId: v.string(),
  epoch: chatKeyInputValidator,
  wraps: v.array(wrapInputValidator),
});
export type GrantInput = Infer<typeof grantInputValidator>;
export type EpochInput = Infer<typeof epochInputValidator>;
export type RosterInput = Infer<typeof rosterInputValidator>;
export type ChatKeyInput = Infer<typeof chatKeyInputValidator>;
export type WrapInput = Infer<typeof wrapInputValidator>;
export type ChatKeysSetup = Infer<typeof chatKeysSetupValidator>;
/** Atomically supplied workspace key material. */
export const workspaceKeysValidator = v.object({
  epoch: epochInputValidator,
  grants: v.array(grantInputValidator),
  roster: rosterInputValidator,
});
/** Fails closed without echoing key material. */
export function invalidKeys(): never {
  throw new ConvexError({ code: "E2EE_KEYS_INVALID" });
}
/** Validate a canonical random 16-byte identifier. */
export function requireKeyId(id: string): void {
  if (!decodeExactBytes(id, 16)) {
    invalidKeys();
  }
}
/** Validate a positive safe epoch or version. */
export function requirePositive(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    invalidKeys();
  }
}
/** Validate a bounded nonempty encrypted box. */
export function requireBox(value: ArrayBuffer, max = 65536): void {
  if (value.byteLength < 1 || value.byteLength > max) {
    invalidKeys();
  }
}
/** A sealed 32-byte seed is one capsule plus a short envelope; anything larger is junk. */
export function requireSealedKey(value: ArrayBuffer): void {
  requireBox(value, CAPSULE_BYTES + 256);
}
/** Resolve only the user's active identity; retired keys never receive new grants. */
export async function activeIdentityFor(ctx: QueryCtx | MutationCtx, userId: string) {
  return await ctx.db
    .query("e2ee_identities")
    .withIndex("by_userId_and_status", (q) => q.eq("userId", userId).eq("status", "active"))
    .unique();
}
