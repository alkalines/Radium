/** Public authentication facade retained for Worker and backend callers. */
export { EnrollmentNotFoundError, recoverPendingIdentity, setupWorker } from "./auth/enrollment.js";
export { createMachineTokenFetcher, requestMachineToken } from "./auth/token.js";
export type { AuthOptions } from "./auth/proof.js";
export type { MachineTokenResponse } from "./auth/token.js";
