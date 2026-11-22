/**
 * Worker presence timing shared by the Worker heartbeat, backend, and web. Pure so clients can
 * import it without Convex server code. Presence is advisory display state: it never grants or
 * blocks execution, which dispatch authorizes separately.
 */

/** How often a connected Worker reports presence and its temp directory. */
export const WORKER_HEARTBEAT_INTERVAL_MS = 20_000;

/** A Worker counts as online when its last report is at most this old (three missed beats). */
export const WORKER_ONLINE_WINDOW_MS = 60_000;

/** Whether a Worker that last reported at `lastSeenAt` is online at `now` (both epoch ms). */
export function isWorkerOnline(lastSeenAt: number | undefined, now: number): boolean {
  return lastSeenAt !== undefined && now - lastSeenAt <= WORKER_ONLINE_WINDOW_MS;
}
