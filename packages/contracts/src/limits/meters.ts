import { z } from "zod";

/**
 * Usage-limit meters: every upstream signal (response headers, usage polls, error bodies) and the
 * owner's metered budget normalizes to this shape. Fraction used is derived, never stored. Times
 * are ms epochs. Strings are bounded because meters are stored and returned as JSON.
 */

const MAX_TEXT_LENGTH = 200;
const MAX_METERS = 100;

export const meterSchema = z.object({
  /** Stable per adapter, e.g. `codex:primary`, `openrouter:key`, `budget`. */
  id: z.string().max(MAX_TEXT_LENGTH),
  label: z.string().max(MAX_TEXT_LENGTH),
  /** `account` meters are shared by every key of the upstream account. */
  scope: z.union([z.literal("credential"), z.literal("account")]),
  unit: z.union([
    z.literal("percent"),
    z.literal("usd"),
    z.literal("requests"),
    /** Upstream credit balance that is not USD (ChatGPT Codex credits). */
    z.literal("credits"),
  ]),
  /** Percent meters: 0-100; other units: amount used. */
  used: z.number().optional(),
  /** Absent for percent meters and uncapped balances. */
  limit: z.number().optional(),
  /** Balances without a cap. */
  remaining: z.number().optional(),
  /** Window length; absent means the meter never resets. */
  windowSeconds: z.number().optional(),
  /** ms epoch. */
  resetsAt: z.number().optional(),
  source: z.union([
    z.literal("header"),
    z.literal("poll"),
    z.literal("error"),
    z.literal("metered"),
  ]),
  /** ms epoch. */
  observedAt: z.number(),
});
export type Meter = z.infer<typeof meterSchema>;

/** Meters and plan learned from one response, error body, or poll. */
export const limitObservationSchema = z.object({
  meters: z.array(meterSchema).max(MAX_METERS),
  plan: z.string().max(MAX_TEXT_LENGTH).optional(),
});
export type LimitObservation = z.infer<typeof limitObservationSchema>;

/** Highest alert already fired for a meter; cleared (re-armed) by a reset or hysteresis. */
export const alertStateSchema = z.object({
  meter: z.string().max(MAX_TEXT_LENGTH),
  level: z.union([z.literal("low"), z.literal("critical"), z.literal("exhausted")]),
  resetsAt: z.number().optional(),
});
export type AlertState = z.infer<typeof alertStateSchema>;

/** Workspace usage-limit alert thresholds. */
export const limitSettingsSchema = z.object({
  /** Percent used at which a meter warns. */
  warnPercent: z.number(),
  /** Percent used at which a meter is critical. */
  criticalPercent: z.number(),
  /** USD balance under which a remaining-only USD meter alerts. */
  lowBalance: z.number(),
});
export type LimitSettings = z.infer<typeof limitSettingsSchema>;
