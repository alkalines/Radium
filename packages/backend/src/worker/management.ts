import { v } from "convex/values";
import { workerMetadata } from "worker-component";
import { components, internal } from "../../convex/_generated/api";
import { action } from "../../convex/_generated/server";
import { denyWorkerAuth as denied, workerQuery } from "./machine";
import { ownedWorkspaceMutation, ownedWorkspaceQuery } from "../../convex/helpers";
import { backendOrigin, ENROLLMENT_TTL, machineSigningKey, randomToken, tokenDigest } from "./auth";

/**
 * Parent-app policy around the isolated workerIdentity persistence component.
 *
 * Human management: Better Auth session -> workspace owner -> component call.
 * Machine authentication: HTTP verifies a Worker signature -> internal mutation
 * admits its immutable challenge -> HTTP signs a short-lived Convex access token.
 * Machine queries then re-read current workspace/key/epoch authorization.
 * Internal enrollment and proof definitions live in src/worker/identity.ts and
 * are re-exported through convex/workers.ts to keep their paths under workers.*.
 *
 * The browser and Worker cannot invoke internal or component functions directly.
 * In particular, the internal admitProof mutation trusts only the app's verified HTTP path.
 */

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

/** Narrow machine subscription to its own metadata; revoked/stale auth is denied. */
export const current = workerQuery({
  args: {},
  returns: v.union(v.null(), workerMetadata),
  handler: async (ctx) => {
    return await ctx.runQuery(components.workerIdentity.identities.getWorkerMetadata, {
      workspaceId: ctx.worker.workspaceId,
      workerId: ctx.worker.workerId,
    });
  },
});
