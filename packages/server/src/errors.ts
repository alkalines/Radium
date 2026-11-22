/**
 * An expected refusal by a domain service: the caller sees `message` with `code`. Services throw
 * it instead of tRPC errors so they stay transport-neutral; `src/trpc/init.ts` maps it. Messages
 * are user-facing and never include secrets, key material or row content. Anything else thrown
 * is an internal error and its message is not sent to the client.
 */
export class AppError extends Error {
  constructor(
    readonly code: "BAD_REQUEST" | "FORBIDDEN" | "NOT_FOUND" | "CONFLICT",
    message: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}

/**
 * Runs a contracts validator that refuses with a plain `Error` (`assertValidPlacement`,
 * `assertValidRoutingSettings`, …) and turns its message into a `BAD_REQUEST` refusal. Those
 * messages describe the caller's own input, never stored data.
 */
export function assertValid(check: () => void) {
  try {
    check();
  } catch (error) {
    throw new AppError("BAD_REQUEST", error instanceof Error ? error.message : "Invalid input.");
  }
}
