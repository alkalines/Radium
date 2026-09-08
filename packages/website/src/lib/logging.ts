import { useConvexAuth, useMutation } from "convex/react";

import { api } from "../../convex/_generated/api";
import {
  createLoggingEnvelope,
  isLoggingEnvelopeWithinLimits,
  LOGGING_PRODUCT,
  LOGGING_SOURCES,
  type LoggingEventInput,
} from "../../logging/contract";

export type FrontendLogInput = Omit<LoggingEventInput, "product" | "source">;

/** Send an authenticated, bounded operational event without affecting UI behavior. */
export function useFrontendLogger(): (input: FrontendLogInput) => void {
  const ingest = useMutation(api.logging.ingest);
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
