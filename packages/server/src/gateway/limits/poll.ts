import { and, asc, eq, inArray, isNotNull, lte, or, sql } from "drizzle-orm";
import type { ProviderSnapshot } from "contracts/workspaces/provider";
import type { Database } from "../../drivers/types";
import { AppError } from "../../errors";
import type { Runtime } from "../../runtime";
import { limitKeySecretName, readCredentialValues, type CredentialRow } from "../credentials";
import { providerContextFor } from "../providers";
import { boundedMessage } from "../routing/failures";
import { credentialLimits, workspaceCredentials } from "../schema";
import { getSecret, workspaceProviderSecretNamespace } from "../secrets";
import { LimitPollError, type LimitPollResult } from "./adapter";
import { limitAdapter, type LimitAdapterProvider } from "./adapters";
import { recordLimitEvent } from "./events";
import {
  BUDGET_PENDING_TIMEOUT_MS,
  eventBase,
  lockSnapshot,
  refreshBudget,
  updateSnapshot,
  type LimitRow,
} from "./store";

const MINUTE = 60 * 1000;
/** Credentials claimed per batch; bounds the upstream fan-out of one batch. */
const POLL_BATCH = 25;
/** Batches per task run, so one run stays bounded however many rows are due. */
const MAX_POLL_BATCHES = 4;
/** Budgets recomputed per task run. */
const BUDGET_BATCH = 100;
/** Passive data younger than this makes a scheduled poll unnecessary. */
const PASSIVE_FRESH_MS = 10 * MINUTE;
/** A claimed poll that never reported is retried after this. */
const POLL_LEASE_MS = 5 * MINUTE;
/** Scheduled polls are due slightly early so the 5-minute task never skips a cycle. */
const TASK_SLACK_MS = 30 * 1000;
const BACKOFF_BASE_MS = 5 * MINUTE;
const BACKOFF_MAX_MS = 60 * MINUTE;
/** Owner refreshes are limited to one per credential per minute. */
const REFRESH_MIN_INTERVAL_MS = MINUTE;
/** One upstream request of a poll gives up after this. */
const UPSTREAM_TIMEOUT_MS = 30 * 1000;

/** Credential material of one claimed poll; secrets are read here, outside any transaction. */
export type PollTarget = {
  credential: string;
  provider: LimitAdapterProvider;
  env: string[];
  values: Record<string, string>;
  limitKey?: string;
};

/** Outcome of one poll, as {@link recordPoll} stores it. */
export type PollOutcome =
  | ({ ok: true } & LimitPollResult)
  | { ok: false; message: string; status?: number };

/** Exponential poll backoff: 5 minutes after the first failure, doubling, at most an hour. */
export function pollBackoffMs(failures: number) {
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1), BACKOFF_MAX_MS);
}

/**
 * Credential values and limit key for a poll; `undefined` when a secret is missing, malformed or
 * unreadable (an unreadable one is logged: it needs the operator).
 */
async function pollTargetFor(
  runtime: Runtime,
  credential: CredentialRow,
  provider: ProviderSnapshot,
): Promise<PollTarget | undefined> {
  const { db } = runtime.drivers;
  try {
    const values = await readCredentialValues(db, runtime.secrets, credential);
    if (!values) {
      return undefined;
    }
    let limitKey: string | undefined;
    if (credential.limitKeyPreview) {
      const stored = await getSecret(db, runtime.secrets, {
        namespace: workspaceProviderSecretNamespace(credential.workspace, credential.provider),
        name: limitKeySecretName(credential.id),
      });
      limitKey = stored.ok ? stored.value : undefined;
    }
    return {
      credential: credential.id,
      provider: { npm: provider.npm, api: provider.api, oauth_flow: provider.oauth_flow },
      env: provider.env,
      values,
      ...(limitKey !== undefined ? { limitKey } : {}),
    };
  } catch {
    console.error("Usage poll skipped: stored credential is unreadable", {
      credential: credential.id,
    });
    return undefined;
  }
}

