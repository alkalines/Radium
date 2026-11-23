import { z } from "zod";
import { FILES_RELEASE_JOB, runReleaseJob } from "../chatroom/files";
import { BUDGET_JOB, runBudgetJob } from "../gateway/limits/store";
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
};
