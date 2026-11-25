import { asc, eq, inArray, lt } from "drizzle-orm";
import type { LimitEventKind } from "contracts/limits/events";
import type { LimitSettings, Meter } from "contracts/limits/meters";
import type { Database } from "../../drivers/types";
import { notify } from "../../notifications/notify";
import { readWorkspaceSettings } from "../../workspaces/settings";
import { activeWorkspaceOwner } from "../../workspaces/workspaces";
import { credentialDisplayName } from "../credentials";
import { credentialLimits, limitEvents, workspaceCredentials } from "../schema";
import { meterFraction, resolveLimitSettings } from "./meters";

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
 * exists exactly when its change committed; the notification's job ids are added to `jobs` for
 * `dispatchJobs` after commit.
 */
export async function recordLimitEvent(
  db: Database,
  event: LimitEvent,
  jobs?: (string | null)[],
): Promise<string> {
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
    await notify(
      db,
      {
        userId: owner,
        workspace: event.workspace,
        kind: event.kind,
        limitEvent: id,
        createdAt: occurredAt,
      },
      jobs,
    );
  }
  return id;
}

/**
 * Everything a delivery channel needs about one limit event (Convex `limits.exportEvent`): the
 * stored event with its snapshot at the time, the workspace owner, provider and credential
 * identity, the credential's current snapshot, and the thresholds now in force. `null` once the
 * event is gone or its workspace is archived (archived workspaces stay quiet). Workspace names
 * are sealed, so channels name the workspace by id. Server-internal: never expose it to members.
 */
export async function exportLimitEvent(db: Database, eventId: string) {
  const [row] = await db
    .select({
      event: limitEvents,
      credential: {
        id: workspaceCredentials.id,
        label: workspaceCredentials.label,
        preview: workspaceCredentials.preview,
        enabled: workspaceCredentials.enabled,
        account: workspaceCredentials.account,
      },
      current: {
        meters: credentialLimits.meters,
        plan: credentialLimits.plan,
        polledAt: credentialLimits.polledAt,
        pollErrorMessage: credentialLimits.pollErrorMessage,
        pollErrorStatus: credentialLimits.pollErrorStatus,
        pollErrorAt: credentialLimits.pollErrorAt,
        expiredAt: credentialLimits.expiredAt,
      },
    })
    .from(limitEvents)
    .leftJoin(workspaceCredentials, eq(workspaceCredentials.id, limitEvents.credential))
    .leftJoin(credentialLimits, eq(credentialLimits.credential, limitEvents.credential))
    .where(eq(limitEvents.id, eventId));
  if (!row) return null;
  const ownerId = await activeWorkspaceOwner(db, row.event.workspace);
  if (ownerId === null) return null;
  const settings = await readWorkspaceSettings(db, row.event.workspace);
  const { credential, current } = row;
  return {
    event: row.event,
    workspace: { id: row.event.workspace, ownerId },
    provider: { slug: row.event.provider, name: row.event.providerName },
    credential: credential
      ? {
          id: credential.id,
          name: credentialDisplayName(credential),
          enabled: credential.enabled,
          account: credential.account,
        }
      : null,
    current:
      credential && current
        ? {
            meters: current.meters,
            plan: current.plan,
            polledAt: current.polledAt?.getTime() ?? null,
            pollError:
              current.pollErrorMessage !== null && current.pollErrorAt !== null
                ? {
                    message: current.pollErrorMessage,
                    status: current.pollErrorStatus,
                    at: current.pollErrorAt.getTime(),
                  }
                : null,
            expired: current.expiredAt !== null,
          }
        : null,
    settings: resolveLimitSettings(settings?.limits),
  };
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
