import { defineTask } from "nitro/task";
import { coolSessions } from "../../acp/live";
import { useProcessRuntime } from "../../runtime";
import { claimLease } from "../lease";

/**
 * Runs every minute (`nitro.config.ts`): cools ACP sessions warmed and last viewed more than five
 * minutes ago, deleting their epoch streams (`../../acp/live.ts`).
 */
export default defineTask<{ cooled: number } | { skipped: true }>({
  meta: { name: "acp:cool", description: "Cool unwatched ACP sessions" },
  async run() {
    const runtime = await useProcessRuntime();
    if (!(await claimLease(runtime.drivers.kv, "acp:cool", 50_000))) {
      return { result: { skipped: true } };
    }
    return { result: await coolSessions(runtime, Date.now()) };
  },
});
