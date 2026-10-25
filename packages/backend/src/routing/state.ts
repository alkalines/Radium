import { v } from "convex/values";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import { internalMutation, type MutationCtx, type QueryCtx } from "../../convex/_generated/server";
import { ownedWorkspaceMutation, ownedWorkspaceQuery } from "../../convex/helpers";
import {
  requireWorkspaceProvider,
  resolveRoutableProviders,
  type RoutableProvider,
} from "../../convex/providers";
import { workspaceProviderRecords } from "../../convex/provider_records";
import { nextCooldown, type FailureDecision } from "./failures";
import {
  applyRoutingPreferences,
  routingPreferencesValidator,
  type ProviderMetrics,
  type RoutingPreferences,
} from "./preferences";
import { highestPriorityTier, pickFromTier, type SelectionCursor } from "./selection";
import {
  assertValidProviderRouting,
  assertValidRoutingSettings,
  cooldownReasonValidator,
  providerRoutingValidator,
  resolveProviderRouting,
  resolveRoutingSettings,
  routingSettingsValidator,
  type CooldownReason,
  type RoutingSettings,
} from "./settings";

const sessionValidator = v.object({
  primary: v.string(),
  fallback: v.optional(v.string()),
  isSubagent: v.boolean(),
});

/** Provider-wide cooldowns use this model key. */
const ALL_MODELS = "";
/** Cooldown reasons that mean the provider cannot serve until the owner or upstream acts. */
const HARD_BLOCK_REASONS: Record<CooldownReason, boolean> = {
  quota: true,
  unauthorized: true,
  payment_required: true,
  not_found: true,
  model_unsupported: true,
  transient: false,
  other: false,
};
const METRIC_SAMPLE_SIZE = 200;
const PRUNE_BATCH = 500;
const COOLDOWN_RETENTION_MS = 24 * 60 * 60 * 1000;

/** Result of one routing decision, consumed by the action's attempt loop. */
export type RoutingPick =
  | { ok: true; provider: RoutableProvider; settings: RoutingSettings }
  | {
      ok: false;
      /** Milliseconds until the soonest cooldown ends; 0 when only already-tried providers remain. */
      retryAfterMs?: number;
      message: string;
      settings: RoutingSettings;
    };

type ActiveBlock = { until: number; reason: CooldownReason };

/**
 * Choose the provider for the next attempt and persist strategy and session-affinity state in
 * the same transaction, so concurrent actions never reuse a stale cursor. `excluded` lists
 * providers already attempted in the current retry round. Configuration errors (unknown model,
 * no credentialed provider, a pinned provider that cannot serve the model) throw.
 */
