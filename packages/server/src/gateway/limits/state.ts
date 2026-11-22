import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { LimitEventKind } from "contracts/limits/events";
import type { LimitSettings, Meter } from "contracts/limits/meters";
import type { Database } from "../../drivers/types";
import { AppError } from "../../errors";
import type { Runtime } from "../../runtime";
import { readWorkspaceSettings, updateWorkspaceSettings } from "../../workspaces/settings";
import {
  credentialPreview,
  limitKeySecretName,
  MAX_PROVIDER_CREDENTIALS,
  credentialDisplayName,
  type CredentialRow,
} from "../credentials";
import { workspaceProviderRecords } from "../providers";
import { credentialLimits, limitEvents, workspaceCredentials } from "../schema";
import { putSecret, removeSecret, workspaceProviderSecretNamespace } from "../secrets";
import { limitAdapter } from "./adapters";
import {
  assertValidBudget,
  assertValidLimitSettings,
  resolveLimitSettings,
  type CredentialBudget,
} from "./meters";
import { lockSnapshot, refreshBudget, updateSnapshot } from "./store";

const DEFAULT_EVENT_LIMIT = 50;
const MAX_EVENT_LIMIT = 200;
const MAX_LIMIT_KEY_LENGTH = 4096;

/** The usage limits of one pooled credential, as the owner's Limits page lists them. */
export type CredentialLimitsView = {
  credential: string;
  provider: string;
  providerName: string;
  credentialName: string;
  enabled: boolean;
  plan: string | null;
  /** Includes the metered `budget` meter when a budget is set. */
  meters: Meter[];
  /** The adapter can poll: the owner may refresh. */
  pollable: boolean;
  /** ms epoch of the last successful poll. */
  polledAt: number | null;
  /** ms epoch of the next scheduled poll; only for pollable providers. */
  nextPollAt: number | null;
  /** The last failed poll; `at` is a ms epoch. */
  pollError: { message: string; status: number | null; at: number } | null;
  budget: CredentialBudget | null;
  /** Adapter-declared extra key; `preview` is set when the owner stored one. */
  limitKey: { label: string; description: string; preview: string | null } | null;
};

/** One limit event, as the owner's event list shows it. */
export type LimitEventView = {
  id: string;
  kind: LimitEventKind;
  provider: string;
  credential: string | null;
  credentialName: string;
  meter: Meter | null;
  previous: Meter | null;
  threshold: number | null;
  message: string;
  /** ms epoch. */
  occurredAt: number;
};

/**
 * Usage limits of every pooled credential of the workspace's providers, in provider order, then
 * creation order. Meters past `resetsAt` are returned as stored; clients show them as reset.
 * The caller has authorized the workspace's owner.
 */
export async function listCredentialLimits(
  db: Database,
  workspace: string,
): Promise<CredentialLimitsView[]> {
  const records = await workspaceProviderRecords(db, workspace);
  if (records.length === 0) {
    return [];
  }

  const credentials = await db
    .select()
    .from(workspaceCredentials)
    .where(
      and(
        eq(workspaceCredentials.workspace, workspace),
        inArray(
          workspaceCredentials.provider,
          records.map((record) => record.provider.slug),
        ),
      ),
    )
    .orderBy(asc(workspaceCredentials.createdAt), asc(workspaceCredentials.id))
    .limit(records.length * MAX_PROVIDER_CREDENTIALS);
  const limits =
    credentials.length === 0
      ? []
      : await db
          .select()
          .from(credentialLimits)
          .where(
            inArray(
              credentialLimits.credential,
              credentials.map((credential) => credential.id),
            ),
          );
  const limitsOf = new Map(limits.map((row) => [row.credential, row]));

  const result: CredentialLimitsView[] = [];
  for (const { provider } of records) {
    const adapter = limitAdapter(provider);
    const pollable = adapter?.poll !== undefined;
    for (const credential of credentials) {
      if (credential.provider !== provider.slug) {
        continue;
      }
      const row = limitsOf.get(credential.id);
      result.push({
        credential: credential.id,
        provider: provider.slug,
        providerName: provider.name,
        credentialName: credentialDisplayName(credential),
        enabled: credential.enabled,
        plan: row?.plan ?? null,
        meters: row?.meters ?? [],
        pollable,
        polledAt: row?.polledAt?.getTime() ?? null,
        nextPollAt: pollable ? (row?.nextPollAt?.getTime() ?? null) : null,
        pollError:
          row?.pollErrorMessage != null
            ? {
                message: row.pollErrorMessage,
                status: row.pollErrorStatus,
                at: row.pollErrorAt!.getTime(),
              }
            : null,
        budget:
          credential.budgetAmount !== null && credential.budgetPeriod !== null
            ? { amount: credential.budgetAmount, period: credential.budgetPeriod }
            : null,
        limitKey: adapter?.limitKey
          ? {
              label: adapter.limitKey.label,
              description: adapter.limitKey.description,
              preview: credential.limitKeyPreview,
            }
          : null,
      });
    }
  }
  return result;
}