/**
 * Claims the credentials due for a scheduled poll. One statement takes up to {@link POLL_BATCH}
 * due rows (`for update skip locked`, so concurrent runners get disjoint rows) and moves their
 * `next_poll_at` out by the lease: the claim, with no transaction held afterwards. A claimed row
 * is then either polled or rescheduled instead: rows of providers without a pollable adapter
 * stop being scheduled, rows of disabled credentials or providers, with unreadable secrets or
 * with passive data under 10 minutes old wait for their next slot.
 *
 * @returns what to poll, and how many rows were claimed (a full batch suggests more are due).
 */
export async function claimDuePolls(
  runtime: Runtime,
  now = Date.now(),
): Promise<{ targets: PollTarget[]; claimed: number }> {
  const { db } = runtime.drivers;
  const lease = new Date(now + POLL_LEASE_MS);
  const due = db
    .select({ id: credentialLimits.id })
    .from(credentialLimits)
    .where(
      and(isNotNull(credentialLimits.nextPollAt), lte(credentialLimits.nextPollAt, new Date(now))),
    )
    .orderBy(asc(credentialLimits.nextPollAt), asc(credentialLimits.id))
    .limit(POLL_BATCH)
    .for("update", { skipLocked: true });
  const rows = await db
    .update(credentialLimits)
    .set({ nextPollAt: lease })
    .where(inArray(credentialLimits.id, due))
    .returning();
  if (rows.length === 0) {
    return { targets: [], claimed: 0 };
  }

  const credentials = new Map(
    (
      await db
        .select()
        .from(workspaceCredentials)
        .where(
          inArray(
            workspaceCredentials.id,
            rows.map((row) => row.credential),
          ),
        )
    ).map((credential) => [credential.id, credential]),
  );

  // Rescheduling only replaces the lease this claim set: a row an owner made due again meanwhile
  // (a new limit key) stays due.
  const reschedule = async (row: LimitRow, nextPollAt: Date | null) => {
    await db
      .update(credentialLimits)
      .set({ nextPollAt })
      .where(and(eq(credentialLimits.id, row.id), eq(credentialLimits.nextPollAt, lease)));
  };

  const targets: PollTarget[] = [];
  for (const row of rows) {
    const credential = credentials.get(row.credential);
    if (!credential) {
      continue;
    }
    const provider = await providerContextFor(db, credential.workspace, credential.provider);
    const adapter = provider ? limitAdapter(provider.snapshot) : undefined;
    if (!provider || !adapter?.poll) {
      await reschedule(row, null);
      continue;
    }
    const nextSlot = new Date(now + adapter.pollIntervalMs - TASK_SLACK_MS);
    if (!credential.enabled || !provider.enabled) {
      await reschedule(row, nextSlot);
      continue;
    }
    if (row.passiveAt !== null && now - row.passiveAt.getTime() < PASSIVE_FRESH_MS) {
      await reschedule(row, new Date(row.passiveAt.getTime() + PASSIVE_FRESH_MS));
      continue;
    }
    const target = await pollTargetFor(runtime, credential, provider.snapshot);
    if (!target) {
      await reschedule(row, nextSlot);
      continue;
    }
    await db
      .update(credentialLimits)
      .set({ pollAttemptAt: new Date(now) })
      .where(eq(credentialLimits.id, row.id));
    targets.push(target);
  }
  return { targets, claimed: rows.length };
}

/** Stored fields of a partial poll error (a failed sub-request), or none. */
function pollErrorFields(error: { message: string; status?: number } | undefined, now: number) {
  return {
    pollErrorMessage: error?.message ?? null,
    pollErrorStatus: error?.status ?? null,
    pollErrorAt: error ? new Date(now) : null,
  };
}

