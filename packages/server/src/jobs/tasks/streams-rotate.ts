import { defineTask } from "nitro/task";
import { useProcessRuntime } from "../../runtime";
import { rotateStreams } from "../../streams/rotating";
import { claimLease } from "../lease";

/**
 * Runs every five minutes (`nitro.config.ts`): retires event, inbox and signal stream generations
 * older than a day and deletes those retired a day ago (`../../streams/rotating.ts`), draining
 * any backlog within its time budget.
 */
export default defineTask<{ retired: number; deleted: number } | { skipped: true }>({
  meta: { name: "streams:rotate", description: "Rotate and delete event stream generations" },
  async run() {
    const runtime = await useProcessRuntime();
    if (!(await claimLease(runtime.drivers.kv, "streams:rotate", 270_000))) {
      return { result: { skipped: true } };
    }
    return { result: await rotateStreams(runtime.drivers.kv, runtime.streams, Date.now()) };
  },
});
