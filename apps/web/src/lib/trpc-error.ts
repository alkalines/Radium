import { TRPCClientError } from "@trpc/client";

/**
 * Whether the backend answered and refused the request (missing, forbidden or signed-out), as
 * opposed to a network or server failure. A refusal is final; anything else may pass.
 */
export function isTrpcRefusal(error: unknown): boolean {
  return error instanceof TRPCClientError && (error.data?.httpStatus ?? 500) < 500;
}

/** React Query `retry`: transient failures retry twice, refusals never. */
export function retryTransient(failureCount: number, error: unknown): boolean {
  return failureCount < 2 && !isTrpcRefusal(error);
}
