import { v } from "convex/values";
import { mutation, query } from "./_generated/server.js";
import { publicKey, workerIdentity } from "../contracts.js";
import {
  boundedString,
  fail,
  validateLimit,
  validatePublicKey,
  validateTokenHash,
} from "../validation.js";
import { activeIdentity } from "./model.js";

/** The app generates a 256-bit token and passes only its SHA-256 hex digest. */
export const createEnrollment = mutation({
  args: {
    workspaceId: v.string(),
    tokenHash: v.string(),
    name: v.string(),
    capabilities: v.array(v.string()),
    expiresAt: v.number(),
  },
  returns: v.string(),
  handler: async (ctx, args) => {
    boundedString(args.workspaceId);
    boundedString(args.name);
    validateTokenHash(args.tokenHash);
    if (args.capabilities.length > 32) fail("INVALID_ARGUMENT");
    for (const capability of args.capabilities) boundedString(capability, 128);
    if (new Set(args.capabilities).size !== args.capabilities.length) fail("INVALID_ARGUMENT");
    if (
      !Number.isSafeInteger(args.expiresAt) ||
      args.expiresAt <= Date.now() ||
      args.expiresAt > Date.now() + 60 * 60 * 1000
    ) {
      fail("INVALID_EXPIRY");
    }
    const existing = await ctx.db
      .query("enrollments")
      .withIndex("by_token_hash", (q) => q.eq("tokenHash", args.tokenHash))
      .unique();
    if (existing) fail("TOKEN_HASH_EXISTS");
    return await ctx.db.insert("enrollments", { ...args, state: "pending" });
  },
});

/** Call only after verifying a fresh proof bound to this enrollment and request. */
export const completeEnrollment = mutation({
  args: {
    workspaceId: v.string(),
    tokenHash: v.string(),
    requestId: v.string(),
    publicKey,
  },
  returns: workerIdentity,
  handler: async (ctx, args) => {
    validateTokenHash(args.tokenHash);
    boundedString(args.requestId);
    validatePublicKey(args.publicKey);
    const enrollment = await ctx.db
      .query("enrollments")
      .withIndex("by_token_hash", (q) => q.eq("tokenHash", args.tokenHash))
      .unique();
    if (!enrollment || enrollment.workspaceId !== args.workspaceId) fail("ENROLLMENT_NOT_FOUND");
    if (enrollment.state === "revoked") fail("ENROLLMENT_REVOKED");
    if (enrollment.completion) {
      const key = await ctx.db.get("keys", enrollment.completion.keyId);
      if (
        !key ||
        key.publicKey.thumbprint !== args.publicKey.thumbprint ||
        key.publicKey.algorithm !== args.publicKey.algorithm ||
        key.publicKey.material !== args.publicKey.material ||
        enrollment.completion.requestId !== args.requestId
      ) {
        fail("ENROLLMENT_ALREADY_USED");
      }
      return await activeIdentity(ctx, enrollment);
    }
    if (enrollment.expiresAt <= Date.now()) fail("ENROLLMENT_EXPIRED");
    const existingKey = await ctx.db
      .query("keys")
      .withIndex("by_thumbprint", (q) => q.eq("publicKey.thumbprint", args.publicKey.thumbprint))
      .unique();
    if (existingKey) fail("KEY_ALREADY_REGISTERED");
    const workerId = await ctx.db.insert("workers", {
      workspaceId: enrollment.workspaceId,
      name: enrollment.name,
      capabilities: enrollment.capabilities,
      status: "active",
      identityEpoch: 1,
    });
    const keyId = await ctx.db.insert("keys", { workerId, publicKey: args.publicKey });
    await ctx.db.patch("enrollments", enrollment._id, {
      state: "completed",
      completion: { workerId, keyId, requestId: args.requestId },
    });
    return { workerId, keyId, workspaceId: enrollment.workspaceId, identityEpoch: 1 };
  },
});

/** Recovery requires fresh proof of the originally enrolled key, not a setup token. */
export const recoverEnrollment = query({
  args: { workspaceId: v.string(), enrollmentId: v.string(), thumbprint: v.string() },
  returns: workerIdentity,
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId("enrollments", args.enrollmentId);
    const enrollment = id ? await ctx.db.get("enrollments", id) : null;
    if (!enrollment || enrollment.workspaceId !== args.workspaceId) fail("ENROLLMENT_NOT_FOUND");
    if (!enrollment.completion) fail("ENROLLMENT_NOT_COMPLETED");
    const key = await ctx.db.get("keys", enrollment.completion.keyId);
    if (!key || key.publicKey.thumbprint !== args.thumbprint) fail("KEY_MISMATCH");
    return await activeIdentity(ctx, enrollment);
  },
});

export const revokeEnrollment = mutation({
  args: { workspaceId: v.string(), enrollmentId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId("enrollments", args.enrollmentId);
    const enrollment = id ? await ctx.db.get("enrollments", id) : null;
    if (!enrollment || enrollment.workspaceId !== args.workspaceId) fail("ENROLLMENT_NOT_FOUND");
    if (enrollment.completion) fail("ENROLLMENT_ALREADY_USED");
    await ctx.db.patch("enrollments", enrollment._id, { state: "revoked" });
    return null;
  },
});

/** Completed receipts are retained for key-bound recovery; cleanup removes unused tokens only. */
export const pruneEnrollments = mutation({
  args: { limit: v.number() },
  returns: v.number(),
  handler: async (ctx, args) => {
    validateLimit(args.limit);
    let deleted = 0;
    for (const state of ["pending", "revoked"] as const) {
      if (deleted === args.limit) break;
      const rows = await ctx.db
        .query("enrollments")
        .withIndex("by_state_expiry", (q) => q.eq("state", state).lte("expiresAt", Date.now()))
        .take(args.limit - deleted);
      for (const row of rows) await ctx.db.delete("enrollments", row._id);
      deleted += rows.length;
    }
    return deleted;
  },
});
