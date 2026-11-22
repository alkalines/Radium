import { z } from "zod";
import { limitSettingsSchema } from "contracts/limits/meters";
import { ownedWorkspaceProcedure, router } from "../../trpc/init";
import { BUDGET_PERIODS } from "./meters";
import { refreshCredentialLimits } from "./poll";
import {
  getLimitSettings,
  listCredentialLimits,
  listLimitEvents,
  setCredentialBudget,
  setCredentialLimitKey,
  setLimitSettings,
} from "./state";

const credentialInput = z.string().min(1).max(256);
/** Generous over the stored 4096 characters; the service refuses longer keys after trimming. */
const MAX_LIMIT_KEY_INPUT = 8192;

/**
 * Gateway usage limits (the Limits page). Owner only: members, outsiders and archived workspaces
 * all see `NOT_FOUND`. Times in outputs are ms epochs (numbers); absent values are `null`.
 */
export const limitsRouter = router({
  list: ownedWorkspaceProcedure.query(({ ctx }) =>
    listCredentialLimits(ctx.runtime.drivers.db, ctx.access.workspace.id),
  ),
  listEvents: ownedWorkspaceProcedure
    .input(z.object({ limit: z.number().optional() }))
    .query(({ ctx, input }) =>
      listLimitEvents(ctx.runtime.drivers.db, ctx.access.workspace.id, input.limit),
    ),
  getSettings: ownedWorkspaceProcedure.query(({ ctx }) =>
    getLimitSettings(ctx.runtime.drivers.db, ctx.access.workspace.id),
  ),
  setSettings: ownedWorkspaceProcedure
    .input(z.object({ settings: limitSettingsSchema }))
    .mutation(({ ctx, input }) =>
      setLimitSettings(ctx.runtime.drivers.db, ctx.access.workspace.id, input.settings),
    ),
  setBudget: ownedWorkspaceProcedure
    .input(
      z.object({
        credential: credentialInput,
        budget: z.object({ amount: z.number(), period: z.enum(BUDGET_PERIODS) }).nullable(),
      }),
    )
    .mutation(({ ctx, input }) =>
      setCredentialBudget(
        ctx.runtime.drivers.db,
        ctx.access.workspace.id,
        input.credential,
        input.budget,
      ),
    ),
  setLimitKey: ownedWorkspaceProcedure
    .input(
      z.object({
        credential: credentialInput,
        key: z.string().max(MAX_LIMIT_KEY_INPUT).nullable(),
      }),
    )
    .mutation(({ ctx, input }) =>
      setCredentialLimitKey(ctx.runtime, ctx.access.workspace.id, input.credential, input.key),
    ),
  refresh: ownedWorkspaceProcedure
    .input(z.object({ credential: credentialInput }))
    .mutation(({ ctx, input }) =>
      refreshCredentialLimits(ctx.runtime, ctx.access.workspace.id, input.credential),
    ),
});
