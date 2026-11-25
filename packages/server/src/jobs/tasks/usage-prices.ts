import { defineTask } from "nitro/task";
import { useProcessRuntime } from "../../runtime";
import { resolveModelPrices } from "../../usage/prices";
import { claimLease } from "../lease";

/**
 * Runs every minute (`nitro.config.ts`): looks up the agent model choices queued for a models.dev
 * price, fetching the catalogue once per run and only when something is queued, then queues the
 * release of the usage that waited for them. The lease lets one replica run each interval.
 */
export default defineTask<{ resolved: number } | { skipped: true }>({
  meta: { name: "usage:prices", description: "Match queued agent models to models.dev prices" },
  async run() {
    const runtime = await useProcessRuntime();
    if (!(await claimLease(runtime.drivers.kv, "usage:prices", 55_000))) {
      return { result: { skipped: true } };
    }
    return { result: { resolved: await resolveModelPrices(runtime) } };
  },
});
