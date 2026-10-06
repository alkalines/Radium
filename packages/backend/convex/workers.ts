import { RateLimiter } from "@convex-dev/rate-limiter";
import { ConvexError, v } from "convex/values";
import { publicKey, workerIdentity, workerMetadata } from "worker-component";
import { components, internal } from "./_generated/api";
import { action, internalMutation, internalQuery, query, type QueryCtx } from "./_generated/server";
import { ownedWorkspaceMutation, ownedWorkspaceQuery } from "./helpers";
import { authComponent } from "./auth";
import { requireWorkspaceOwnedByUser } from "./workspaces";
import {
  backendOrigin,
  CHALLENGE_TTL,
  ENROLLMENT_TTL,
  machineSigningKey,
  randomToken,
  tokenDigest,
  workerIssuer,
} from "../src/worker/auth";

/**
 * Parent-app policy around the isolated workerIdentity persistence component.
 *
 * Human management: Better Auth session -> workspace owner -> component call.
 * Machine authentication: HTTP verifies a Worker signature -> internal mutation
 * admits its immutable challenge -> HTTP signs a short-lived Convex access token.
 * Machine queries then re-read current workspace/key/epoch authorization.
 *
 * The browser and Worker cannot invoke internal or component functions directly.
 * In particular, admitProof trusts only the app's verified HTTP path.
 */

const limiter = new RateLimiter(components.rateLimiter, {
  setup: { kind: "fixed window", rate: 10, period: 60_000 },
  challenge: { kind: "fixed window", rate: 120, period: 60_000 },
});
/** Keep all machine-auth denials indistinguishable at the HTTP boundary. */
function denied(): never {
  throw new ConvexError({ code: "WORKER_AUTH_DENIED" });
}
const kind = v.union(v.literal("enroll"), v.literal("recover"), v.literal("token"));

/** Owner-only, bounded identity listing; active status does not mean online. */
export const list = ownedWorkspaceQuery({
  args: {},
  returns: v.array(workerMetadata),
  handler: (ctx) =>
    ctx.runQuery(components.workerIdentity.identities.listWorkers, {
      workspaceId: ctx.workspace._id,
      limit: 100,
    }),
});

/** Revoke the identity and advance its epoch, invalidating old app authorization. */
export const revoke = ownedWorkspaceMutation({
  args: { workerId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.runMutation(components.workerIdentity.identities.revokeWorker, {
      workspaceId: ctx.workspace._id,
      workerId: args.workerId,
    });
    return null;
  },
});

/** Cancel an unused setup code; an enrolled Worker must be revoked separately. */
export const revokeEnrollment = ownedWorkspaceMutation({
  args: { enrollmentId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId("worker_enrollments", args.enrollmentId);
    const enrollment = id ? await ctx.db.get(id) : null;
    if (!enrollment || enrollment.workspace !== ctx.workspace._id) {
      return denied();
    }
    await ctx.runMutation(components.workerIdentity.enrollment.revokeEnrollment, {
      workspaceId: ctx.workspace._id,
      enrollmentId: enrollment.componentEnrollmentId,
    });
    return null;
  },
});

/**
 * Return the one-time setup bundle displayed by the owner's frontend.
 * An action creates cryptographic randomness; the internal mutation verifies the
 * owner's session and persists only the token hash. The encoded bundle contains
 * the raw token, so base64url encoding makes it portable, not encrypted.
 */