export const pick = internalMutation({
  args: {
    workspace: v.id("workspaces"),
    model: v.string(),
    preferences: routingPreferencesValidator,
    session: v.optional(sessionValidator),
    excluded: v.array(v.string()),
  },
  handler: async (ctx, args): Promise<RoutingPick> => {
    const workspace = await ctx.db.get("workspaces", args.workspace);
    if (!workspace) throw new Error("Workspace not found.");

    const now = Date.now();
    const settings = await routingSettingsFor(ctx, workspace._id);
    const providers = await resolveRoutableProviders(ctx, workspace, args.model);
    const metrics = args.preferences.sort
      ? await providerMetrics(ctx, workspace._id, args.model, providers, args.preferences.sort)
      : new Map();

    const preferred = applyRoutingPreferences(
      providers.map((provider) => ({
        provider: provider.slug,
        priority: provider.routing.priority,
        weight: provider.routing.weight,
      })),
      args.preferences,
      metrics,
    );
    if (preferred.length === 0)
      throw new Error(noPreferredProviderMessage(args.model, args.preferences));

    const blocks = await activeBlocks(
      ctx,
      workspace._id,
      args.model,
      preferred.map((candidate) => candidate.provider),
      now,
    );
    const isAvailable = (slug: string) => !blocks.has(slug) && !args.excluded.includes(slug);
    let available = preferred.filter((candidate) => isAvailable(candidate.provider));
    if (settings.strategy === "weighted-round-robin") {
      available = available.filter((candidate) => candidate.weight > 0);
    }

    if (available.length === 0) {
      return { ok: false, ...unavailableDetails(preferred, blocks, args.excluded, now), settings };
    }

    const providerBySlug = new Map(providers.map((provider) => [provider.slug, provider]));
    const chosen = (slug: string): RoutingPick => ({
      ok: true,
      provider: providerBySlug.get(slug)!,
      settings,
    });

    const session = settings.sessionAffinity ? args.session : undefined;
    if (!session) {
      return chosen(await pickWithStrategy(ctx, workspace._id, args.model, settings, available));
    }

    const ttlMs = settings.sessionAffinityTtlSeconds * 1000;
    const primaryKey = sessionKey(session.primary, args.model);
    const binding = await liveBinding(ctx, workspace._id, primaryKey, now);

    if (binding) {
      if (available.some((candidate) => candidate.provider === binding.provider)) {
        await ctx.db.patch("routing_sessions", binding._id, { expiresAt: now + ttlMs });
        return chosen(binding.provider);
      }

      // Under `quota`, a transiently unavailable binding fails over for this request only.
      const block = blocks.get(binding.provider);
      const configured = preferred.some((candidate) => candidate.provider === binding.provider);
      const hardBlocked = !configured || (block !== undefined && HARD_BLOCK_REASONS[block.reason]);
      const slug = await pickWithStrategy(ctx, workspace._id, args.model, settings, available);
      if (settings.sessionAffinityRebindOn === "quota" && !hardBlocked) return chosen(slug);

      await ctx.db.patch("routing_sessions", binding._id, {
        provider: slug,
        expiresAt: now + ttlMs,
      });
      return chosen(slug);
    }

    // A previous-turn hash or a parent session may already be bound.
    let slug: string | undefined;
    const inherit = session.fallback && (!session.isSubagent || settings.sessionAffinitySubagents);
    if (inherit) {
      const fallback = await liveBinding(
        ctx,
        workspace._id,
        sessionKey(session.fallback!, args.model),
        now,
      );
      if (fallback && available.some((candidate) => candidate.provider === fallback.provider)) {
        slug = fallback.provider;
      }
    }
    slug ??= await pickWithStrategy(ctx, workspace._id, args.model, settings, available);

    const keys = [primaryKey];
    // Subagents never move or extend the parent binding.
    if (session.fallback && !session.isSubagent)
      keys.push(sessionKey(session.fallback, args.model));
    for (const key of keys) await bindSession(ctx, workspace._id, key, slug, now + ttlMs);
    return chosen(slug);
  },
});

/**
 * Record one attempt outcome. Failures schedule cooldowns (unless cooling is disabled) and
 * drop session bindings per `sessionAffinityRebindOn`. Successes clear cooldowns recorded
 * before the attempt was dispatched, so a slow success cannot erase a newer failure.
 */
