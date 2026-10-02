import { v } from "convex/values";
import { mutation, query } from "./_generated/server.js";
import { publicKey, workerMetadata } from "../contracts.js";
import { getWorker, metadata } from "./model.js";
import { validateLimit } from "../validation.js";

export const getWorkerMetadata = query({
  args: { workspaceId: v.string(), workerId: v.string() },
  returns: workerMetadata,
  handler: async (ctx, args) => metadata(await getWorker(ctx, args.workspaceId, args.workerId)),
});

/** Bounded first-page metadata for owner management, never key or enrollment material. */
export const listWorkers = query({
  args: { workspaceId: v.string(), limit: v.number() },
  returns: v.array(workerMetadata),
  handler: async (ctx, args) => {
    validateLimit(args.limit);
    const workers = await ctx.db
      .query("workers")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .take(args.limit);
    return workers.map(metadata);
  },
});

export const getVerificationKey = query({
  args: { workspaceId: v.string(), keyId: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      workerId: v.string(),
      workspaceId: v.string(),
      identityEpoch: v.number(),
      publicKey,
    }),
  ),
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId("keys", args.keyId);
    const key = id ? await ctx.db.get("keys", id) : null;
    if (!key) return null;
    const worker = await ctx.db.get("workers", key.workerId);
    if (!worker || worker.workspaceId !== args.workspaceId || worker.status !== "active")
      return null;
    return {
      workerId: worker._id,
      workspaceId: worker.workspaceId,
      identityEpoch: worker.identityEpoch,
      publicKey: key.publicKey,
    };
  },
});

export const revokeWorker = mutation({
  args: { workspaceId: v.string(), workerId: v.string() },
  returns: v.number(),
  handler: async (ctx, args) => {
    const worker = await getWorker(ctx, args.workspaceId, args.workerId);
    if (worker.status === "revoked") return worker.identityEpoch;
    const identityEpoch = worker.identityEpoch + 1;
    await ctx.db.patch("workers", worker._id, { status: "revoked", identityEpoch });
    return identityEpoch;
  },
});
