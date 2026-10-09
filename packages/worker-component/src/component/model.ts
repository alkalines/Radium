import type { Doc } from "./_generated/dataModel.js";
import type { QueryCtx } from "./_generated/server.js";
import { fail } from "../validation.js";

export async function getWorker(ctx: QueryCtx, workspaceId: string, workerId: string) {
  const id = ctx.db.normalizeId("workers", workerId);
  const worker = id ? await ctx.db.get("workers", id) : null;
  if (!worker || worker.workspaceId !== workspaceId) fail("WORKER_NOT_FOUND");
  return worker;
}

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
