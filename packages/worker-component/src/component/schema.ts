import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { publicKey, workerStatus } from "../contracts.js";

export default defineSchema({
  enrollments: defineTable({
    workspaceId: v.string(),
    tokenHash: v.string(),
    name: v.string(),
    capabilities: v.array(v.string()),
    expiresAt: v.number(),
    state: v.union(v.literal("pending"), v.literal("completed"), v.literal("revoked")),
    completion: v.optional(
      v.object({
        workerId: v.id("workers"),
        keyId: v.id("keys"),
        requestId: v.string(),
      }),
    ),
  })
    .index("by_token_hash", ["tokenHash"])
    .index("by_state_expiry", ["state", "expiresAt"]),
  workers: defineTable({
    workspaceId: v.string(),
    name: v.string(),
    capabilities: v.array(v.string()),
    status: workerStatus,
    identityEpoch: v.number(),
  }).index("by_workspace", ["workspaceId"]),
  keys: defineTable({
    workerId: v.id("workers"),
    publicKey,
  }).index("by_thumbprint", ["publicKey.thumbprint"]),
});
