import { useEffect, useState } from "react";

import { isWorkerOnline } from "backend/src/worker/presence";
import { cn } from "@/lib/utils";

// Online means a heartbeat inside `WORKER_ONLINE_WINDOW_MS` (60 s); a 15 s clock keeps the label at
// most that much behind without re-rendering lists every second.
const clockIntervalMs = 15_000;

/**
 * `Date.now()` for Worker presence, refreshed every 15 seconds. It is `0` during server render and
 * the first client render (so markup matches); `WorkerPresence` renders nothing until it is set.
 */
export function useWorkerPresenceClock(): number {
  const [now, setNow] = useState(0);

  useEffect(() => {
    setNow(Date.now());
    const interval = window.setInterval(() => setNow(Date.now()), clockIntervalMs);
    return () => window.clearInterval(interval);
  }, []);

  return now;
}

/**
 * A Worker's online state from its last heartbeat (`api.workers.list` `lastSeenAt`, owner-only):
 * a 6px Signal dot plus `Online`/`Offline`. `now` comes from `useWorkerPresenceClock`.
 */
export function WorkerPresence({
  lastSeenAt,
  now,
  className,
}: {
  lastSeenAt?: number;
  now: number;
  className?: string;
}) {
  if (now === 0) return null;
  const isOnline = isWorkerOnline(lastSeenAt, now);

  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn("size-1.5 rounded-full", isOnline ? "bg-signal-success" : "bg-signal-idle")}
      />
      {isOnline ? "Online" : "Offline"}
    </span>
  );
}
