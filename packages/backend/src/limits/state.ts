import { v } from "convex/values";
import type { Id } from "../../convex/_generated/dataModel";
import { internalMutation, internalQuery, type QueryCtx } from "../../convex/_generated/server";
import { ownedWorkspaceMutation, ownedWorkspaceQuery } from "../../convex/helpers";
import { workspaceProviderRecords } from "../../convex/provider_records";
import { secrets, workspaceProviderSecretNamespace } from "../../convex/secrets";
import schema from "../../convex/schema";
import { credentialPreview } from "../credential_preview";
import {
  credentialDisplayName,
  isCredentialEnabled,
  MAX_PROVIDER_CREDENTIALS,
} from "../workspaces/credentials";
import { limitAdapter } from "./adapters";
import { limitEventKindValidator } from "./events";
import {
  assertValidBudget,
  assertValidLimitSettings,
  credentialBudgetValidator,
  limitSettingsValidator,
  meterValidator,
  resolveLimitSettings,
} from "./meters";
import {
  limitKeySecretName,
  limitRowFor,
  loadSnapshotTarget,
  refreshBudget as refreshBudgetMeter,
  updateSnapshot,
} from "./store";

const DEFAULT_EVENT_LIMIT = 50;
const MAX_EVENT_LIMIT = 200;
const EVENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const PRUNE_BATCH = 500;
const MAX_LIMIT_KEY_LENGTH = 4096;

const pollErrorValidator = v.object({
  message: v.string(),
  status: v.optional(v.number()),
  at: v.number(),
});

const credentialLimitsValidator = v.object({
  credential: v.id("workspace_credentials"),
  provider: v.string(),
  providerName: v.string(),
  credentialName: v.string(),
  enabled: v.boolean(),
  plan: v.optional(v.string()),
  /** Includes the metered `budget` meter when a budget is set. */
  meters: v.array(meterValidator),
  /** The adapter can poll: the owner may refresh. */
  pollable: v.boolean(),
  polledAt: v.optional(v.number()),
  nextPollAt: v.optional(v.number()),
  pollError: v.optional(pollErrorValidator),
  budget: v.optional(credentialBudgetValidator),
  /** Adapter-declared extra key; `preview` is present when one is set. */
  limitKey: v.optional(
    v.object({ label: v.string(), description: v.string(), preview: v.optional(v.string()) }),
  ),
});

const limitEventViewValidator = v.object({
  _id: v.id("limit_events"),
  kind: limitEventKindValidator,
  provider: v.string(),
  credential: v.optional(v.id("workspace_credentials")),
  credentialName: v.string(),
  meter: v.optional(meterValidator),
  previous: v.optional(meterValidator),
  threshold: v.optional(v.number()),
  message: v.string(),
  occurredAt: v.number(),
});

/**
 * Usage limits of every pooled credential of the workspace's providers, in provider order, then
 * creation order. Owner only. Meters past `resetsAt` are returned as stored; clients show them
 * as reset.
 */
export const list = ownedWorkspaceQuery({
  args: {},
  returns: v.array(credentialLimitsValidator),
  handler: async (ctx) => {
    const result: Array<typeof credentialLimitsValidator.type> = [];
    for (const record of await workspaceProviderRecords(ctx, ctx.workspace)) {
      const provider = record.provider;
      const adapter = limitAdapter(provider);
      const credentials = await ctx.db
        .query("workspace_credentials")
        .withIndex("by_workspace_and_provider", (q) =>
          q.eq("workspace", ctx.workspace._id).eq("provider", provider.slug),
        )
        .take(MAX_PROVIDER_CREDENTIALS);

      for (const credential of credentials) {
        const row = await limitRowFor(ctx, credential._id);
        const pollable = adapter?.poll !== undefined;
        result.push({
          credential: credential._id,
          provider: provider.slug,
          providerName: provider.name,
          credentialName: credentialDisplayName(credential),
          enabled: isCredentialEnabled(credential),
          ...(row?.plan !== undefined ? { plan: row.plan } : {}),
          meters: row?.meters ?? [],
          pollable,
          ...(row?.polledAt !== undefined ? { polledAt: row.polledAt } : {}),
          ...(pollable && row?.nextPollAt !== undefined ? { nextPollAt: row.nextPollAt } : {}),
          ...(row?.pollError ? { pollError: row.pollError } : {}),
          ...(credential.budget ? { budget: credential.budget } : {}),
          ...(adapter?.limitKey
            ? {
                limitKey: {
                  ...adapter.limitKey,
                  ...(credential.limitKeyPreview ? { preview: credential.limitKeyPreview } : {}),
                },
              }
            : {}),
        });
      }
    }
    return result;
  },
});

