import { z } from "zod";
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
};
