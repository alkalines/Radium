import { defineTask } from "nitro/task";
import { useProcessRuntime } from "../../runtime";
import { pruneTelemetry } from "../../telemetry/retention";
import { claimLease } from "../lease";

/**
 * Runs hourly (`nitro.config.ts`): deletes captured requests past each workspace's
 * `telemetry_retention_days`, then their empty sessions, and queues garbage collection of what
 * they pointed at (`telemetry/retention.ts`). The lease lets one replica run each interval.
 */
export default defineTask<
  { workspaces: number; requests: number; sessions: number } | { skipped: true }
>({
  meta: { name: "telemetry:retention", description: "Delete telemetry past its retention period" },
  async run() {
    const runtime = await useProcessRuntime();
    if (!(await claimLease(runtime.drivers.kv, "telemetry:retention", 55 * 60_000))) {
      return { result: { skipped: true } };
    }
    return { result: await pruneTelemetry(runtime, Date.now()) };
  },
});