/**
 * Stores a poll outcome. Success replaces upstream meters (keeping metered budgets), clears the
 * error streak and restores an expired credential. Failure keeps the last meters, stores the
 * error, backs off (5 minutes, doubling, at most an hour) and fires `credential_expired` on
 * 401/403 or otherwise one `poll_failed` per streak.
 */
export async function recordPoll(
  db: Database,
  credentialId: string,
  result: PollOutcome,
  now = Date.now(),
) {
  await db.transaction(async (tx) => {
    const target = await lockSnapshot(tx, credentialId, now);
    if (!target) {
      return;
    }
    const interval = target.adapter?.pollIntervalMs;

    if (result.ok) {
      await updateSnapshot(
        tx,
        target,
        {
          observation: {
            meters: result.meters,
            ...(result.plan !== undefined ? { plan: result.plan } : {}),
            complete: true,
            retain: result.retain,
          },
          health: result.expired
            ? { ok: false, status: 401, detail: "the key has expired" }
            : { ok: true },
          fields: {
            polledAt: new Date(now),
            pollFailures: 0,
            ...pollErrorFields(result.partialError, now),
            nextPollAt: interval !== undefined ? new Date(now + interval - TASK_SLACK_MS) : null,
          },
        },
        now,
      );
      return;
    }

    const failures = target.row.pollFailures + 1;
    const unauthorized = result.status === 401 || result.status === 403;
    await updateSnapshot(
      tx,
      target,
      {
        ...(unauthorized
          ? { health: { ok: false, status: result.status!, detail: result.message } }
          : {}),
        fields: {
          pollFailures: failures,
          ...pollErrorFields(result, now),
          nextPollAt: interval !== undefined ? new Date(now + pollBackoffMs(failures)) : null,
        },
      },
      now,
    );
    if (failures === 1 && !unauthorized) {
      await recordLimitEvent(tx, {
        ...eventBase(
          target,
          { meters: target.row.meters, plan: target.row.plan ?? undefined },
          now,
        ),
        kind: "poll_failed",
        ...(result.status !== undefined ? { status: result.status } : {}),
        detail: result.message,
      });
    }
  });
}

/** `upstream` with a deadline per request, so one hung provider cannot stall a poll run. */
function withDeadline(upstream: typeof fetch): typeof fetch {
  return Object.assign(
    (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
      upstream(input, { ...init, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) }),
    { preconnect: upstream.preconnect },
  );
}

/** Polls one claimed credential and stores the outcome. Holds no transaction during the poll. */
async function pollAndRecord(runtime: Runtime, target: PollTarget) {
  const adapter = limitAdapter(target.provider);
  let result: PollOutcome;
  try {
    if (!adapter?.poll) {
      throw new LimitPollError("This provider has no usage endpoint.");
    }
    const polled = await adapter.poll(
      { runtime, fetch: withDeadline(runtime.fetch) },
      { env: target.env, values: target.values, limitKey: target.limitKey },
      Date.now(),
    );
    result = { ok: true, ...polled };
  } catch (error) {
    result = {
      ok: false,
      message: boundedMessage(error instanceof Error ? error.message : String(error)),
      ...(error instanceof LimitPollError && error.status !== undefined
        ? { status: error.status }
        : {}),
    };
  }
  await recordPoll(runtime.drivers.db, target.credential, result);
}

/**
 * Recomputes the budgets that are due: periods that ended, and marks old enough that their
 * recompute job must have been lost (`scheduleBudgetRefresh`). One failing credential does not
 * stop the others.
 */
