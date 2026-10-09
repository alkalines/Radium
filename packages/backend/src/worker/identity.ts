import { RateLimiter } from "@convex-dev/rate-limiter";
import { v } from "convex/values";
import { publicKey, workerIdentity } from "worker-component";
import { components } from "../../convex/_generated/api";
import { internalMutation, internalQuery } from "../../convex/_generated/server";
import { authComponent } from "../../convex/auth";
import { requireWorkspaceOwnedByUser } from "../../convex/workspaces";
import { denyWorkerAuth as denied } from "./machine";
import { CHALLENGE_TTL } from "./auth";

/**
 * Internal machine-authentication admission, separate from public management.
 * The HTTP layer verifies signatures before calling `admitProof`; this module
 * binds that proof to current database authority and consumes it transactionally.
 * Neither the Worker nor a browser may call these internal endpoints directly.
 */

const limiter = new RateLimiter(components.rateLimiter, {
  setup: { kind: "fixed window", rate: 10, period: 60_000 },
  challenge: { kind: "fixed window", rate: 120, period: 60_000 },
});

const kind = v.union(v.literal("enroll"), v.literal("recover"), v.literal("token"));

/** Persist the owner-authorized enrollment and its isolated component selector. */
export const createEnrollmentRecord = internalMutation({
  args: {
    workspace: v.id("workspaces"),
    name: v.string(),
    tokenHash: v.string(),
    expiresAt: v.number(),
  },
  returns: v.string(),
  handler: async (ctx, args) => {
    const user = await authComponent.getAuthUser(ctx);

    await requireWorkspaceOwnedByUser(ctx, args.workspace, user._id);

    const name = args.name.trim();
    if (!name || name.length > 80) {
      return denied();
    }

    await limiter.limit(ctx, "setup", { key: args.workspace, throws: true });

    const componentEnrollmentId = await ctx.runMutation(
      components.workerIdentity.enrollment.createEnrollment,
      {
        workspaceId: args.workspace,
        name,
        tokenHash: args.tokenHash,
        expiresAt: args.expiresAt,
        // Identity only in this slice; execution capabilities require separate policy.
        capabilities: [],
      },
    );

    return await ctx.db.insert("worker_enrollments", {
      workspace: args.workspace,
      componentEnrollmentId,
    });
  },
});

/**
 * Store a one-use statement for the Worker to sign, valid for sixty seconds.
 * `enroll` binds a new public key to a setup selector and stable retry request ID;
 * `recover` binds key possession to a committed receipt; `token` resolves the key
 * and current epoch from trusted persistence. Completion takes only the immutable
 * challenge ID, not new operation scope.
 */
export const createChallenge = internalMutation({
  args: {
    kind,
    enrollmentId: v.optional(v.string()),
    requestId: v.optional(v.string()),
    publicKey: v.optional(publicKey),
    workspaceId: v.optional(v.string()),
    workerId: v.optional(v.string()),
    keyId: v.optional(v.string()),
  },
  returns: v.object({ challengeId: v.string(), expiresAt: v.number() }),
  handler: async (ctx, args) => {
    const expiresAt = Date.now() + CHALLENGE_TTL;

    if (args.kind === "token") {
      // Client-supplied IDs are lookup selectors. The stored key/worker relation
      // determines the public key and epoch that this challenge actually binds.
      const workspace = ctx.db.normalizeId("workspaces", args.workspaceId ?? "");
      const record = workspace ? await ctx.db.get(workspace) : null;

      if (!record || record.archivedAt !== undefined || !args.keyId || !args.workerId) {
        return denied();
      }

      const key = await ctx.runQuery(components.workerIdentity.identities.getVerificationKey, {
        workspaceId: record._id,
        keyId: args.keyId,
      });

      if (!key || key.workerId !== args.workerId) {
        return denied();
      }

      await limiter.limit(ctx, "challenge", { key: record._id, throws: true });

      const challengeId = await ctx.db.insert("worker_auth_challenges", {
        kind: args.kind,
        workspace: record._id,
        workerId: key.workerId,
        keyId: args.keyId,
        identityEpoch: key.identityEpoch,
        publicKey: key.publicKey,
        expiresAt,
      });

      return { challengeId, expiresAt };
    }

    // Resolve the component selector here rather than accepting it from the client.
    const id = ctx.db.normalizeId("worker_enrollments", args.enrollmentId ?? "");
    const enrollment = id ? await ctx.db.get(id) : null;

    if (!enrollment || !args.publicKey || !args.requestId || args.requestId.length > 128) {
      return denied();
    }

    const workspace = await ctx.db.get(enrollment.workspace);
    if (!workspace || workspace.archivedAt !== undefined) {
      return denied();
    }

    await limiter.limit(ctx, "challenge", { key: workspace._id, throws: true });

    const challengeId = await ctx.db.insert("worker_auth_challenges", {
      kind: args.kind,
      workspace: workspace._id,
      enrollmentId: enrollment._id,
      requestId: args.requestId,
      publicKey: args.publicKey,
      expiresAt,
    });

    return { challengeId, expiresAt };
  },
});

