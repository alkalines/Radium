import { asc, inArray, lt } from "drizzle-orm";
import type { LimitEventKind } from "contracts/limits/events";
import type { LimitSettings, Meter } from "contracts/limits/meters";
import type { Database } from "../../drivers/types";
import { notify } from "../../notifications/notify";
import { activeWorkspaceOwner } from "../../workspaces/workspaces";
import { limitEvents } from "../schema";
import { meterFraction } from "./meters";

/** Limit events are kept this long. */
const EVENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Everything a limit event carries; stored whole so delivery channels need no other reads. */
export type LimitEvent = {
  workspace: string;
  kind: LimitEventKind;
  provider: { slug: string; name: string };
  credential: { id: string; name: string };
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
  /** ms epoch. */
  occurredAt: number;
};

/**
 * Records one limit event with its complete payload and notifies the workspace owner. The single
 * trigger point for limit events: threshold crossings, resets, credential expiry and
 * restoration, and poll failures all come through here, so delivery channels attach in one place
 * (`notifications/notify.ts`). Run it in the transaction that changed the snapshot, so an event
 * exists exactly when its change committed.
 */
export async function recordLimitEvent(db: Database, event: LimitEvent): Promise<string> {
  const occurredAt = new Date(event.occurredAt);
  const [row] = await db
    .insert(limitEvents)
    .values({
      workspace: event.workspace,
      kind: event.kind,
      provider: event.provider.slug,
      providerName: event.provider.name,
      credential: event.credential.id,
      credentialName: event.credential.name,
      meter: event.meter ?? null,
      previous: event.previous ?? null,
      threshold: event.threshold ?? null,
      status: event.status ?? null,
      message: limitEventMessage(event),
      snapshot: event.snapshot,
      settingsWarnPercent: event.settings.warnPercent,
      settingsCriticalPercent: event.settings.criticalPercent,
      settingsLowBalance: event.settings.lowBalance,
      occurredAt,
    })
    .returning({ id: limitEvents.id });
  const id = row!.id;

  // Limits and credentials are owner-managed, so only the owner is told; archived workspaces
  // stay quiet.
  const owner = await activeWorkspaceOwner(db, event.workspace);
  if (owner !== null) {
    await notify(db, {
      userId: owner,
      workspace: event.workspace,
      kind: event.kind,
      limitEvent: id,
      createdAt: occurredAt,
    });
  }
  return id;
}

/**
 * Deletes limit events older than 30 days, at most `batch` per call (the `retention` task runs it
 * again every five minutes). Their notifications go with them.
 *
 * @returns how many events were deleted.
 */
export async function pruneLimitEvents(db: Database, now: number, batch: number): Promise<number> {
  const expired = db
    .select({ id: limitEvents.id })
    .from(limitEvents)
    .where(lt(limitEvents.occurredAt, new Date(now - EVENT_RETENTION_MS)))
    .orderBy(asc(limitEvents.occurredAt), asc(limitEvents.id))
    .limit(batch);
  const deleted = await db
    .delete(limitEvents)
    .where(inArray(limitEvents.id, expired))
    .returning({ id: limitEvents.id });
  return deleted.length;
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