export const createEnrollment = action({
  args: { workspace: v.id("workspaces"), name: v.string() },
  returns: v.object({ code: v.string(), expiresAt: v.number(), enrollmentId: v.string() }),
  handler: async (
    ctx,
    args,
  ): Promise<{ code: string; expiresAt: number; enrollmentId: string }> => {
    const backendUrl = backendOrigin(process.env.CONVEX_SITE_URL);
    const convexUrl = backendOrigin(process.env.CONVEX_CLOUD_URL);
    await machineSigningKey();
    const token = randomToken();
    const expiresAt = Date.now() + ENROLLMENT_TTL;
    const enrollmentId = await ctx.runMutation(internal.workers.createEnrollmentRecord, {
      ...args,
      tokenHash: await tokenDigest(token),
      expiresAt,
    });
    const bundle = { version: 1, backendUrl, convexUrl, enrollmentId, token, expiresAt };
    const code =
      "radium-worker-v1." +
      btoa(JSON.stringify(bundle)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
    return { code, expiresAt, enrollmentId };
  },
});

/**
 * Authorize and create the app/component enrollment mapping in one transaction.
 * The returned app selector is what the setup code carries. The component has a
 * separate selector for its isolated receipt; it never owns app workspace policy.
 */
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
 * `enroll`: binds a new public key to a setup selector and stable retry request ID.
 * `recover`: binds key possession to a previously committed enrollment receipt.
 * `token`: resolves the enrolled key and current epoch from trusted persistence.
 * The record is immutable: completion takes only its ID, not new operation scope.
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
    await limiter.limit(ctx, "challenge", { throws: true });
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
    // Enrollment and receipt recovery use the app-owned selector from the setup
    // bundle; the component selector is resolved here, never supplied by the client.
    const id = ctx.db.normalizeId("worker_enrollments", args.enrollmentId ?? "");
    const enrollment = id ? await ctx.db.get(id) : null;
    if (!enrollment || !args.publicKey || !args.requestId || args.requestId.length > 128) {
      return denied();
    }
    const workspace = await ctx.db.get(enrollment.workspace);
    if (!workspace || workspace.archivedAt !== undefined) {
      return denied();
    }
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

/** Read public verification context for the HTTP verifier; does not consume it. */
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
 * Commit a cryptographically verified proof using current database authority.
 * Deletion and component calls share this parent mutation's transaction. If any
 * later check fails, deletion and enrollment consumption both roll back. Two
 * successful callers cannot consume the same challenge. A revoked identity cannot
 * pass simply because its signature was verified before revocation occurred.
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
    // completeEnrollment looks up a token hash, whereas this challenge binds an
    // app selector. Ensure both resolve to the same committed Worker: another
    // valid token in this workspace must not complete the wrong enrollment.
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

/**
 * Derive a machine principal from Convex-verified JWT claims, then recheck scope.
 * A valid signature is not sufficient: the workspace must still be active and
 * the component's key/Worker/epoch relation must still match the token.
 * Reuse this helper inside future control mutations' state-transition transaction;
 * add capability and job-assignment policy there before admitting privileged work.
 */
export async function requireWorker(ctx: QueryCtx) {
  const identity = await ctx.auth.getUserIdentity();
  if (
    !identity ||
    identity.issuer !== workerIssuer(backendOrigin(process.env.CONVEX_SITE_URL)) ||
    identity.kind !== "worker" ||
    typeof identity.workspaceId !== "string" ||
    typeof identity.keyId !== "string" ||
    typeof identity.identityEpoch !== "number"
  ) {
    return denied();
  }
  const workspaceId = ctx.db.normalizeId("workspaces", identity.workspaceId);
  const workspace = workspaceId ? await ctx.db.get(workspaceId) : null;
  if (!workspace || workspace.archivedAt !== undefined) {
    return denied();
  }
  const key = await ctx.runQuery(components.workerIdentity.identities.getVerificationKey, {
    workspaceId: workspace._id,
    keyId: identity.keyId,
  });
  if (!key || key.workerId !== identity.subject || key.identityEpoch !== identity.identityEpoch) {
    return denied();
  }
  return {
    workerId: key.workerId,
    keyId: identity.keyId,
    workspaceId: workspace._id,
    identityEpoch: key.identityEpoch,
  };
}

/** Narrow machine subscription to its own metadata; revoked/stale auth is denied. */
export const current = query({
  args: {},
  returns: v.union(v.null(), workerMetadata),
  handler: async (ctx) => {
    const identity = await requireWorker(ctx);
    return await ctx.runQuery(components.workerIdentity.identities.getWorkerMetadata, {
      workspaceId: identity.workspaceId,
      workerId: identity.workerId,
    });
  },
});

/** Cron cleanup of unused expired proof contexts, bounded above the creation budget. */
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
