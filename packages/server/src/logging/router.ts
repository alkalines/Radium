import * as z from "zod";
import { LOGGING_LIMITS, loggingEnvelopeSchema } from "contracts/logging/contract";
import { router, sessionProcedure } from "../trpc/init";
import { ingestFrontendEvent } from "./ingest";

const metadataValue = z.union([
  z.string().max(LOGGING_LIMITS.maxMetadataValueLength),
  z.number(),
  z.boolean(),
  z.null(),
]);
const correlationValue = z.string().max(LOGGING_LIMITS.maxCorrelationValueLength).optional();

/** The shared envelope with every string bounded; finer limits are checked by the service. */
const envelopeInput = loggingEnvelopeSchema.extend({
  event: z.string().max(LOGGING_LIMITS.maxEventLength),
  message: z.string().max(LOGGING_LIMITS.maxMessageLength).optional(),
  source: z.string().max(LOGGING_LIMITS.maxSourceLength),
  product: z.string().max(LOGGING_LIMITS.maxProductLength),
  metadata: z
    .record(z.string().max(LOGGING_LIMITS.maxMetadataKeyLength), metadataValue)
    .optional(),
  correlation: z
    .object({ requestId: correlationValue, sessionId: correlationValue, traceId: correlationValue })
    .optional(),
});

/** Browser operational events (Convex `observability.events`). */
export const loggingRouter = router({
  ingest: sessionProcedure
    .input(envelopeInput)
    .mutation(({ ctx, input }) =>
      ingestFrontendEvent(ctx.runtime.drivers.kv, ctx.user.id, input),
    ),
});
