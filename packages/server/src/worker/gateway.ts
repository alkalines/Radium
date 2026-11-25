import { and, eq, inArray } from "drizzle-orm";
import type { AcpGatewayAccess, AcpGatewayModel } from "contracts/acp/gateway";
import type { z } from "zod";
import type { keyTelemetryValidator } from "contracts/acp/gateway";
import type { Database, Kv } from "../drivers/types";
import { AppError } from "../errors";
import {
  invalidateApiKeys,
  mintWorkerApiKey,
  revokeWorkerApiKeys,
  setWorkerApiKeyTelemetry,
} from "../gateway/keys";
import { openaiModels } from "../gateway/models";
import type { WorkerScope } from "./auth";
import { workerGateway, workers } from "./schema";

/**
 * Gateway access of Workers (Convex `src/worker/gateway.ts`): the owner turns access on (the
 * Worker may then mint its own Gateway API key), off (its key is revoked) or asks for a new key;
 * the Worker mints the key itself, so the owner never sees it. Every write takes the Worker row
 * lock, which serializes it with other Gateway changes and with revocation.
 */

type KeyTelemetry = z.infer<typeof keyTelemetryValidator>;

/** A Worker's Gateway access: its row's state, `"off"` when it has none. */
export async function workerGatewayAccess(
  db: Database,
  workerId: string,
): Promise<AcpGatewayAccess> {
  const [row] = await db
    .select({ access: workerGateway.access })
    .from(workerGateway)
    .where(eq(workerGateway.worker, workerId));
  return row?.access ?? "off";
}

/** Gateway access and telemetry of each of `workerIds` that has a row (owner Worker list). */
export async function workerGatewaySettings(db: Database, workerIds: readonly string[]) {
  if (workerIds.length === 0) return new Map<string, { access: AcpGatewayAccess; telemetry: KeyTelemetry }>();
  const rows = await db
    .select({ worker: workerGateway.worker, access: workerGateway.access, telemetry: workerGateway.telemetry })
    .from(workerGateway)
    .where(inArray(workerGateway.worker, [...workerIds]));
  return new Map(rows.map(({ worker, ...settings }) => [worker, settings]));
}

/**
 * Locks an active Worker of `workspace` for a Gateway change; unknown, foreign and revoked
 * Workers are refused alike (Convex `requireActiveWorkspaceWorker`).
 */
async function lockActiveWorker(tx: Database, workspace: string, workerId: string) {
  const [worker] = await tx
    .select({ id: workers.id, name: workers.name })
    .from(workers)
    .where(
      and(eq(workers.id, workerId), eq(workers.workspace, workspace), eq(workers.status, "active")),
    )
    .for("update");
  if (!worker) throw new AppError("NOT_FOUND", "Worker must be active in this workspace.");
  return worker;
}

async function gatewayRow(tx: Database, workerId: string) {
  const [row] = await tx.select().from(workerGateway).where(eq(workerGateway.worker, workerId));
  return row;
}

/**
 * Owner: turns a Worker's Gateway access on (`pending` until the Worker mints a key; already on
 * stays as it is) or off (its key is revoked).
 */
export async function setGatewayAccess(
  db: Database,
  kv: Kv,
  workspace: string,
  input: { workerId: string; enabled: boolean },
) {
  const revoked = await db.transaction(async (tx) => {
    await lockActiveWorker(tx, workspace, input.workerId);
    const row = await gatewayRow(tx, input.workerId);
    if (input.enabled && (row?.access === "pending" || row?.access === "active")) return [];
    const hashes = input.enabled ? [] : await revokeWorkerApiKeys(tx, input.workerId);
    const access = input.enabled ? ("pending" as const) : ("off" as const);
    const now = new Date();
    if (row) {
      await tx
        .update(workerGateway)
        .set({ access, apiKey: null, updatedAt: now })
        .where(eq(workerGateway.id, row.id));
    } else {
      await tx
        .insert(workerGateway)
        .values({ worker: input.workerId, access, telemetry: "workspace", updatedAt: now });
    }
    return hashes;
  });
  await invalidateApiKeys(kv, revoked);
}

