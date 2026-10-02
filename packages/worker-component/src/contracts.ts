import { v } from "convex/values";

export const workerStatus = v.union(v.literal("active"), v.literal("revoked"));

/** Normalized public verification material supplied by the app's proof verifier. */
export const publicKey = v.object({
  algorithm: v.string(),
  material: v.string(),
  thumbprint: v.string(),
});

export const workerIdentity = v.object({
  workerId: v.string(),
  keyId: v.string(),
  workspaceId: v.string(),
  identityEpoch: v.number(),
});

export const workerMetadata = v.object({
  workerId: v.string(),
  workspaceId: v.string(),
  name: v.string(),
  capabilities: v.array(v.string()),
  status: workerStatus,
  identityEpoch: v.number(),
});
