import { z } from "zod";
import { keyTelemetryValidator } from "contracts/acp/gateway";
import { validChatWorkerDirectory } from "contracts/worker/chat-config";
import { WORKER_SEALED_RESULT_BYTES, workerTaskStatus } from "contracts/worker/task-contract";
import { base64urlBytes } from "contracts/wire";
import { acpMachineRouter } from "../acp/router";
import {
  publishWorkerKeys,
  publishWorkerKeysInput,
  workerIdentities,
  workerTrustState,
} from "../e2ee/worker-keys";
import { AppError } from "../errors";
import { ownedWorkspaceProcedure, router, workerProcedure } from "../trpc/init";
import {
  finishLocalUsageSync,
  localUsageCursor,
  localUsageReportInput,
  localUsageSyncInput,
  reportLocalUsage,
} from "../usage/local";
import {
  gatewayModels,
  gatewayState,
  issueGatewayKey,
  mintGatewayKey,
  setGatewayAccess,
  setGatewayTelemetry,
} from "./gateway";
import {
  createEnrollment,
  currentWorker,
  listWorkers,
  revokeEnrollment,
  revokeWorker,
} from "./identity";
import { reportWorkerPresence, WORKER_TEMP_DIRECTORY_MAX } from "./presence";
import { assignedTasks, claimTask, completeSealedTask } from "./tasks";

const idInput = z.string().min(1).max(256);
const workerInput = z.object({ workerId: idInput });

/** Owner management of a workspace's Workers (Settings → Workers). */
export const workersRouter = router({
  /** Workers with last heartbeat, temp directory and Gateway access (at most 100). */
  list: ownedWorkspaceProcedure.query(({ ctx }) =>
    listWorkers(ctx.runtime.drivers.db, ctx.runtime.drivers.kv, ctx.access.workspace.id),
  ),
  /** A one-time setup code; the raw token is in the response only. */
  createEnrollment: ownedWorkspaceProcedure
    .input(z.object({ name: z.string().max(256) }))
    .mutation(({ ctx, input }) =>
      createEnrollment(ctx.runtime, ctx.access.workspace.id, input.name),
    ),
  revokeEnrollment: ownedWorkspaceProcedure
    .input(z.object({ enrollmentId: idInput }))
    .mutation(({ ctx, input }) =>
      revokeEnrollment(ctx.runtime.drivers.db, ctx.access.workspace.id, input.enrollmentId),
    ),
  revoke: ownedWorkspaceProcedure
    .input(workerInput)
    .mutation(({ ctx, input }) =>
      revokeWorker(
        ctx.runtime.drivers.db,
        ctx.runtime.drivers.kv,
        ctx.access.workspace.id,
        input.workerId,
      ),
    ),
  issueGatewayKey: ownedWorkspaceProcedure
    .input(workerInput)
    .mutation(({ ctx, input }) =>
      issueGatewayKey(
        ctx.runtime.drivers.db,
        ctx.runtime.drivers.kv,
        ctx.access.workspace.id,
        input.workerId,
      ),
    ),
  setGatewayAccess: ownedWorkspaceProcedure
    .input(workerInput.extend({ enabled: z.boolean() }))
    .mutation(({ ctx, input }) =>
      setGatewayAccess(ctx.runtime.drivers.db, ctx.runtime.drivers.kv, ctx.access.workspace.id, {
        workerId: input.workerId,
        enabled: input.enabled,
      }),
    ),
  setGatewayTelemetry: ownedWorkspaceProcedure
    .input(workerInput.extend({ telemetry: keyTelemetryValidator }))
    .mutation(({ ctx, input }) =>
      setGatewayTelemetry(
        ctx.runtime.drivers.db,
        ctx.runtime.drivers.kv,
        ctx.access.workspace.id,
        { workerId: input.workerId, telemetry: input.telemetry },
      ),
    ),
});

const sealedResultInput = base64urlBytes(WORKER_SEALED_RESULT_BYTES);

/** A Worker machine's own procedures; scope always comes from its access token. */
export const workerMachineRouter = router({
  current: workerProcedure.query(({ ctx }) => currentWorker(ctx.runtime.drivers.db, ctx.worker)),
  publishKeys: workerProcedure
    .input(publishWorkerKeysInput)
    .mutation(({ ctx, input }) => publishWorkerKeys(ctx.runtime.drivers.db, ctx.worker, input)),
  trustState: workerProcedure.query(({ ctx }) =>
    workerTrustState(ctx.runtime.drivers.db, ctx.worker),
  ),
  identities: workerProcedure
    .input(z.object({ keyIds: z.array(z.string().max(32)).max(200) }))
    .query(({ ctx, input }) =>
      workerIdentities(ctx.runtime.drivers.db, ctx.worker, input.keyIds),
    ),
  /** Heartbeat with the Worker's temp directory, every `WORKER_HEARTBEAT_INTERVAL_MS`. */
  reportPresence: workerProcedure
    .input(z.object({ tempDirectory: z.string().max(WORKER_TEMP_DIRECTORY_MAX) }))
    .mutation(async ({ ctx, input }) => {
      if (!validChatWorkerDirectory(input.tempDirectory)) {
        throw new AppError("BAD_REQUEST", "Worker temp directory must be an absolute path.");
      }
      await reportWorkerPresence(ctx.runtime.drivers.kv, ctx.worker.workerId, input.tempDirectory);
    }),
  tasks: router({
    assigned: workerProcedure
      .input(
        z.object({
          status: workerTaskStatus,
          operation: z.enum(["edit", "bash"]).optional(),
        }),
      )
      .query(({ ctx, input }) => assignedTasks(ctx.runtime.drivers.db, ctx.worker, input)),
    claim: workerProcedure
      .input(z.object({ taskId: idInput, claimId: z.string().max(128) }))
      .mutation(({ ctx, input }) => claimTask(ctx.runtime.drivers.db, ctx.worker, input)),
    completeSealed: workerProcedure
      .input(
        z.object({
          taskId: idInput,
          claimId: z.string().max(128),
          expectedRevision: z.number().int(),
          ok: z.boolean(),
          result: sealedResultInput.optional(),
          receipt: sealedResultInput.optional(),
        }),
      )
      .mutation(({ ctx, input }) =>
        completeSealedTask(ctx.runtime.drivers.db, ctx.worker, input),
      ),
  }),
  gateway: router({
    state: workerProcedure.query(({ ctx }) => gatewayState(ctx.runtime.drivers.db, ctx.worker)),
    models: workerProcedure.query(({ ctx }) => gatewayModels(ctx.runtime.drivers.db, ctx.worker)),
    mintKey: workerProcedure.mutation(({ ctx }) =>
      mintGatewayKey(ctx.runtime.drivers.db, ctx.runtime.drivers.kv, ctx.worker),
    ),
  }),
  usage: router({
    cursor: workerProcedure.query(({ ctx }) =>
      localUsageCursor(ctx.runtime.drivers.db, ctx.worker),
    ),
    report: workerProcedure
      .input(localUsageReportInput)
      .mutation(({ ctx, input }) => reportLocalUsage(ctx.runtime, ctx.worker, input)),
    finish: workerProcedure
      .input(localUsageSyncInput)
      .mutation(({ ctx, input }) => finishLocalUsageSync(ctx.runtime.drivers.db, ctx.worker, input)),
  }),
  /** ACP sessions, commands and interactions on this Worker (`src/acp/router.ts`). */
  acp: acpMachineRouter,
});
