import { v } from "convex/values";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import { internalMutation, type MutationCtx, type QueryCtx } from "../../convex/_generated/server";
import { ownedWorkspaceMutation, ownedWorkspaceQuery } from "../../convex/helpers";
import {
  requireWorkspaceProvider,
  resolveRoutableProviders,
  type RoutableCredential,
  type RoutableProvider,
  type RoutableTarget,
} from "../../convex/providers";
import { workspaceProviderRecords } from "../../convex/provider_records";
import { nextCooldown, type FailureDecision } from "./failures";
import {
  credentialDisplayName,
  credentialPlacement,
  isCredentialEnabled,
} from "../workspaces/credentials";
import {
  applyRoutingPreferences,
  routingPreferencesValidator,
  type ProviderMetrics,
  type RoutingPreferences,
} from "./preferences";
import {
  highestPriorityTier,
  pickFromTier,
  roundRobinSuccessor,
  smoothWeightedStep,
  type SelectionCursor,
} from "./selection";
import {
  assertValidPlacement,
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

/** One provider credential; `credential` is absent for the provider's legacy credential. */
const targetValidator = v.object({
  provider: v.string(),
  credential: v.optional(v.id("workspace_credentials")),
});

/** Credential-wide cooldowns use this model key. */
const ALL_MODELS = "";
/** Cooldown reasons that mean the credential cannot serve until the owner or upstream acts. */
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
  | { ok: true; provider: RoutableTarget; settings: RoutingSettings }
  | {
      ok: false;
      /** Milliseconds until the soonest cooldown ends; 0 when only already-tried credentials remain. */
      retryAfterMs?: number;
      message: string;
      settings: RoutingSettings;
    };

type ActiveBlock = { until: number; reason: CooldownReason };

/**
 * Choose the provider credential for the next attempt and persist strategy and session-affinity
 * state in the same transaction, so concurrent actions never reuse a stale cursor. The strategy
 * first picks a provider among those with a usable credential, then rotates among that provider's
 * usable credentials. `excluded` lists credentials already attempted in the current retry round.
 * Configuration errors (unknown model, no credentialed provider, a pinned provider that cannot
 * serve the model) throw.
 */
export const pick = internalMutation({
  args: {
    workspace: v.id("workspaces"),
    model: v.string(),
    preferences: routingPreferencesValidator,
    session: v.optional(sessionValidator),
    excluded: v.array(targetValidator),
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

    const providerBySlug = new Map(providers.map((provider) => [provider.slug, provider]));
    const preferredProviders = preferred.map((candidate) =>
      providerBySlug.get(candidate.provider)!,
    );
    const blocks = await activeBlocks(ctx, workspace._id, args.model, preferredProviders, now);
    const excluded = new Set(
      args.excluded.map((target) => targetKey(target.provider, target.credential)),
    );

    // A provider is selectable while any of its credentials is neither cooling nor tried (nor,
    // under weighted round-robin, weighted 0).
    const usable = new Map<string, RoutableCredential[]>();
    for (const provider of preferredProviders) {
      const credentials = provider.credentials.filter((credential) => {
        const key = targetKey(provider.slug, credential.id);
        if (blocks.has(key) || excluded.has(key)) return false;
        return settings.strategy !== "weighted-round-robin" || credential.weight > 0;
      });
      usable.set(provider.slug, credentials);
    }
    let available = preferred.filter((candidate) => usable.get(candidate.provider)!.length > 0);
    if (settings.strategy === "weighted-round-robin") {
      available = available.filter((candidate) => candidate.weight > 0);
    }

    if (available.length === 0) {
      return {
        ok: false,
        ...unavailableDetails(preferredProviders, blocks, excluded, now),
        settings,
      };
    }

    const target = (slug: string, credential: RoutableCredential): RoutingPick => {
      const { credentials: _credentials, ...provider } = providerBySlug.get(slug)!;
      return { ok: true, provider: { ...provider, credential }, settings };
    };
    const pickCredentialOf = async (slug: string) => {
      const credential = await pickCredential(
        ctx,
        workspace._id,
        args.model,
        settings.strategy,
        slug,
        usable.get(slug)!,
      );
      return target(slug, credential);
    };
    const pickNew = async () =>
      pickCredentialOf(await pickWithStrategy(ctx, workspace._id, args.model, settings, available));

    // A binding without a credential predates credential pools (or names a legacy credential);
    // it keeps the provider and lets the strategy choose among its credentials.
    const reuseBinding = async (binding: Doc<"routing_sessions">) => {
      if (!available.some((candidate) => candidate.provider === binding.provider)) return undefined;
      if (binding.credential === undefined) return await pickCredentialOf(binding.provider);
      const credential = usable
        .get(binding.provider)!
        .find((candidate) => candidate.id === binding.credential);
      return credential ? target(binding.provider, credential) : undefined;
    };

    const session = settings.sessionAffinity ? args.session : undefined;
    if (!session) return await pickNew();

    const ttlMs = settings.sessionAffinityTtlSeconds * 1000;
    const primaryKey = sessionKey(session.primary, args.model);
    const binding = await liveBinding(ctx, workspace._id, primaryKey, now);

    if (binding) {
      const reused = await reuseBinding(binding);
      if (reused?.ok) {
        await ctx.db.patch("routing_sessions", binding._id, {
          credential: reused.provider.credential.id,
          expiresAt: now + ttlMs,
        });
        return reused;
      }

      // Under `quota`, a transiently unavailable binding fails over for this request only.
      const block = blocks.get(targetKey(binding.provider, binding.credential));
      const boundProvider = preferredProviders.find(
        (provider) => provider.slug === binding.provider,
      );
      const configured =
        boundProvider !== undefined &&
        (binding.credential === undefined ||
          boundProvider.credentials.some((credential) => credential.id === binding.credential));
      const hardBlocked = !configured || (block !== undefined && HARD_BLOCK_REASONS[block.reason]);
      const picked = await pickNew();
      if (settings.sessionAffinityRebindOn === "quota" && !hardBlocked) return picked;

      if (picked.ok) {
        await ctx.db.patch("routing_sessions", binding._id, {
          provider: picked.provider.slug,
          credential: picked.provider.credential.id,
          expiresAt: now + ttlMs,
        });
      }
      return picked;
    }

    // A previous-turn hash or a parent session may already be bound.
    let picked: RoutingPick | undefined;
    const inherit = session.fallback && (!session.isSubagent || settings.sessionAffinitySubagents);
    if (inherit) {
      const fallback = await liveBinding(
        ctx,
        workspace._id,
        sessionKey(session.fallback!, args.model),
        now,
      );
      if (fallback) picked = await reuseBinding(fallback);
    }
    picked ??= await pickNew();
    if (!picked.ok) return picked;

    const keys = [primaryKey];
    // Subagents never move or extend the parent binding.
    if (session.fallback && !session.isSubagent)
      keys.push(sessionKey(session.fallback, args.model));
    for (const key of keys) {
      await bindSession(ctx, workspace._id, key, picked.provider, now + ttlMs);
    }
    return picked;
  },
});

/**
 * Record one attempt outcome for a provider credential. Failures schedule cooldowns (unless
 * cooling is disabled) and drop session bindings per `sessionAffinityRebindOn`. Successes clear
 * cooldowns recorded before the attempt was dispatched, so a slow success cannot erase a newer
 * failure.
 */
export const reportResult = internalMutation({
  args: {
    workspace: v.id("workspaces"),
    provider: v.string(),
    credential: v.optional(v.id("workspace_credentials")),
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
        const record = await cooldownRecord(ctx, args.workspace, args, model);
        if (!record || record.recordedAt > args.dispatchedAt) continue;
        // An active credential-wide quota window outlives unrelated successes.
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
      const boundHere =
        binding !== null &&
        binding.provider === args.provider &&
        binding.credential === args.credential;
      if (boundHere && rebind) {
        await ctx.db.delete("routing_sessions", binding._id);
      }
    }

    if (settings.disableCooling || providerRouting.disableCooling || !outcome.reason) return null;

    const credentialWide =
      outcome.reason === "unauthorized" ||
      outcome.reason === "payment_required" ||
      (outcome.reason === "quota" && outcome.credentialScope && !providerRouting.modelLevelCooling);
    const model = credentialWide ? ALL_MODELS : args.model;
    const existing = await cooldownRecord(ctx, args.workspace, args, model);
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
        credential: args.credential,
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
  _id: v.id("routing_cooldowns"),
  provider: v.string(),
  /** Absent for the provider's legacy credential. */
  credential: v.optional(v.id("workspace_credentials")),
  credentialName: v.optional(v.string()),
  /** Empty for a credential-wide cooldown. */
  model: v.string(),
  reason: cooldownReasonValidator,
  nextRetryAt: v.number(),
  backoffLevel: v.number(),
  status: v.optional(v.number()),
  message: v.optional(v.string()),
});

/**
 * Owner view of workspace routing: effective settings, per-provider overrides with each
 * provider's credentials (creation order, effective priority and weight), and cooldown records.
 * Clients compare `nextRetryAt` with their clock to show active cooldowns. Legacy credentials
 * without a row are not listed; they route with the defaults.
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
        credentials: v.array(
          v.object({
            _id: v.id("workspace_credentials"),
            name: v.string(),
            enabled: v.boolean(),
            priority: v.number(),
            weight: v.number(),
          }),
        ),
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
      .take(1000);
    const credentialById = new Map(credentials.map((credential) => [credential._id, credential]));
    const cooldowns = await ctx.db
      .query("routing_cooldowns")
      .withIndex("by_workspace_provider_credential_model", (q) => q.eq("workspace", workspaceId))
      .take(500);

    return {
      settings: resolveRoutingSettings(ctx.workspace.settings.routing),
      providers: records.map((record) => ({
        slug: record.provider.slug,
        name: record.provider.name,
        enabled: (record.configuration?.enabled ?? true) && (record.configuration?.active ?? true),
        credentials: credentials
          .filter((credential) => credential.provider === record.provider.slug)
          .map((credential) => ({
            _id: credential._id,
            name: credentialDisplayName(credential),
            enabled: isCredentialEnabled(credential),
            ...credentialPlacement(credential),
          })),
        routing: resolveProviderRouting(record.configuration?.routing),
      })),
      cooldowns: cooldowns.map((cooldown) => {
        const credential = cooldown.credential && credentialById.get(cooldown.credential);
        return {
          _id: cooldown._id,
          provider: cooldown.provider,
          credential: cooldown.credential,
          credentialName: credential ? credentialDisplayName(credential) : undefined,
          model: cooldown.model,
          reason: cooldown.reason,
          nextRetryAt: cooldown.nextRetryAt,
          backoffLevel: cooldown.backoffLevel,
          status: cooldown.status,
          message: cooldown.message,
        };
      }),
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

/**
 * Replace one provider's routing overrides and, optionally, the priority and weight of some of
 * its credentials, in one transaction. Owner only; error-rule regexes must compile, placements
 * must be in range, and every credential must belong to this workspace provider.
 */
export const setProviderRouting = ownedWorkspaceMutation({
  args: {
    provider: v.string(),
    routing: providerRoutingValidator,
    credentials: v.optional(
      v.array(
        v.object({
          credential: v.id("workspace_credentials"),
          priority: v.number(),
          weight: v.number(),
        }),
      ),
    ),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    assertValidProviderRouting(args.routing);
    const { configuration } = await requireWorkspaceProvider(ctx, ctx.workspace._id, args.provider);

    for (const placement of args.credentials ?? []) {
      assertValidPlacement(placement);
      const credential = await ctx.db.get("workspace_credentials", placement.credential);
      if (credential?.workspace !== ctx.workspace._id || credential.provider !== args.provider) {
        throw new Error("Credential not found.");
      }
      await ctx.db.patch("workspace_credentials", credential._id, {
        priority: placement.priority,
        weight: placement.weight,
      });
    }

    await ctx.db.patch("workspace_configurations", configuration._id, { routing: args.routing });
    return null;
  },
});

/**
 * Clear one cooldown row, or every cooldown of a provider (all credentials and models) when
 * `cooldown` is omitted, resetting their backoff. Owner only; mirrors CLIProxyAPI's quota reset.
 */
export const resetCooldown = ownedWorkspaceMutation({
  args: { provider: v.string(), cooldown: v.optional(v.id("routing_cooldowns")) },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (args.cooldown !== undefined) {
      const record = await ctx.db.get("routing_cooldowns", args.cooldown);
      if (record?.workspace === ctx.workspace._id && record.provider === args.provider) {
        await ctx.db.delete("routing_cooldowns", record._id);
      }
      return null;
    }

    const records = await ctx.db
      .query("routing_cooldowns")
      .withIndex("by_workspace_provider_credential_model", (q) =>
        q.eq("workspace", ctx.workspace._id).eq("provider", args.provider),
      )
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

/** Identity of one provider credential within a pick; legacy credentials use an empty suffix. */
function targetKey(provider: string, credential: Id<"workspace_credentials"> | undefined) {
  return `${provider}/${credential ?? ""}`;
}

async function cooldownRecord(
  ctx: QueryCtx,
  workspace: Id<"workspaces">,
  target: { provider: string; credential?: Id<"workspace_credentials"> },
  model: string,
) {
  return await ctx.db
    .query("routing_cooldowns")
    .withIndex("by_workspace_provider_credential_model", (q) =>
      q
        .eq("workspace", workspace)
        .eq("provider", target.provider)
        .eq("credential", target.credential)
        .eq("model", model),
    )
    .unique();
}

/** Latest active cooldown per credential (keyed by {@link targetKey}), across both scopes. */
async function activeBlocks(
  ctx: QueryCtx,
  workspace: Id<"workspaces">,
  model: string,
  providers: RoutableProvider[],
  now: number,
) {
  const blocks = new Map<string, ActiveBlock>();
  for (const provider of providers) {
    for (const credential of provider.credentials) {
      const target = { provider: provider.slug, credential: credential.id };
      const key = targetKey(provider.slug, credential.id);
      for (const scope of [ALL_MODELS, model]) {
        const record = await cooldownRecord(ctx, workspace, target, scope);
        if (!record || record.nextRetryAt <= now) continue;
        const current = blocks.get(key);
        if (!current || record.nextRetryAt > current.until) {
          blocks.set(key, { until: record.nextRetryAt, reason: record.reason });
        }
      }
    }
  }
  return blocks;
}

/**
 * Explain why no credential is available. `retryAfterMs` is 0 when an untried-this-round
 * credential would be available again immediately, otherwise the soonest cooldown end.
 */
function unavailableDetails(
  providers: RoutableProvider[],
  blocks: Map<string, ActiveBlock>,
  excluded: Set<string>,
  now: number,
) {
  const waits: number[] = [];
  let allTried = true;
  for (const provider of providers) {
    for (const credential of provider.credentials) {
      const key = targetKey(provider.slug, credential.id);
      const block = blocks.get(key);
      waits.push(block ? block.until - now : 0);
      if (block || !excluded.has(key)) allTried = false;
    }
  }

  const message = allTried
    ? "Every eligible provider failed for this request."
    : "Every eligible provider is cooling down after upstream failures.";
  return { retryAfterMs: Math.min(...waits), message };
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

/**
 * Choose among a provider's usable credentials, mirroring provider selection one level down:
 * only the highest credential priority tier is considered; inside it fill-first takes the first
 * in creation order, round-robin rotates by credential ID, and weighted round-robin runs smooth
 * WRR on credential weights. Rotation state lives per provider in the workspace+model cursor.
 */
async function pickCredential(
  ctx: MutationCtx,
  workspace: Id<"workspaces">,
  model: string,
  strategy: RoutingSettings["strategy"],
  provider: string,
  credentials: RoutableCredential[],
) {
  const top = Math.max(...credentials.map((credential) => credential.priority));
  const tier = credentials.filter((credential) => credential.priority === top);
  if (strategy === "fill-first" || tier.length === 1) return tier[0]!;

  const row = await ctx.db
    .query("routing_cursors")
    .withIndex("by_workspace_model", (q) => q.eq("workspace", workspace).eq("model", model))
    .unique();
  const cursors = row?.credentialCursors ?? [];
  const cursor = cursors.find((entry) => entry.provider === provider) ?? { provider, credits: [] };
  // The legacy credential is keyed (and sorts) as "".
  const key = (credential: RoutableCredential) => credential.id ?? "";

  let picked: RoutableCredential;
  let next: typeof cursor;
  if (strategy === "weighted-round-robin") {
    const result = smoothWeightedStep(tier, key, cursor.credits);
    picked = result.picked;
    next = { ...cursor, credits: result.credits };
  } else {
    const ordered = [...tier].sort((left, right) => (key(left) < key(right) ? -1 : 1));
    picked = roundRobinSuccessor(ordered, key, cursor.last)!;
    next = { ...cursor, last: key(picked) };
  }

  const fields = {
    credentialCursors: [...cursors.filter((entry) => entry.provider !== provider), next],
  };
  if (row) await ctx.db.patch("routing_cursors", row._id, fields);
  else await ctx.db.insert("routing_cursors", { workspace, model, weighted: [], ...fields });
  return picked;
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
  target: RoutableTarget,
  expiresAt: number,
) {
  const fields = { provider: target.slug, credential: target.credential.id, expiresAt };
  const existing = await ctx.db
    .query("routing_sessions")
    .withIndex("by_workspace_key", (q) => q.eq("workspace", workspace).eq("key", key))
    .unique();
  if (existing) await ctx.db.patch("routing_sessions", existing._id, fields);
  else await ctx.db.insert("routing_sessions", { workspace, key, ...fields });
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
