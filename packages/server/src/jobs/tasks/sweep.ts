import { defineTask } from "nitro/task";
import { useProcessRuntime } from "../../runtime";
import { claimLease } from "../lease";
import { sweepJobs } from "../outbox";

/** Runs every minute (`nitro.config.ts`); the lease lets one replica run each minute's sweep. */
export default defineTask<{ ran: number | null }>({
  meta: { name: "jobs:sweep", description: "Run due outbox jobs" },
  async run() {
    const runtime = await useProcessRuntime();
    // `null`: another replica holds this minute's lease.
    if (!(await claimLease(runtime.drivers.kv, "jobs:sweep", 50_000))) {
      return { result: { ran: null } };
    }
    return { result: { ran: await sweepJobs(runtime) } };
  },
});
