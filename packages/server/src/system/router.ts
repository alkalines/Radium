import { tracked } from "@trpc/server";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";

import { publicProcedure, router } from "../trpc/init";
import { checkHealth, healthSchema } from "./health";

export const systemRouter = router({
  /** Same probe as `GET /api/health`, for typed clients. */
  health: publicProcedure.output(healthSchema).query(({ ctx }) => checkHealth(ctx)),

  /**
   * Transport probe for subscriptions: emits ticks `0..count-1`, `intervalMs` apart, then completes.
   * Each tick is `tracked` by its index, so a client that reconnects with `lastEventId` resumes after
   * the last tick it saw. Bounded and data-free, so it is safe without a session.
   */
  ticks: publicProcedure
    .input(
      z.object({
        count: z.int().min(1).max(10),
        intervalMs: z.int().min(100).max(5_000).default(1_000),
        lastEventId: z.string().regex(/^\d+$/).nullish(),
      }),
    )
    .subscription(async function* ({ input, signal }) {
      const first = input.lastEventId == null ? 0 : Number(input.lastEventId) + 1;

      for (let index = first; index < input.count; index++) {
        if (index > first) await sleep(input.intervalMs, undefined, { signal });
        yield tracked(String(index), { index });
      }
    }),
});
