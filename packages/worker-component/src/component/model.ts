import type { Doc } from "./_generated/dataModel.js";
import type { QueryCtx } from "./_generated/server.js";
import { fail } from "../validation.js";

/** Find a worker within the supplied workspace; missing and cross-workspace IDs are indistinguishable. */
export async function getWorker(ctx: QueryCtx, workspaceId: string, workerId: string) {
  const id = ctx.db.normalizeId("workers", workerId);
  const worker = id ? await ctx.db.get("workers", id) : null;
  if (!worker || worker.workspaceId !== workspaceId) fail("WORKER_NOT_FOUND");
  return worker;
}

/** Project persisted worker state to the public metadata contract. */
export function metadata(worker: Doc<"workers">) {
  return {
    workerId: worker._id,
    workspaceId: worker.workspaceId,
    name: worker.name,
    capabilities: worker.capabilities,
    status: worker.status,
    identityEpoch: worker.identityEpoch,
  };
}

/** Resolve a completed enrollment to its current active identity or fail closed. */
export async function activeIdentity(ctx: QueryCtx, enrollment: Doc<"enrollments">) {
  if (!enrollment.completion) fail("ENROLLMENT_NOT_COMPLETED");
  const worker = await getWorker(ctx, enrollment.workspaceId, enrollment.completion.workerId);
  if (worker.status !== "active") fail("WORKER_REVOKED");
  return {
    workerId: worker._id,
    keyId: enrollment.completion.keyId,
    workspaceId: worker.workspaceId,
    identityEpoch: worker.identityEpoch,
  };
}
