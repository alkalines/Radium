import { v, type Infer } from "convex/values";
import type { Id } from "../../convex/_generated/dataModel";
import type { MutationCtx } from "../../convex/_generated/server";
import { meterFraction, type LimitSettings, type Meter } from "./meters";

export const limitEventKindValidator = v.union(
  v.literal("limit_low"),
  v.literal("limit_critical"),
  v.literal("limit_exhausted"),
  v.literal("limit_reset"),
  v.literal("credential_expired"),
  v.literal("credential_restored"),
  v.literal("poll_failed"),
);
export type LimitEventKind = Infer<typeof limitEventKindValidator>;

/** Everything a limit event carries; stored whole so delivery channels need no other reads. */
export type LimitEvent = {
  workspace: Id<"workspaces">;
  kind: LimitEventKind;
  provider: { slug: string; name: string };
  credential: { id: Id<"workspace_credentials">; name: string };
  /** Meter after the change (threshold and reset events). */
  meter?: Meter;
  /** Meter before the change. */
  previous?: Meter;
  /** Percent points, or USD for balance meters. */
  threshold?: number;
  /** Upstream HTTP status (credential and poll events). */
  status?: number;
  /** Bounded upstream error message (credential and poll events). */
  detail?: string;
  /** The credential's full snapshot when the event fired. */
  snapshot: { meters: Meter[]; plan?: string };
  settings: LimitSettings;
  occurredAt: number;
};

/**
 * Record one limit event with its complete payload. This is the single trigger point for limit
 * events: threshold crossings, resets, credential expiry and restoration, and poll failures all
 * come through here, so delivery channels (inbox, email, webhooks) attach in one place.
 */
export async function recordLimitEvent(
  ctx: MutationCtx,
  event: LimitEvent,
): Promise<Id<"limit_events">> {
  return await ctx.db.insert("limit_events", {
    workspace: event.workspace,
    kind: event.kind,
    provider: event.provider.slug,
    providerName: event.provider.name,
    credential: event.credential.id,
    credentialName: event.credential.name,
    ...(event.meter ? { meter: event.meter } : {}),
    ...(event.previous ? { previous: event.previous } : {}),
    ...(event.threshold !== undefined ? { threshold: event.threshold } : {}),
    ...(event.status !== undefined ? { status: event.status } : {}),
    message: limitEventMessage(event),
    snapshot: event.snapshot,
    settings: event.settings,
    occurredAt: event.occurredAt,
  });
}

function formatDuration(ms: number) {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

function formatAmount(meter: Meter, value: number) {
  if (meter.unit === "usd") return `$${value.toFixed(2)}`;
  if (meter.unit === "credits") return `${Number(value.toFixed(2))} credits`;
  if (meter.unit === "requests") return `${Math.round(value)} requests`;
  return `${Math.round(value)}%`;
}

/** Current level: `82%` for limited meters, the remaining amount for balances. */
function meterLevel(meter: Meter) {
  const fraction = meterFraction(meter);
  if (fraction !== undefined) return `${Math.round(fraction * 100)}%`;
  if (meter.remaining !== undefined) return formatAmount(meter, meter.remaining);
  return undefined;
}

function resetSuffix(meter: Meter, now: number) {
  return meter.resetsAt !== undefined && meter.resetsAt > now
    ? ` (resets in ${formatDuration(meter.resetsAt - now)})`
    : "";
}

/** Human sentence for an event, e.g. "Work account: Weekly limit at 82% (resets in 3d)". */
export function limitEventMessage(event: LimitEvent) {
  const name = event.credential.name;
  const meter = event.meter;
  const status = event.status !== undefined ? ` (${event.status})` : "";
  const detail = event.detail ? `: ${event.detail}` : "";

  switch (event.kind) {
    case "credential_expired":
      return `${name}: ${event.provider.name} rejected the credential${status}; reconnect or replace it${detail}`;
    case "credential_restored":
      return `${name}: ${event.provider.name} accepts the credential again`;
    case "poll_failed":
      return `${name}: usage check failed${status}${detail}`;
  }

  if (!meter) return `${name}: usage limit changed`;
  const reset = resetSuffix(meter, event.occurredAt);
  // Window meters ("Weekly") read as limits; named meters ("Key limit", "Budget (month)") as is.
  const label =
    meter.unit === "percent" && !meter.label.toLowerCase().endsWith("limit")
      ? `${meter.label} limit`
      : meter.label;
  const level = meterLevel(meter);
  const balance = meterFraction(meter) === undefined;

  if (event.kind === "limit_reset") {
    return `${name}: ${label} ${balance ? "recovered" : "reset"}${level ? `, now ${level}` : ""}`;
  }
  if (event.kind === "limit_exhausted") {
    return `${name}: ${label} ${balance ? "exhausted" : "reached"}${reset}`;
  }
  return `${name}: ${label} ${balance ? "down to" : "at"} ${level ?? "threshold"}${reset}`;
}
