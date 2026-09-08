import { v } from "convex/values";

import {
  isLoggingEnvelopeWithinLimits,
  loggingEnvelopeSchema,
  LOGGING_LIMITS,
} from "../../../logging/contract";
import { mutation } from "./_generated/server";

/** Persist one already-authenticated operational event in the isolated component database. */
export const ingest = mutation({
  args: {
    ...loggingEnvelopeSchema.fields,
    actorId: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const { actorId, ...envelope } = args;
    if (
      actorId.length === 0 ||
      actorId.length > LOGGING_LIMITS.maxIdentityLength ||
      !isLoggingEnvelopeWithinLimits(envelope)
    ) {
      return false;
    }

    await ctx.db.insert("events", {
      ...envelope,
      actorId,
      receivedAt: Date.now(),
    });
    return true;
  },
});