/** Owner: revokes the Worker's current key and lets it mint a new one. Access must be on. */
export async function issueGatewayKey(db: Database, kv: Kv, workspace: string, workerId: string) {
  const revoked = await db.transaction(async (tx) => {
    await lockActiveWorker(tx, workspace, workerId);
    const row = await gatewayRow(tx, workerId);
    if (!row || row.access === "off") {
      throw new AppError("CONFLICT", "Gateway access is off on this Worker.");
    }
    const hashes = await revokeWorkerApiKeys(tx, workerId);
    await tx
      .update(workerGateway)
      .set({ access: "pending", apiKey: null, updatedAt: new Date() })
      .where(eq(workerGateway.id, row.id));
    return hashes;
  });
  await invalidateApiKeys(kv, revoked);
}

/** Owner: the telemetry choice of the Worker's Gateway requests, applied to its live key too. */
export async function setGatewayTelemetry(
  db: Database,
  kv: Kv,
  workspace: string,
  input: { workerId: string; telemetry: KeyTelemetry },
) {
  const changed = await db.transaction(async (tx) => {
    await lockActiveWorker(tx, workspace, input.workerId);
    const row = await gatewayRow(tx, input.workerId);
    const now = new Date();
    if (!row) {
      await tx.insert(workerGateway).values({
        worker: input.workerId,
        access: "off",
        telemetry: input.telemetry,
        updatedAt: now,
      });
      return [];
    }
    await tx
      .update(workerGateway)
      .set({ telemetry: input.telemetry, updatedAt: now })
      .where(eq(workerGateway.id, row.id));
    return await setWorkerApiKeyTelemetry(tx, input.workerId, input.telemetry);
  });
  await invalidateApiKeys(kv, changed);
}

/** Worker: its Gateway access and the id of the key it holds while `active`. */
export async function gatewayState(db: Database, scope: WorkerScope) {
  const row = await gatewayRow(db, scope.workerId);
  return { access: row?.access ?? ("off" as const), keyId: row?.apiKey ?? null };
}

/**
 * Worker: mints its Gateway API key (named after the Worker, with the row's telemetry choice),
 * replacing any key it held. Allowed while access is `pending` or `active`. The plaintext key is
 * returned once.
 */
export async function mintGatewayKey(db: Database, kv: Kv, scope: WorkerScope) {
  const minted = await db.transaction(async (tx) => {
    // The token was checked at the start of the call; the row lock re-checks it against a
    // revocation that committed since.
    const worker = await lockActiveWorker(tx, scope.workspaceId, scope.workerId);
    const row = await gatewayRow(tx, scope.workerId);
    if (!row || (row.access !== "pending" && row.access !== "active")) {
      throw new AppError("CONFLICT", "Gateway access is not ready to issue a key on this Worker.");
    }
    const key = await mintWorkerApiKey(tx, {
      workspace: scope.workspaceId,
      worker: scope.workerId,
      name: worker.name,
      telemetry: row.telemetry,
    });
    await tx
      .update(workerGateway)
      .set({ access: "active", apiKey: key.id, updatedAt: new Date() })
      .where(eq(workerGateway.id, row.id));
    return key;
  });
  await invalidateApiKeys(kv, minted.revoked);
  return { keyId: minted.id, key: minted.key };
}

/** Worker: the workspace's Gateway models, for agent configuration templates. */
export async function gatewayModels(db: Database, scope: WorkerScope): Promise<AcpGatewayModel[]> {
  return (await openaiModels(db, scope.workspaceId)).map((model) => ({
    slug: model.id,
    name: model.name ?? model.id,
    ...(model.context_length != null ? { context: model.context_length } : {}),
    ...(model.top_provider?.max_completion_tokens != null
      ? { output: model.top_provider.max_completion_tokens }
      : {}),
  }));
}

/** Revocation (in the revoke transaction): the Worker's key is revoked and its row removed. */
export async function clearWorkerGateway(tx: Database, workerId: string): Promise<string[]> {
  const hashes = await revokeWorkerApiKeys(tx, workerId);
  await tx.delete(workerGateway).where(eq(workerGateway.worker, workerId));
  return hashes;
}
