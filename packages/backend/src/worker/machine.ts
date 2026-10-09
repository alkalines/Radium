import { customCtx, customMutation, customQuery } from "convex-helpers/server/customFunctions";
import { ConvexError } from "convex/values";
import type { Id } from "../../convex/_generated/dataModel";
import { components } from "../../convex/_generated/api";
import { mutation, query, type MutationCtx, type QueryCtx } from "../../convex/_generated/server";
import { backendOrigin, workerIssuer } from "./auth";

/** Keep machine authorization failures indistinguishable from HTTP proof denials. */
export function denyWorkerAuth(): never {
  throw new ConvexError({ code: "WORKER_AUTH_DENIED" });
} 

/** Server-derived identity scope available to machine-authorized handlers. */
export type WorkerScope = {
  workerId: string;
  keyId: string;
  workspaceId: Id<"workspaces">;
  identityEpoch: number;
};

/** Query context enriched with the current, verified Worker scope. */
export type WorkerQueryCtx = QueryCtx & { worker: WorkerScope };

/** Mutation context enriched with the current, verified Worker scope. */
export type WorkerMutationCtx = MutationCtx & { worker: WorkerScope };

/**
 * Resolve authority from Convex-verified claims and current persistence.
 *
 * The JWT's workspace/key IDs are selectors, not authority. Re-reading the active
 * workspace and key relation makes revocation and epoch changes effective inside
 * each query or mutation, even while the token's signature remains valid.
 */
const workerContext = customCtx(async (ctx: QueryCtx) => {
  const identity = await ctx.auth.getUserIdentity();

  if (
    !identity ||
    identity.issuer !== workerIssuer(backendOrigin(process.env.CONVEX_SITE_URL)) ||
    identity.kind !== "worker" ||
    typeof identity.workspaceId !== "string" ||
    typeof identity.keyId !== "string" ||
    typeof identity.identityEpoch !== "number"
  ) {
    return denyWorkerAuth();
  }

  const workspaceId = ctx.db.normalizeId("workspaces", identity.workspaceId);
  const workspace = workspaceId ? await ctx.db.get(workspaceId) : null;

  if (!workspace || workspace.archivedAt !== undefined) {
    return denyWorkerAuth();
  }

  const key = await ctx.runQuery(components.workerIdentity.identities.getVerificationKey, {
    workspaceId: workspace._id,
    keyId: identity.keyId,
  });

  if (!key || key.workerId !== identity.subject || key.identityEpoch !== identity.identityEpoch) {
    return denyWorkerAuth();
  }

  return {
    worker: {
      workerId: key.workerId,
      keyId: identity.keyId,
      workspaceId: workspace._id,
      identityEpoch: key.identityEpoch,
    },
  };
});

/** Machine-only reads with server-derived scope in `ctx.worker`. */
export const workerQuery = customQuery(query, workerContext);

/**
 * Machine-only writes; authorization is rechecked in the state-transition transaction.
 * This grants identity authority only. Execution handlers must additionally check
 * capabilities and job assignments before admitting privileged operations.
 */
export const workerMutation = customMutation(mutation, workerContext);