export const reportResult = internalMutation({
  args: {
    workspace: v.id("workspaces"),
    provider: v.string(),
    model: v.string(),
    dispatchedAt: v.number(),
    session: v.optional(sessionValidator),
    outcome: v.union(
      v.object({ type: v.literal("success") }),
      v.object({
        type: v.literal("failure"),
        reason: v.optional(cooldownReasonValidator),
        retryAfterMs: v.optional(v.number()),
        credentialScope: v.boolean(),
        forceCooldown: v.boolean(),
        rebindOnQuota: v.boolean(),
        status: v.optional(v.number()),
        message: v.string(),
      }),
    ),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();

    if (args.outcome.type === "success") {
      for (const model of [args.model, ALL_MODELS]) {
        const record = await cooldownRecord(ctx, args.workspace, args.provider, model);
        if (!record || record.recordedAt > args.dispatchedAt) continue;
        // An active provider-wide quota window outlives unrelated successes.
        if (model === ALL_MODELS && record.nextRetryAt > now) continue;
        await ctx.db.delete("routing_cooldowns", record._id);
      }
      return null;
    }

    const outcome = args.outcome;
    const settings = await routingSettingsFor(ctx, args.workspace);
    const configuration = await ctx.db
      .query("workspace_configurations")
      .withIndex("by_workspace_and_provider", (q) =>
        q.eq("workspace", args.workspace).eq("provider", args.provider),
      )
      .first();
    const providerRouting = resolveProviderRouting(configuration?.routing);

    if (settings.sessionAffinity && args.session) {
      const binding = await liveBinding(
        ctx,
        args.workspace,
        sessionKey(args.session.primary, args.model),
        now,
      );
      const rebind = settings.sessionAffinityRebindOn === "any" || outcome.rebindOnQuota;
      if (binding && binding.provider === args.provider && rebind) {
        await ctx.db.delete("routing_sessions", binding._id);
      }
    }

    if (settings.disableCooling || providerRouting.disableCooling || !outcome.reason) return null;

    const providerWide =
      outcome.reason === "unauthorized" ||
      outcome.reason === "payment_required" ||
      (outcome.reason === "quota" && outcome.credentialScope && !providerRouting.modelLevelCooling);
    const model = providerWide ? ALL_MODELS : args.model;
    const existing = await cooldownRecord(ctx, args.workspace, args.provider, model);
    const decision: FailureDecision = {
      reason: outcome.reason,
      retryAfterMs: outcome.retryAfterMs,
      credentialScope: outcome.credentialScope,
      forceCooldown: outcome.forceCooldown,
      rebindOnQuota: outcome.rebindOnQuota,
      action: "continue",
      retryRound: false,
    };
    const window = nextCooldown(existing, decision, settings.transientErrorCooldownSeconds, now);
    if (!window) return null;

    const fields = {
      reason: outcome.reason,
      nextRetryAt: window.nextRetryAt,
      backoffLevel: window.backoffLevel,
      status: outcome.status,
      message: outcome.message,
      recordedAt: now,
    };
    if (existing) await ctx.db.patch("routing_cooldowns", existing._id, fields);
    else {
      await ctx.db.insert("routing_cooldowns", {
        workspace: args.workspace,
        provider: args.provider,
        model,
        ...fields,
      });
    }
    return null;
  },
});

/** Remove expired session bindings and cooldown rows idle for a day. Bounded per run. */
export const prune = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const now = Date.now();
    const sessions = await ctx.db
      .query("routing_sessions")
      .withIndex("by_expiresAt", (q) => q.lt("expiresAt", now))
      .take(PRUNE_BATCH);
    for (const session of sessions) await ctx.db.delete("routing_sessions", session._id);

    const cooldowns = await ctx.db
      .query("routing_cooldowns")
      .withIndex("by_nextRetryAt", (q) => q.lt("nextRetryAt", now - COOLDOWN_RETENTION_MS))
      .take(PRUNE_BATCH);
    for (const cooldown of cooldowns) await ctx.db.delete("routing_cooldowns", cooldown._id);
    return null;
  },
});

const cooldownView = v.object({
  provider: v.string(),
  /** Empty for a provider-wide cooldown. */
  model: v.string(),
  reason: cooldownReasonValidator,
  nextRetryAt: v.number(),
  backoffLevel: v.number(),
  status: v.optional(v.number()),
  message: v.optional(v.string()),
});

/**
 * Owner view of workspace routing: effective settings, per-provider overrides, and cooldown
 * records. Clients compare `nextRetryAt` with their clock to show active cooldowns.
 */
export const getConfiguration = ownedWorkspaceQuery({
  args: {},
  returns: v.object({
    settings: routingSettingsValidator,
    providers: v.array(
      v.object({
        slug: v.string(),
        name: v.string(),
        enabled: v.boolean(),
        hasCredentials: v.boolean(),
        routing: providerRoutingValidator,
      }),
    ),
    cooldowns: v.array(cooldownView),
  }),
  handler: async (ctx) => {
    const workspaceId = ctx.workspace._id;
    const records = await workspaceProviderRecords(ctx, ctx.workspace);
    const credentials = await ctx.db
      .query("workspace_credentials")
      .withIndex("by_workspace_and_provider", (q) => q.eq("workspace", workspaceId))
      .take(200);
    const credentialed = new Set(credentials.map((credential) => credential.provider));
    const cooldowns = await ctx.db
      .query("routing_cooldowns")
      .withIndex("by_workspace_provider_model", (q) => q.eq("workspace", workspaceId))
      .take(500);

    return {
      settings: resolveRoutingSettings(ctx.workspace.settings.routing),
      providers: records.map((record) => ({
        slug: record.provider.slug,
        name: record.provider.name,
        enabled: (record.configuration?.enabled ?? true) && (record.configuration?.active ?? true),
        hasCredentials: credentialed.has(record.provider.slug),
        routing: resolveProviderRouting(record.configuration?.routing),
      })),
      cooldowns: cooldowns.map((cooldown) => ({
        provider: cooldown.provider,
        model: cooldown.model,
        reason: cooldown.reason,
        nextRetryAt: cooldown.nextRetryAt,
        backoffLevel: cooldown.backoffLevel,
        status: cooldown.status,
        message: cooldown.message,
      })),
    };
  },
});

