import { useConvexAuth, useMutation } from "convex/react";

import { api } from "backend/convex/_generated/api";
import {
  createLoggingEnvelope,
  isLoggingEnvelopeWithinLimits,
  LOGGING_PRODUCT,
  LOGGING_SOURCES,
  type LoggingEventInput,
} from "backend/src/logging/contract";

/** Frontend event fields; the logger supplies the product and source values. */
export type FrontendLogInput = Omit<LoggingEventInput, "product" | "source">;

/**
 * Create a best-effort operational logger for the authenticated browser user.
 * The returned callback drops oversized or unauthenticated events and never
 * waits for ingestion, so logging failures cannot block the caller.
 */
export function useFrontendLogger(): (input: FrontendLogInput) => void {
  const ingest = useMutation(api.observability.events.ingest);
  const { isAuthenticated } = useConvexAuth();

  return (input) => {
    if (!isAuthenticated) return;

    try {
      const envelope = createLoggingEnvelope({
        ...input,
        product: LOGGING_PRODUCT,
        source: LOGGING_SOURCES.frontend,
      });
      if (!isLoggingEnvelopeWithinLimits(envelope)) return;
      void ingest(envelope).catch(() => undefined);
    } catch {
      // Frontend logging is best effort and must not interrupt the caller.
    }
  };
}