async function recomputeDueBudgets(runtime: Runtime, now: number): Promise<number> {
  const { db } = runtime.drivers;
  const due = await db
    .select({ credential: credentialLimits.credential })
    .from(credentialLimits)
    .where(
      or(
        and(
          isNotNull(credentialLimits.budgetResetsAt),
          lte(credentialLimits.budgetResetsAt, new Date(now)),
        ),
        and(
          isNotNull(credentialLimits.budgetPendingAt),
          lte(credentialLimits.budgetPendingAt, new Date(now - BUDGET_PENDING_TIMEOUT_MS)),
        ),
      ),
    )
    .orderBy(asc(credentialLimits.id))
    .limit(BUDGET_BATCH);
  for (const { credential } of due) {
    try {
      await db.transaction((tx) => refreshBudget(tx, credential, now));
    } catch {
      console.error("Budget recompute failed", { credential });
    }
  }
  return due.length;
}

/**
 * One run of the `limits:poll` task: rolls budgets over, then claims and polls every due
 * credential in batches (the poll fan-out of a batch runs concurrently). Provider requests go
 * through `runtime.fetch`.
 */
export async function pollDueCredentials(
  runtime: Runtime,
): Promise<{ budgets: number; polled: number }> {
  const budgets = await recomputeDueBudgets(runtime, Date.now());

  let polled = 0;
  for (let batch = 0; batch < MAX_POLL_BATCHES; batch++) {
    const { targets, claimed } = await claimDuePolls(runtime);
    await Promise.all(targets.map((target) => pollAndRecord(runtime, target)));
    polled += targets.length;
    if (claimed < POLL_BATCH) {
      break;
    }
  }
  return { budgets, polled };
}

/**
 * Polls one credential now, for its workspace's owner. The claim is one conditional update: at
 * most one poll per credential per minute, however many refreshes race. Poll failures are stored
 * as the credential's poll error, not thrown. The caller has authorized `workspace`.
 */
export async function refreshCredentialLimits(
  runtime: Runtime,
  workspace: string,
  credentialId: string,
  now = Date.now(),
) {
  const { db } = runtime.drivers;
  const [credential] = await db
    .select()
    .from(workspaceCredentials)
    .where(
      and(eq(workspaceCredentials.id, credentialId), eq(workspaceCredentials.workspace, workspace)),
    );
  if (!credential) {
    throw new AppError("NOT_FOUND", "Credential not found.");
  }

  const provider = await providerContextFor(db, workspace, credential.provider);
  if (!provider || !limitAdapter(provider.snapshot)?.poll) {
    throw new AppError("BAD_REQUEST", "This provider has no usage endpoint to refresh.");
  }
  const target = await pollTargetFor(runtime, credential, provider.snapshot);
  if (!target) {
    throw new AppError("BAD_REQUEST", "The credential's stored values are unreadable.");
  }

  // The first claim (or an earlier row) needs the snapshot row to exist.
  await db.transaction((tx) => lockSnapshot(tx, credential.id, now));
  const [claimed] = await db
    .update(credentialLimits)
    .set({ nextPollAt: new Date(now + POLL_LEASE_MS), pollAttemptAt: new Date(now) })
    .where(
      and(
        eq(credentialLimits.credential, credential.id),
        sql`(greatest(${credentialLimits.polledAt}, ${credentialLimits.pollAttemptAt}) is null
          or greatest(${credentialLimits.polledAt}, ${credentialLimits.pollAttemptAt}) <= ${new Date(now - REFRESH_MIN_INTERVAL_MS)})`,
      ),
    )
    .returning({ id: credentialLimits.id });
  if (!claimed) {
    const [row] = await db
      .select({
        polledAt: credentialLimits.polledAt,
        pollAttemptAt: credentialLimits.pollAttemptAt,
      })
      .from(credentialLimits)
      .where(eq(credentialLimits.credential, credential.id));
    const last = Math.max(row?.polledAt?.getTime() ?? 0, row?.pollAttemptAt?.getTime() ?? 0);
    const seconds = Math.max(1, Math.ceil((REFRESH_MIN_INTERVAL_MS - (now - last)) / 1000));
    throw new AppError("CONFLICT", `Refreshed too recently; try again in ${seconds}s.`);
  }

  await pollAndRecord(runtime, target);
}