/** Replace the workspace routing settings. Owner only; out-of-range values are rejected. */
export const setSettings = ownedWorkspaceMutation({
  args: { settings: routingSettingsValidator },
  returns: v.null(),
  handler: async (ctx, args) => {
    assertValidRoutingSettings(args.settings);
    await ctx.workspace.updateSettings({ routing: args.settings });
    return null;
  },
});

/** Replace one provider's routing overrides. Owner only; error-rule regexes must compile. */
export const setProviderRouting = ownedWorkspaceMutation({
  args: { provider: v.string(), routing: providerRoutingValidator },
  returns: v.null(),
  handler: async (ctx, args) => {
    assertValidProviderRouting(args.routing);
    const { configuration } = await requireWorkspaceProvider(ctx, ctx.workspace._id, args.provider);
    await ctx.db.patch("workspace_configurations", configuration._id, { routing: args.routing });
    return null;
  },
});

/**
 * Clear cooldowns for a provider (all models when `model` is omitted, provider-wide when it is
 * empty) and reset their backoff. Owner only; mirrors CLIProxyAPI's quota reset.
 */
export const resetCooldown = ownedWorkspaceMutation({
  args: { provider: v.string(), model: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const records = await ctx.db
      .query("routing_cooldowns")
      .withIndex("by_workspace_provider_model", (q) => {
        const scoped = q.eq("workspace", ctx.workspace._id).eq("provider", args.provider);
        return args.model === undefined ? scoped : scoped.eq("model", args.model);
      })
      .take(500);
    for (const record of records) await ctx.db.delete("routing_cooldowns", record._id);
    return null;
  },
});

async function routingSettingsFor(ctx: QueryCtx, workspace: Id<"workspaces">) {
  const row = await ctx.db
    .query("workspace_settings")
    .withIndex("by_workspace", (q) => q.eq("workspace", workspace))
    .first();
  return resolveRoutingSettings(row?.routing);
}

async function cooldownRecord(
  ctx: QueryCtx,
  workspace: Id<"workspaces">,
  provider: string,
  model: string,
) {
  return await ctx.db
    .query("routing_cooldowns")
    .withIndex("by_workspace_provider_model", (q) =>
      q.eq("workspace", workspace).eq("provider", provider).eq("model", model),
    )
    .unique();
}

/** Latest active cooldown per provider, combining provider-wide and model-scoped rows. */
async function activeBlocks(
  ctx: QueryCtx,
  workspace: Id<"workspaces">,
  model: string,
  providers: string[],
  now: number,
) {
  const blocks = new Map<string, ActiveBlock>();
  for (const provider of providers) {
    for (const scope of [ALL_MODELS, model]) {
      const record = await cooldownRecord(ctx, workspace, provider, scope);
      if (!record || record.nextRetryAt <= now) continue;
      const current = blocks.get(provider);
      if (!current || record.nextRetryAt > current.until) {
        blocks.set(provider, { until: record.nextRetryAt, reason: record.reason });
      }
    }
  }
  return blocks;
}

/**
 * Explain why no provider is available. `retryAfterMs` is 0 when an untried-this-round provider
 * would be available again immediately, otherwise the soonest cooldown end.
 */
function unavailableDetails(
  preferred: Array<{ provider: string }>,
  blocks: Map<string, ActiveBlock>,
  excluded: string[],
  now: number,
) {
  const waits = preferred.map((candidate) => {
    const block = blocks.get(candidate.provider);
    return block ? block.until - now : 0;
  });
  const retryAfterMs = Math.min(...waits);
  const allTried = preferred.every(
    (candidate) => excluded.includes(candidate.provider) && !blocks.has(candidate.provider),
  );
  const message = allTried
    ? "Every eligible provider failed for this request."
    : "Every eligible provider is cooling down after upstream failures.";
  return { retryAfterMs, message };
}

