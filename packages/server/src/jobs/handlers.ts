import { z } from "zod";
import { FILES_RELEASE_JOB, runReleaseJob } from "../chatroom/files";
import { BUDGET_JOB, runBudgetJob } from "../gateway/limits/store";
import { FALLBACK_JOB, SEAL_JOB } from "../notifications/notify";
import { runFallbackJob } from "../notifications/push";
import { runSealJob } from "../notifications/sealing";
import { EXPORT_JOB, runExportJob } from "../telemetry/export";
import { GC_JOB, runGcJob } from "../telemetry/retention";
import { runStreamsDeleteJob, STREAMS_DELETE_JOB } from "../streams/deletion";
import {
  PRICE_LOCAL_ROW_JOB,
  PRICE_TURN_JOB,
  REPRICE_PENDING_JOB,
  runPriceLocalRowJob,
  runPriceTurnJob,
  runRepricePendingJob,
} from "../usage/prices";
import type { JobHandlers } from "./outbox";

const budgetPayload = z.object({ credential: z.string() });

/**
 * Every outbox job kind and its handler. A domain that queues jobs adds its handlers here; a job
 * whose kind has no handler fails and retries until it is parked, so a kind is removed only after
 * no queued job of it can remain.
 */
export const jobHandlers: JobHandlers = {
  // Recomputes a credential's budget meter 5 s after its last completion (`scheduleBudgetRefresh`).
  [BUDGET_JOB]: (payload, runtime) =>
    runBudgetJob(runtime, budgetPayload.parse(payload).credential),
  // Deletes a deleted chat's objects once no row references them (`queueChatFileRelease`).
  [FILES_RELEASE_JOB]: (payload, runtime) => runReleaseJob(runtime, payload),
  // Seals a new notification's detail to its recipient (`notify`).
  [SEAL_JOB]: (payload, runtime) => runSealJob(runtime, payload),
  // Pushes a notification no open tab claimed within 10 s (`notify`).
  [FALLBACK_JOB]: (payload, runtime) => runFallbackJob(runtime, payload),
  // Prices one recorded ACP turn (`recordAcpTurn`).
  [PRICE_TURN_JOB]: (payload, runtime) => runPriceTurnJob(runtime, payload),
  // Prices the models ccusage could not price in one local usage row (`reportLocalUsage`).
  [PRICE_LOCAL_ROW_JOB]: (payload, runtime) => runPriceLocalRowJob(runtime, payload),
  // Releases the turns and local rows that waited for a model's lookup (`storeModelPrices`).
  [REPRICE_PENDING_JOB]: (payload, runtime) => runRepricePendingJob(runtime, payload),
  // Sends a captured request's metadata span to privacy-mode destinations (`finishRequest`).
  [EXPORT_JOB]: (payload, runtime) => runExportJob(runtime, payload),
  // Collects the blobs and nodes deleted telemetry requests left unreferenced (`retention.ts`).
  [GC_JOB]: (payload, runtime) => runGcJob(runtime, payload),
  // Deletes the run and ACP epoch streams of a deleted chat (`queueStreamDeletion`).
  [STREAMS_DELETE_JOB]: (payload, runtime) => runStreamsDeleteJob(runtime, payload),
};
