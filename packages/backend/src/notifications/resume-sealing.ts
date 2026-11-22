import { makeFunctionReference } from "convex/server";

/**
 * Cutover hook: schedule this (empty args) from the same transaction that unfreezes writes
 * (`setFrozen(false)` and `finishCutover`) so notification sealing held by the freeze resumes. It
 * is a no-op while frozen again, never pushes, and takes only an opaque pagination cursor.
 */
export const resumeNotificationSealingReference = makeFunctionReference<
  "mutation",
  { cursor?: string },
  null
>("notifications:resumeSealing");