function noPreferredProviderMessage(model: string, preferences: RoutingPreferences) {
  if (preferences.only?.length === 1) {
    return `Model ${model} is not available on provider ${preferences.only[0]}.`;
  }
  return `No configured provider for model ${model} matches the request provider preferences.`;
}

async function pickWithStrategy(
  ctx: MutationCtx,
  workspace: Id<"workspaces">,
  model: string,
  settings: RoutingSettings,
  available: Array<{ provider: string; priority: number; weight: number }>,
) {
  const tier = highestPriorityTier(available);
  if (settings.strategy === "fill-first") return tier[0]!.provider;

  const row = await ctx.db
    .query("routing_cursors")
    .withIndex("by_workspace_model", (q) => q.eq("workspace", workspace).eq("model", model))
    .unique();
  const cursor: SelectionCursor = {
    lastProvider: row?.lastProvider,
    weighted: row?.weighted ?? [],
  };
  const result = pickFromTier(settings.strategy, tier, cursor)!;

  const fields = { lastProvider: result.cursor.lastProvider, weighted: result.cursor.weighted };
  if (row) await ctx.db.patch("routing_cursors", row._id, fields);
  else await ctx.db.insert("routing_cursors", { workspace, model, ...fields });
  return result.picked.provider;
}

function sessionKey(session: string, model: string) {
  return `${session}::${model}`;
}

async function liveBinding(
  ctx: QueryCtx,
  workspace: Id<"workspaces">,
  key: string,
  now: number,
): Promise<Doc<"routing_sessions"> | null> {
  const binding = await ctx.db
    .query("routing_sessions")
    .withIndex("by_workspace_key", (q) => q.eq("workspace", workspace).eq("key", key))
    .unique();
  return binding && binding.expiresAt > now ? binding : null;
}

async function bindSession(
  ctx: MutationCtx,
  workspace: Id<"workspaces">,
  key: string,
  provider: string,
  expiresAt: number,
) {
  const existing = await ctx.db
    .query("routing_sessions")
    .withIndex("by_workspace_key", (q) => q.eq("workspace", workspace).eq("key", key))
    .unique();
  if (existing) await ctx.db.patch("routing_sessions", existing._id, { provider, expiresAt });
  else await ctx.db.insert("routing_sessions", { workspace, key, provider, expiresAt });
}

/**
 * Price from the provider's model pricing (input + output per token); throughput (tokens/s)
 * and latency (TTFT ms) averaged over the workspace's recent completions for this model.
 */
async function providerMetrics(
  ctx: QueryCtx,
  workspace: Id<"workspaces">,
  modelSlug: string,
  providers: RoutableProvider[],
  sort: NonNullable<RoutingPreferences["sort"]>,
): Promise<ProviderMetrics> {
  const metrics: ProviderMetrics = new Map();

  if (sort === "price") {
    for (const provider of providers) {
      const price = Number(provider.pricing.input) + Number(provider.pricing.output);
      if (Number.isFinite(price)) metrics.set(provider.slug, { price });
    }
    return metrics;
  }

  const model = await ctx.db
    .query("models")
    .withIndex("by_slug", (q) => q.eq("slug", modelSlug))
    .unique();
  if (!model) return metrics;

  const samples = new Map<string, { throughput: number[]; latency: number[] }>();
  const completions = await ctx.db
    .query("chat_completions")
    .withIndex("by_workspace", (q) => q.eq("bill.workspace", workspace))
    .order("desc")
    .take(METRIC_SAMPLE_SIZE);
  for (const completion of completions) {
    if (completion.request.model !== model._id || completion.request.canceled) continue;
    const entry = samples.get(completion.request.provider) ?? { throughput: [], latency: [] };
    if (completion.response.gen_time > 0) {
      entry.throughput.push(
        completion.response.usage.completion_tokens / (completion.response.gen_time / 1000),
      );
    }
    if (completion.response.ttft > 0) entry.latency.push(completion.response.ttft);
    samples.set(completion.request.provider, entry);
  }

  for (const [provider, entry] of samples) {
    const throughput = entry.throughput.length > 0 ? average(entry.throughput) : undefined;
    const latency = entry.latency.length > 0 ? average(entry.latency) : undefined;
    metrics.set(provider, { throughput, latency });
  }
  return metrics;
}

function average(values: number[]) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
