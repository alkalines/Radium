import { RateLimiter } from "@convex-dev/rate-limiter";
import { v } from "convex/values";

import { components } from "./_generated/api";
import { authComponent } from "./auth";
import { authenticatedMutation } from "./function_auth";
import {
  isLoggingEnvelopeWithinLimits,
  LOGGING_PRODUCT,
  loggingEnvelopeSchema,
  LOGGING_LIMITS,
  LOGGING_SOURCES,
} from "../src/logging/contract";
import { logger } from "../src/logging/server";

const rateLimiter = new RateLimiter(components.rateLimiter, {
  ingest: {
    kind: "fixed window",
    rate: LOGGING_LIMITS.maxEventsPerWindow,
    period: LOGGING_LIMITS.rateLimitWindowMs,
  },
});

/**
 * Authenticated app wrapper for frontend operational events. The browser never
 * supplies the actor identity; the wrapper derives it from the Better Auth user.
 */
export const ingest = authenticatedMutation({
  args: loggingEnvelopeSchema.fields,
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const authUser = await authComponent.getAuthUser(ctx);

    try {
      const status = await rateLimiter.limit(ctx, "ingest", {
        key: authUser._id,
      });
      if (!status.ok) {
        return false;
      }

      if (
        args.source !== LOGGING_SOURCES.frontend ||
        args.product !== LOGGING_PRODUCT ||
        !isLoggingEnvelopeWithinLimits(args)
      ) {
        logger.warn("logging.invalid_event");
        return false;
      }

      return await ctx.runMutation(components.logging.events.ingest, {
        ...args,
        actorId: authUser._id,
      });
    } catch {
      logger.error("logging.ingestion_failed");
      return false;
    }
  },
});
