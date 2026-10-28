import { v } from "convex/values";
import { internal } from "../../convex/_generated/api";
import type { Doc } from "../../convex/_generated/dataModel";
import {
  action,
  internalAction,
  internalMutation,
  type ActionCtx,
  type MutationCtx,
} from "../../convex/_generated/server";
import { authComponent } from "../../convex/auth";
import { secrets, workspaceProviderSecretNamespace } from "../../convex/secrets";
import { boundedMessage } from "../routing/failures";
import { credentialSecretName, isCredentialEnabled } from "../workspaces/credentials";
import type { ProviderSnapshot } from "../workspaces/provider";
import { LimitPollError, type LimitPollResult } from "./adapter";
import { limitAdapter } from "./adapters";
import { recordLimitEvent } from "./events";
import { meterValidator } from "./meters";
import {
  adapterFor,
  eventBase,
  limitKeySecretName,
  loadSnapshotTarget,
  providerContextFor,
  refreshBudget,
  updateSnapshot,
} from "./store";

const MINUTE = 60 * 1000;
/** Credentials claimed per cron run; bounds one action's fan-out. */
const POLL_BATCH = 25;
/** Budgets rolled over per cron run. */
const BUDGET_BATCH = 100;
/** Passive data younger than this makes a scheduled poll unnecessary. */
const PASSIVE_FRESH_MS = 10 * MINUTE;
/** A claimed poll that never reported is retried after this. */
const POLL_LEASE_MS = 5 * MINUTE;
/** Scheduled polls are due slightly early so the 5-minute cron never skips a cycle. */
const CRON_SLACK_MS = 30 * 1000;
const BACKOFF_BASE_MS = 5 * MINUTE;
const BACKOFF_MAX_MS = 60 * MINUTE;
/** Owner refreshes are limited to one per credential per minute. */
const REFRESH_MIN_INTERVAL_MS = MINUTE;

const pollTargetValidator = v.object({
  credential: v.id("workspace_credentials"),
  provider: v.object({
    npm: v.string(),
    api: v.optional(v.string()),
    oauth_flow: v.optional(v.string()),
  }),
  env: v.array(v.string()),
  values: v.record(v.string(), v.string()),
  limitKey: v.optional(v.string()),
});
type PollTarget = typeof pollTargetValidator.type;

const pollResultValidator = v.union(
  v.object({
    ok: v.literal(true),
    meters: v.array(meterValidator),
    plan: v.optional(v.string()),
    retain: v.optional(v.array(v.string())),
    partialError: v.optional(v.object({ message: v.string(), status: v.optional(v.number()) })),
    expired: v.optional(v.boolean()),
  }),
  v.object({ ok: v.literal(false), message: v.string(), status: v.optional(v.number()) }),
);

/** Exponential poll backoff: 5 minutes after the first failure, doubling, at most an hour. */
export function pollBackoffMs(failures: number) {
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1), BACKOFF_MAX_MS);
}

async function readSecretValue(
  ctx: MutationCtx,
  credential: Doc<"workspace_credentials">,
  name: string,
) {
  try {
    const stored = await secrets.get(ctx, {
      namespace: workspaceProviderSecretNamespace(credential.workspace, credential.provider),
      name,
    });
    return stored.ok ? stored.value : undefined;
  } catch {
    return undefined;
  }
}

/** Credential values and limit key for a poll; `undefined` when the secret is unreadable. */
async function pollTargetFor(
  ctx: MutationCtx,
  credential: Doc<"workspace_credentials">,
  provider: ProviderSnapshot,
): Promise<PollTarget | undefined> {
  const raw = await readSecretValue(ctx, credential, credentialSecretName(credential));
  if (raw === undefined) return undefined;
  let values: Record<string, string>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    values = Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  } catch {
    return undefined;
  }
  const limitKey = credential.limitKeyPreview
    ? await readSecretValue(ctx, credential, limitKeySecretName(credential._id))
    : undefined;
  return {
    credential: credential._id,
    provider: {
      npm: provider.npm,
      ...(provider.api !== undefined ? { api: provider.api } : {}),
      ...(provider.oauth_flow !== undefined ? { oauth_flow: provider.oauth_flow } : {}),
    },
    env: provider.env,
    values,
    ...(limitKey !== undefined ? { limitKey } : {}),
  };
}

