import { z } from "zod";
import { ownedWorkspaceProcedure, router, sessionProcedure } from "../trpc/init";
import { getActivity, getGenerations, getUsage } from "./activity";
import { getChatCost } from "./chat-cost";
import { listLocalUsageSyncs } from "./local";

/** Latest instant a JavaScript `Date` holds, in ms. */
const MAX_TIME_MS = 8.64e15;
const limitInput = z.object({ limit: z.number().optional() });

/**
 * Usage reads (Convex `observability.usage.*` and `agent_usage.GetChatCost`/`LocalUsageSyncs`).
 * Everything but `getChatCost` is owner-only. Times are ms since epoch.
 */
export const usageRouter = router({
  /** Aggregated Gateway, ACP and local CLI usage since `since`; see `getActivity`. */
  getActivity: ownedWorkspaceProcedure
    .input(
      z.object({
        since: z.number().min(0).max(MAX_TIME_MS),
        sources: z.enum(["all", "gateway"]).optional(),
        project: z.string().min(1).max(256).optional(),
      }),
    )
    .query(({ ctx, input }) =>
      getActivity(ctx.runtime.drivers.db, ctx.access, ctx.user.id, input),
    ),
  /** The newest owner-visible generations with request metadata (`limit` 1-200, default 100). */
  getGenerations: ownedWorkspaceProcedure
    .input(limitInput)
    .query(({ ctx, input }) =>
      getGenerations(ctx.runtime.drivers.db, ctx.access, ctx.user.id, input.limit),
    ),
  /** Recent owner-visible usage estimates (`limit` 1-200, default 50). */
  getUsage: ownedWorkspaceProcedure
    .input(limitInput)
    .query(({ ctx, input }) =>
      getUsage(ctx.runtime.drivers.db, ctx.access, ctx.user.id, input.limit),
    ),
  /** A Session's estimated total for anyone who can open the chat; otherwise `NOT_FOUND`. */
  getChatCost: sessionProcedure
    .input(z.object({ chat: z.string().min(1).max(256) }))
    .query(({ ctx, input }) => getChatCost(ctx.runtime.drivers.db, ctx.user.id, input.chat)),
  /** Each Worker's local CLI usage sync state. */
  localUsageSyncs: ownedWorkspaceProcedure.query(({ ctx }) =>
    listLocalUsageSyncs(ctx.runtime.drivers.db, ctx.access.workspace.id),
  ),
});
