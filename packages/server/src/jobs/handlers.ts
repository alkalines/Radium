import type { JobHandlers } from "./outbox";

/**
 * Every outbox job kind and its handler. A domain that queues jobs adds its handlers here; a job
 * whose kind has no handler fails and retries until it is parked, so a kind is removed only after
 * no queued job of it can remain.
 */
export const jobHandlers: JobHandlers = {};
