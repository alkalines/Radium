import { useMutation } from "@tanstack/react-query";

import { useTrpc } from "@/lib/trpc";
import { useAccount } from "@/lib/use-account";
import {
  createLoggingEnvelope,
  isLoggingEnvelopeWithinLimits,
  LOGGING_PRODUCT,
  LOGGING_SOURCES,
  type LoggingEventInput,
} from "contracts/logging/contract";

/** Frontend event fields; the logger supplies the product and source values. */
export type FrontendLogInput = Omit<LoggingEventInput, "product" | "source">;

/**
 * Create a best-effort operational logger for the authenticated browser user.
 * The returned callback drops oversized or unauthenticated events and never
 * waits for ingestion, so logging failures cannot block the caller.
 */
export function useFrontendLogger(): (input: FrontendLogInput) => void {
  const trpc = useTrpc();
  const { mutateAsync: ingest } = useMutation(trpc.logging.ingest.mutationOptions());
  const { signedIn } = useAccount();

  return (input) => {
    if (!signedIn) return;

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