/** Workspace alert thresholds (defaults: warn 80 %, critical 95 %, low balance $5). Owner only. */
export const getSettings = ownedWorkspaceQuery({
  args: {},
  returns: limitSettingsValidator,
  handler: async (ctx) => resolveLimitSettings(ctx.workspace.settings.limits),
});

/** Replace the alert thresholds. Owner only; requires 0 < warn < critical ≤ 100, lowBalance ≥ 0. */
export const setSettings = ownedWorkspaceMutation({
  args: { settings: limitSettingsValidator },
  returns: v.null(),
  handler: async (ctx, args) => {
    assertValidLimitSettings(args.settings);
    await ctx.workspace.updateSettings({ limits: args.settings });
    return null;
  },
});

async function ownedCredential(
  ctx: Pick<QueryCtx, "db">,
  workspace: Id<"workspaces">,
  credentialId: Id<"workspace_credentials">,
) {
  const credential = await ctx.db.get("workspace_credentials", credentialId);
  if (!credential || credential.workspace !== workspace) throw new Error("Credential not found.");
  return credential;
}

/**
 * Set (or with `null` clear) a credential's metered budget: USD per UTC day, ISO week, or month,
 * metered from Radium's own completions. Owner only; the meter is recomputed immediately.
 */
export const setBudget = ownedWorkspaceMutation({
  args: {
    credential: v.id("workspace_credentials"),
    budget: v.union(credentialBudgetValidator, v.null()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const credential = await ownedCredential(ctx, ctx.workspace._id, args.credential);
    if (args.budget) assertValidBudget(args.budget);
    await ctx.db.patch("workspace_credentials", credential._id, {
      budget: args.budget ?? undefined,
    });
    const updated = (await ctx.db.get("workspace_credentials", credential._id))!;
    await refreshBudgetMeter(ctx, updated, Date.now());
    return null;
  },
});

/**
 * Store (or with `null` remove) the adapter-declared limit key of a credential (OpenRouter
 * management key), kept in Secret Store and used only for limit reads. Owner only; the next poll
 * runs as soon as the cron does.
 */
export const setLimitKey = ownedWorkspaceMutation({
  args: { credential: v.id("workspace_credentials"), key: v.union(v.string(), v.null()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const credential = await ownedCredential(ctx, ctx.workspace._id, args.credential);
    const now = Date.now();
    const target = await loadSnapshotTarget(ctx, credential, now);
    const adapter = target.adapter;
    if (!adapter?.limitKey) throw new Error("This provider has no separate limit key.");

    const namespace = workspaceProviderSecretNamespace(ctx.workspace._id, credential.provider);
    const name = limitKeySecretName(credential._id);
    if (args.key === null) {
      await secrets.remove(ctx, { namespace, name });
      await ctx.db.patch("workspace_credentials", credential._id, { limitKeyPreview: undefined });
      await updateSnapshot(ctx, target, { removeMeters: ["openrouter:credits"], fields: {} }, now);
      return null;
    }

    const key = args.key.trim();
    if (!key) throw new Error(`${adapter.limitKey.label} is required.`);
    if (key.length > MAX_LIMIT_KEY_LENGTH)
      throw new Error(`${adapter.limitKey.label} is too long.`);
    const preview = credentialPreview(key);
    await secrets.put(ctx, {
      namespace,
      name,
      value: key,
      metadata: {
        kind: "provider",
        provider: credential.provider,
        workspace: ctx.workspace._id,
        preview: { [adapter.limitKey.label]: preview },
      },
    });
    await ctx.db.patch("workspace_credentials", credential._id, { limitKeyPreview: preview });
    await ctx.db.patch("credential_limits", target.row._id, { nextPollAt: now });
    return null;
  },
});

/** Recent limit events, newest first (default 50, at most 200). Owner only. */
export const listEvents = ownedWorkspaceQuery({
  args: { limit: v.optional(v.number()) },
  returns: v.array(limitEventViewValidator),
  handler: async (ctx, args) => {
    const limit = Math.min(
      Math.max(1, Math.floor(args.limit ?? DEFAULT_EVENT_LIMIT)),
      MAX_EVENT_LIMIT,
    );
    const events = await ctx.db
      .query("limit_events")
      .withIndex("by_workspace_and_occurredAt", (q) => q.eq("workspace", ctx.workspace._id))
      .order("desc")
      .take(limit);
    return events.map((event) => ({
      _id: event._id,
      kind: event.kind,
      provider: event.provider,
      ...(event.credential ? { credential: event.credential } : {}),
      credentialName: event.credentialName,
      ...(event.meter ? { meter: event.meter } : {}),
      ...(event.previous ? { previous: event.previous } : {}),
      ...(event.threshold !== undefined ? { threshold: event.threshold } : {}),
      message: event.message,
      occurredAt: event.occurredAt,
    }));
  },
});

/**
 * Complete data of one limit event for a delivery channel: the stored event (with its snapshot
 * at the time), workspace, provider and credential identity, the credential's current snapshot,
 * and the workspace thresholds. `null` when the event no longer exists.
 */
export const exportEvent = internalQuery({
  args: { event: v.id("limit_events") },
  returns: v.union(
    v.null(),
    v.object({
      event: schema.doc("limit_events"),
      workspace: v.object({ _id: v.id("workspaces"), name: v.string(), ownerId: v.string() }),
      provider: v.object({ slug: v.string(), name: v.string() }),
      credential: v.union(
        v.null(),
        v.object({
          _id: v.id("workspace_credentials"),
          name: v.string(),
          enabled: v.boolean(),
          account: v.optional(v.string()),
        }),
      ),
      current: v.union(
        v.null(),
        v.object({
          meters: v.array(meterValidator),
          plan: v.optional(v.string()),
          polledAt: v.optional(v.number()),
          pollError: v.optional(pollErrorValidator),
          expired: v.boolean(),
        }),
      ),
      settings: limitSettingsValidator,
    }),
  ),
  handler: async (ctx, args) => {
    const event = await ctx.db.get("limit_events", args.event);
    if (!event) return null;
    const workspace = await ctx.db.get("workspaces", event.workspace);
    if (!workspace) return null;
    const credential = event.credential
      ? await ctx.db.get("workspace_credentials", event.credential)
      : null;
    const row = credential ? await limitRowFor(ctx, credential._id) : null;
    const settingsRow = await ctx.db
      .query("workspace_settings")
      .withIndex("by_workspace", (q) => q.eq("workspace", workspace._id))
      .first();

    return {
      event,
      workspace: { _id: workspace._id, name: workspace.name, ownerId: workspace.ownerId },
      provider: { slug: event.provider, name: event.providerName },
      credential: credential
        ? {
            _id: credential._id,
            name: credentialDisplayName(credential),
            enabled: isCredentialEnabled(credential),
            ...(credential.account !== undefined ? { account: credential.account } : {}),
          }
        : null,
      current: row
        ? {
            meters: row.meters,
            ...(row.plan !== undefined ? { plan: row.plan } : {}),
            ...(row.polledAt !== undefined ? { polledAt: row.polledAt } : {}),
            ...(row.pollError ? { pollError: row.pollError } : {}),
            expired: row.expiredAt !== undefined,
          }
        : null,
      settings: resolveLimitSettings(settingsRow?.limits),
    };
  },
});

/** Recompute a credential's metered budget; scheduled after its completions are recorded. */
export const refreshBudget = internalMutation({
  args: { credential: v.id("workspace_credentials") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const credential = await ctx.db.get("workspace_credentials", args.credential);
    if (credential) await refreshBudgetMeter(ctx, credential, Date.now());
    return null;
  },
});

/** Remove limit events older than 30 days. Bounded per run. */
export const pruneEvents = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const events = await ctx.db
      .query("limit_events")
      .withIndex("by_occurredAt", (q) => q.lt("occurredAt", Date.now() - EVENT_RETENTION_MS))
      .take(PRUNE_BATCH);
    for (const event of events) await ctx.db.delete("limit_events", event._id);
    return null;
  },
});
