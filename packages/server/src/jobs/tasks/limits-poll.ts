import { defineTask } from "nitro/task";
import { pollDueCredentials } from "../../gateway/limits/poll";
import { useProcessRuntime } from "../../runtime";
import { claimLease } from "../lease";

/**
 * Runs every five minutes (`nitro.config.ts`): rolls ended budgets over and polls the
 * credentials whose usage is due. The lease lets one replica run each interval.
 */
export default defineTask<{ budgets: number; polled: number } | { skipped: true }>({
  meta: { name: "limits:poll", description: "Poll upstream usage limits of due credentials" },
  async run() {
    const runtime = await useProcessRuntime();
    if (!(await claimLease(runtime.drivers.kv, "limits:poll", 270_000))) {
      return { result: { skipped: true } };
    }
    return { result: await pollDueCredentials(runtime) };
  },
});