/**
 * Claim credentials due for a scheduled poll and roll over budgets whose period ended. Rows of
 * disabled credentials or providers, of providers without a pollable adapter, and with passive
 * data under 10 minutes old are rescheduled instead of claimed.
 */
export const claimDue = internalMutation({
  args: {},
  returns: v.array(pollTargetValidator),
  handler: async (ctx) => {
    const now = Date.now();

    const budgets = await ctx.db
      .query("credential_limits")
      .withIndex("by_budgetResetsAt", (q) => q.gt("budgetResetsAt", 0).lte("budgetResetsAt", now))
      .take(BUDGET_BATCH);
    for (const row of budgets) {
      const credential = await ctx.db.get("workspace_credentials", row.credential);
      if (credential) await refreshBudget(ctx, credential, now);
      else await ctx.db.delete("credential_limits", row._id);
    }

    const due = await ctx.db
      .query("credential_limits")
      .withIndex("by_nextPollAt", (q) => q.gt("nextPollAt", 0).lte("nextPollAt", now))
      .take(POLL_BATCH);
    const targets: PollTarget[] = [];
    for (const row of due) {
      const credential = await ctx.db.get("workspace_credentials", row.credential);
      if (!credential) {
        await ctx.db.delete("credential_limits", row._id);
        continue;
      }
      const provider = await providerContextFor(ctx, credential.workspace, credential.provider);
      const adapter = adapterFor(provider);
      if (!provider || !adapter?.poll) {
        await ctx.db.patch("credential_limits", row._id, { nextPollAt: undefined });
        continue;
      }
      const next = now + adapter.pollIntervalMs - CRON_SLACK_MS;
      if (!provider.enabled || !isCredentialEnabled(credential)) {
        await ctx.db.patch("credential_limits", row._id, { nextPollAt: next });
        continue;
      }
      if (row.passiveAt !== undefined && now - row.passiveAt < PASSIVE_FRESH_MS) {
        await ctx.db.patch("credential_limits", row._id, {
          nextPollAt: row.passiveAt + PASSIVE_FRESH_MS,
        });
        continue;
      }
      const target = await pollTargetFor(ctx, credential, provider.snapshot);
      if (!target) {
        await ctx.db.patch("credential_limits", row._id, { nextPollAt: next });
        continue;
      }
      await ctx.db.patch("credential_limits", row._id, {
        nextPollAt: now + POLL_LEASE_MS,
        pollAttemptAt: now,
      });
      targets.push(target);
    }
    return targets;
  },
});

/** Claim an owner refresh: at most one poll per credential per minute. */
export const claimRefresh = internalMutation({
  args: { workspace: v.id("workspaces"), credential: v.id("workspace_credentials") },
  returns: pollTargetValidator,
  handler: async (ctx, args) => {
    const credential = await ctx.db.get("workspace_credentials", args.credential);
    if (!credential || credential.workspace !== args.workspace) {
      throw new Error("Credential not found.");
    }
    const now = Date.now();
    const target = await loadSnapshotTarget(ctx, credential, now);
    if (!target.provider || !target.adapter?.poll) {
      throw new Error("This provider has no usage endpoint to refresh.");
    }
    const last = Math.max(target.row.polledAt ?? 0, target.row.pollAttemptAt ?? 0);
    if (now - last < REFRESH_MIN_INTERVAL_MS) {
      const seconds = Math.ceil((REFRESH_MIN_INTERVAL_MS - (now - last)) / 1000);
      throw new Error(`Refreshed too recently; try again in ${seconds}s.`);
    }
    const pollTarget = await pollTargetFor(ctx, credential, target.provider.snapshot);
    if (!pollTarget) throw new Error("The credential's stored values are unreadable.");
    await ctx.db.patch("credential_limits", target.row._id, {
      nextPollAt: now + POLL_LEASE_MS,
      pollAttemptAt: now,
    });
    return pollTarget;
  },
});