/** Read the unexpired public verification context without consuming its challenge. */
export const getChallenge = internalQuery({
  args: { challengeId: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      material: v.string(),
      expiresAt: v.number(),
      kind,
    }),
  ),
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId("worker_auth_challenges", args.challengeId);
    const challenge = id ? await ctx.db.get(id) : null;

    if (!challenge || challenge.expiresAt <= Date.now()) {
      return null;
    }

    return {
      material: challenge.publicKey.material,
      expiresAt: challenge.expiresAt,
      kind: challenge.kind,
    };
  },
});

/**
 * Commit an HTTP-verified proof against current database authority. Challenge
 * deletion and component calls share this transaction, so later denials roll all
 * work back, competing callers cannot consume the challenge, and revocation takes
 * effect even if signature verification happened before it.
 */
export const admitProof = internalMutation({
  args: { challengeId: v.string(), tokenHash: v.optional(v.string()) },
  returns: workerIdentity,
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId("worker_auth_challenges", args.challengeId);
    const challenge = id ? await ctx.db.get(id) : null;

    if (!challenge || challenge.expiresAt <= Date.now()) {
      return denied();
    }

    const workspace = await ctx.db.get(challenge.workspace);
    if (!workspace || workspace.archivedAt !== undefined) {
      return denied();
    }

    // Tentatively consume before the operation; a thrown denial rolls this back.
    await ctx.db.delete(challenge._id);

    if (challenge.kind === "token") {
      const key = await ctx.runQuery(components.workerIdentity.identities.getVerificationKey, {
        workspaceId: workspace._id,
        keyId: challenge.keyId!,
      });

      if (
        !key ||
        key.workerId !== challenge.workerId ||
        key.identityEpoch !== challenge.identityEpoch ||
        key.publicKey.material !== challenge.publicKey.material
      ) {
        return denied();
      }

      return {
        workerId: key.workerId,
        keyId: challenge.keyId!,
        workspaceId: workspace._id,
        identityEpoch: key.identityEpoch,
      };
    }

    const enrollment = await ctx.db.get(challenge.enrollmentId!);
    if (!enrollment || enrollment.workspace !== workspace._id) {
      return denied();
    }

    if (challenge.kind === "recover") {
      // Recovery requires the original key's thumbprint, not the expired token.
      return await ctx.runQuery(components.workerIdentity.enrollment.recoverEnrollment, {
        workspaceId: workspace._id,
        enrollmentId: enrollment.componentEnrollmentId,
        thumbprint: challenge.publicKey.thumbprint,
      });
    }

    if (!args.tokenHash) {
      return denied();
    }

    const identity = await ctx.runMutation(
      components.workerIdentity.enrollment.completeEnrollment,
      {
        workspaceId: workspace._id,
        tokenHash: args.tokenHash,
        requestId: challenge.requestId!,
        publicKey: challenge.publicKey,
      },
    );

    // A valid token in this workspace must not complete a different app selector.
    const receipt = await ctx.runQuery(components.workerIdentity.enrollment.recoverEnrollment, {
      workspaceId: workspace._id,
      enrollmentId: enrollment.componentEnrollmentId,
      thumbprint: challenge.publicKey.thumbprint,
    });

    if (identity.workerId !== receipt.workerId) {
      return denied();
    }

    return identity;
  },
});

/** Remove a bounded batch of expired, unused proof contexts. */
export const pruneChallenges = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const records = await ctx.db
      .query("worker_auth_challenges")
      .withIndex("by_expiry", (q) => q.lte("expiresAt", Date.now()))
      .take(200);

    for (const record of records) {
      await ctx.db.delete(record._id);
    }

    return records.length;
  },
});
