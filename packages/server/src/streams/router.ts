import { z } from "zod";
import { AppError } from "../errors";
import { router, sessionProcedure } from "../trpc/init";
import { workspaceAccess } from "../workspaces/access";
import { userEvents, workspaceEvents } from "./events";
import { currentStream } from "./rotating";

/** Browser event streams (`docs/Backend_Migration/Live_Data.md`, Invalidation Events). */
export const eventsRouter = router({
  /**
   * What this deployment syncs live: with `electric`, the web app sources its synced collections
   * from `/api/shapes/*`; without it, from tRPC queries refreshed by invalidation events.
   */
  config: sessionProcedure.query(({ ctx }) => ({ electric: ctx.runtime.config.ELECTRIC_URL !== undefined })),
  /**
   * The caller's current event streams, read through `/api/streams/<path>`: their own, and the
   * workspace's when they own it or are a member. A reader that finds its stream closed
   * (`rotate`), missing or gone asks again.
   */
  streams: sessionProcedure
    .input(z.object({ workspace: z.string().min(1).max(256).optional() }))
    .query(async ({ ctx, input }) => {
      const { kv } = ctx.runtime.drivers;
      let workspace: string | null = null;
      if (input.workspace) {
        if (!(await workspaceAccess(ctx.runtime.drivers.db, ctx.user.id, input.workspace))) {
          throw new AppError("NOT_FOUND", "Workspace not found.");
        }
        workspace = await currentStream(kv, ctx.runtime.streams, workspaceEvents(input.workspace));
      }
      return {
        user: await currentStream(kv, ctx.runtime.streams, userEvents(ctx.user.id)),
        workspace,
      };
    }),
});