/** The workspace's alert thresholds (defaults: warn 80 %, critical 95 %, low balance $5). */
export async function getLimitSettings(db: Database, workspace: string): Promise<LimitSettings> {
  const settings = await readWorkspaceSettings(db, workspace);
  return resolveLimitSettings(settings?.limits);
}

/** Replaces the alert thresholds; requires 0 < warn < critical ≤ 100 and lowBalance ≥ 0. */
export async function setLimitSettings(db: Database, workspace: string, settings: LimitSettings) {
  assertValidLimitSettings(settings);
  await updateWorkspaceSettings(db, workspace, { limits: settings });
}

/** The credential when it belongs to `workspace`; every other case is the same `NOT_FOUND`. */
export async function ownedCredential(
  db: Database,
  workspace: string,
  credentialId: string,
): Promise<CredentialRow> {
  const [credential] = await db
    .select()
    .from(workspaceCredentials)
    .where(
      and(eq(workspaceCredentials.id, credentialId), eq(workspaceCredentials.workspace, workspace)),
    );
  if (!credential) {
    throw new AppError("NOT_FOUND", "Credential not found.");
  }
  return credential;
}

/**
 * Sets (or with `null` clears) a credential's metered budget: USD per UTC day, ISO week or
 * month, metered from Radium's own completions. The meter is recomputed in the same transaction.
 */
export async function setCredentialBudget(
  db: Database,
  workspace: string,
  credentialId: string,
  budget: CredentialBudget | null,
) {
  await db.transaction(async (tx) => {
    await ownedCredential(tx, workspace, credentialId);
    if (budget) {
      assertValidBudget(budget);
    }
    await tx
      .update(workspaceCredentials)
      .set({ budgetAmount: budget?.amount ?? null, budgetPeriod: budget?.period ?? null })
      .where(eq(workspaceCredentials.id, credentialId));
    await refreshBudget(tx, credentialId);
  });
}

/**
 * Stores (or with `null` removes) the adapter-declared limit key of a credential (an OpenRouter
 * management key) in the Secret Store, for limit reads only. Storing one makes the credential's
 * next poll due, which the `limits:poll` task picks up within five minutes.
 */
export async function setCredentialLimitKey(
  runtime: Runtime,
  workspace: string,
  credentialId: string,
  key: string | null,
) {
  await runtime.drivers.db.transaction(async (tx) => {
    const credential = await ownedCredential(tx, workspace, credentialId);
    const now = Date.now();
    const target = await lockSnapshot(tx, credential.id, now);
    const limitKey = target?.adapter?.limitKey;
    if (!target || !limitKey) {
      throw new AppError("BAD_REQUEST", "This provider has no separate limit key.");
    }

    const location = {
      namespace: workspaceProviderSecretNamespace(credential.workspace, credential.provider),
      name: limitKeySecretName(credential.id),
    };
    if (key === null) {
      await removeSecret(tx, location);
      await tx
        .update(workspaceCredentials)
        .set({ limitKeyPreview: null })
        .where(eq(workspaceCredentials.id, credential.id));
      await updateSnapshot(tx, target, { removeMeters: limitKey.meters, fields: {} }, now);
      return;
    }

    const value = key.trim();
    if (!value) {
      throw new AppError("BAD_REQUEST", `${limitKey.label} is required.`);
    }
    if (value.length > MAX_LIMIT_KEY_LENGTH) {
      throw new AppError("BAD_REQUEST", `${limitKey.label} is too long.`);
    }
    const preview = credentialPreview(value);
    await putSecret(tx, runtime.secrets, location, value, {
      kind: "provider",
      provider: credential.provider,
      workspace: credential.workspace,
      preview: { [limitKey.label]: preview },
    });
    await tx
      .update(workspaceCredentials)
      .set({ limitKeyPreview: preview })
      .where(eq(workspaceCredentials.id, credential.id));
    await tx
      .update(credentialLimits)
      .set({ nextPollAt: new Date(now) })
      .where(eq(credentialLimits.id, target.row.id));
  });
}

/** Recent limit events, newest first (default 50, at most 200). */
export async function listLimitEvents(
  db: Database,
  workspace: string,
  limit?: number,
): Promise<LimitEventView[]> {
  const take = Math.min(Math.max(1, Math.floor(limit ?? DEFAULT_EVENT_LIMIT)), MAX_EVENT_LIMIT);
  const events = await db
    .select()
    .from(limitEvents)
    .where(eq(limitEvents.workspace, workspace))
    .orderBy(desc(limitEvents.occurredAt), desc(limitEvents.id))
    .limit(take);
  return events.map((event) => ({
    id: event.id,
    kind: event.kind,
    provider: event.provider,
    credential: event.credential,
    credentialName: event.credentialName,
    meter: event.meter,
    previous: event.previous,
    threshold: event.threshold,
    message: event.message,
    occurredAt: event.occurredAt.getTime(),
  }));
}
