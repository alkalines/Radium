import { v } from "convex/values";

/** Active means not revoked; it does not indicate that the Worker is online. */
export const workerStatus = v.union(v.literal("active"), v.literal("revoked"));

/** Normalized public verification material supplied by the app's proof verifier. */
export const publicKey = v.object({
  algorithm: v.string(),
  material: v.string(),
  thumbprint: v.string(),
});

/**
 * Proof-bound identity returned to the app after enrollment or recovery.
 * The component IDs are strings at this app-facing boundary; `identityEpoch`
 * changes when the identity is revoked and is checked by app authorization.
 */
export const workerIdentity = v.object({
  workerId: v.string(),
  keyId: v.string(),
  workspaceId: v.string(),
  identityEpoch: v.number(),
});

/** Public worker metadata; deliberately excludes enrollment and key material. */
export const workerMetadata = v.object({
  workerId: v.string(),
  workspaceId: v.string(),
  name: v.string(),
  capabilities: v.array(v.string()),
  status: workerStatus,
  identityEpoch: v.number(),
});