/**
 * Store a poll outcome. Success replaces upstream meters (keeping metered budgets), clears the
 * error streak, and restores an expired credential; failure keeps the last meters, stores
 * `pollError`, backs off, and fires `credential_expired` (401/403) or one `poll_failed` per streak.
 */
export const recordPoll = internalMutation({
  args: { credential: v.id("workspace_credentials"), result: pollResultValidator },
  returns: v.null(),
  handler: async (ctx, args) => {
    const credential = await ctx.db.get("workspace_credentials", args.credential);
    if (!credential) return null;
    const now = Date.now();
    const target = await loadSnapshotTarget(ctx, credential, now);
    const interval = target.adapter?.pollIntervalMs;
    const result = args.result;

    if (result.ok) {
      await updateSnapshot(
        ctx,
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
            polledAt: now,
            pollFailures: 0,
            pollError: result.partialError ? { ...result.partialError, at: now } : undefined,
            nextPollAt: interval !== undefined ? now + interval - CRON_SLACK_MS : undefined,
          },
        },
        now,
      );
      return null;
    }

    const failures = (target.row.pollFailures ?? 0) + 1;
    const unauthorized = result.status === 401 || result.status === 403;
    await updateSnapshot(
      ctx,
      target,
      {
        ...(unauthorized
          ? { health: { ok: false, status: result.status!, detail: result.message } }
          : {}),
        fields: {
          pollFailures: failures,
          pollError: {
            message: result.message,
            ...(result.status !== undefined ? { status: result.status } : {}),
            at: now,
          },
          nextPollAt: interval !== undefined ? now + pollBackoffMs(failures) : undefined,
        },
      },
      now,
    );
    if (failures === 1 && !unauthorized) {
      await recordLimitEvent(ctx, {
        ...eventBase(target, target.row, now),
        kind: "poll_failed",
        ...(result.status !== undefined ? { status: result.status } : {}),
        detail: result.message,
      });
    }
    return null;
  },
});

async function pollAndRecord(ctx: ActionCtx, target: PollTarget) {
  const adapter = limitAdapter(target.provider);
  let result: typeof pollResultValidator.type;
  try {
    if (!adapter?.poll) throw new LimitPollError("This provider has no usage endpoint.");
    const polled: LimitPollResult = await adapter.poll(
      ctx,
      { env: target.env, values: target.values, limitKey: target.limitKey },
      Date.now(),
    );
    result = { ok: true, ...polled };
  } catch (error) {
    const message = boundedMessage(error instanceof Error ? error.message : String(error));
    result = {
      ok: false,
      message,
      ...(error instanceof LimitPollError && error.status !== undefined
        ? { status: error.status }
        : {}),
    };
  }
  await ctx.runMutation(internal.limits.recordPoll, { credential: target.credential, result });
}

/** Cron entry point: poll every due credential (bounded batch). */
export const pollDue = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const targets = await ctx.runMutation(internal.limits.claimDue, {});
    await Promise.all(targets.map((target) => pollAndRecord(ctx, target)));
    return null;
  },
});

/**
 * Poll one credential now. Owner only; throws when the provider has no pollable adapter or the
 * credential was polled less than a minute ago. Poll failures are stored as `pollError`.
 */
export const refresh = action({
  args: { workspace: v.id("workspaces"), credential: v.id("workspace_credentials") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const user = await authComponent.safeGetAuthUser(ctx);
    const workspace = user
      ? await ctx.runQuery(internal.workspaces.getOwnedWorkspaceForUser, {
          workspace: args.workspace,
          userId: user._id,
        })
      : null;
    if (!workspace) throw new Error("Workspace not found.");

    const target = await ctx.runMutation(internal.limits.claimRefresh, {
      workspace,
      credential: args.credential,
    });
    await pollAndRecord(ctx, target);
    return null;
  },
});
