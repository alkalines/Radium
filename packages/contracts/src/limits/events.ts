import { z } from "zod";

/** Kinds of limit events: threshold crossings, resets, credential health and poll failures. */
export const limitEventKindValidator = z.union([
  z.literal("limit_low"),
  z.literal("limit_critical"),
  z.literal("limit_exhausted"),
  z.literal("limit_reset"),
  z.literal("credential_expired"),
  z.literal("credential_restored"),
  z.literal("poll_failed"),
]);
export type LimitEventKind = z.infer<typeof limitEventKindValidator>;
