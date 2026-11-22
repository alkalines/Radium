import { setTimeout } from "node:timers/promises";
import { and, eq, inArray } from "drizzle-orm";
import {
  assertValidPlacement,
  assertValidProviderRouting,
  assertValidRoutingSettings,
  resolveProviderRouting,
  resolveRoutingSettings,
  type CooldownReason,
  type ProviderRouting,
  type RoutingSettings,
} from "contracts/routing/settings";
import type { Database, Kv } from "../../drivers/types";
import { AppError, assertValid } from "../../errors";
import { kvHashDelete, kvHashGet, kvHashGetAll, kvRun, kvScript } from "../../kv";
import type { Runtime } from "../../runtime";
import { recentModelSamples } from "../../usage/completions";
import { readWorkspaceSettings, updateWorkspaceSettings } from "../../workspaces/settings";
import { credentialDisplayName } from "../credentials";
import { recordAttemptLimits } from "../limits/store";
import type { LimitObservation } from "contracts/limits/meters";
import {
  isWorkspaceProviderEnabled,
  requireWorkspaceProvider,
  resolveRoutableProviders,
  workspaceProviderRecord,
  workspaceProviderRecords,
  type RoutableCredential,
  RoutingConfigurationError,
  type RoutableProvider,
  type RoutableTarget,
} from "../providers";
import { workspaceCredentials, workspaceProviders } from "../schema";
import { nextCooldown, type FailureDecision } from "./failures";
import {
  applyRoutingPreferences,
  type ProviderMetrics,
  type RoutingPreferences,
} from "./preferences";
import {
  highestPriorityTier,
  pickFromTier,
  providersForServiceTier,
  roundRobinSuccessor,
  smoothWeightedStep,
  type SelectionCursor,
  type SmoothCredit,
} from "./selection";
import type { RoutingSession } from "./session";

/*
 * Routing state lives in Valkey (`docs/Backend_Migration/Live_Data.md`): losing it resets
 * fairness, cooldowns and affinity, nothing else. Three hashes per workspace:
 *
 * - `routing:cursor:<workspace>:<model>`: `providers` holds the provider cursor
 *   ({@link SelectionCursor}), `credentials:<provider>` each provider's credential cursor. The key
 *   expires a day after its last pick.
 * - `routing:cooldowns:<workspace>`: one field per `[provider, credential, model]` (JSON array;
 *   model `""` is credential-wide), expiring a day after the cooldown ends (the Convex prune).
 * - `routing:sessions:<workspace>`: one field per session key, the bound provider credential,
 *   expiring after the sliding affinity TTL.
 *
 * Every read-modify-write goes through {@link updateField}: a compare-and-set script retried
 * on conflict, so concurrent requests never reuse a stale cursor or lose a backoff step, which
 * Convex guaranteed by serializing mutations.
 */

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
const DAY_MS = 24 * 60 * 60 * 1000;
/** Cursors reset after a day without picks. */
const CURSOR_TTL_MS = DAY_MS;
/** A cooldown is kept (for backoff escalation and the owner view) a day after it ends. */
const COOLDOWN_RETENTION_MS = DAY_MS;
/** Compare-and-set attempts before a write gives up under contention. */
const MAX_CAS_ATTEMPTS = 32;
/** Upper bound of the jittered wait between compare-and-set retries. */
const CAS_BACKOFF_MAX_MS = 25;
/** Cooldowns listed in the owner view. */
const MAX_LISTED_COOLDOWNS = 500;

const cursorKey = (workspace: string, model: string) => `routing:cursor:${workspace}:${model}`;
const cooldownsKey = (workspace: string) => `routing:cooldowns:${workspace}`;
const sessionsKey = (workspace: string) => `routing:sessions:${workspace}`;

/** Field of one cooldown: unambiguous although slugs and models contain `/` and `:`. */
function cooldownField(provider: string, credential: string, model: string) {
  return JSON.stringify([provider, credential, model]);
}

function parseCooldownField(field: string): [provider: string, credential: string, model: string] | null {
  try {
    const parsed = JSON.parse(field) as unknown;
    return Array.isArray(parsed) && parsed.length === 3 && parsed.every((part) => typeof part === "string")
      ? (parsed as [string, string, string])
      : null;
  } catch {
    return null;
  }
}

/** One stored cooldown window. Times are ms epochs. */
type Cooldown = {
  reason: CooldownReason;
  nextRetryAt: number;
  backoffLevel: number;
  status?: number;
  message?: string;
  /** When the failure was recorded; a success dispatched later clears it. */
  recordedAt: number;
};

/** The provider credential a session key is bound to. */
type Binding = { provider: string; credential: string };

/** Credential cursor of one provider inside a workspace+model cursor. */
type CredentialCursor = { last?: string; credits: SmoothCredit[] };

/**
 * Compare-and-set one hash field: applies the new value (empty deletes) only when the field
 * still holds `expected` (`""` absent, `*` anything). Sets the field TTL and the key TTL when
 * given (0 skips).
 */
const casField = kvScript(`
local current = redis.call('HGET', KEYS[1], ARGV[1])
local expected = ARGV[2]
if expected ~= '*' then
  if expected == '' then
    if current then return 0 end
  elseif current ~= expected then
    return 0
  end
end
if ARGV[3] == '' then
  redis.call('HDEL', KEYS[1], ARGV[1])
else
  redis.call('HSET', KEYS[1], ARGV[1], ARGV[3])
  local fieldTtl = tonumber(ARGV[4])
  if fieldTtl > 0 then redis.call('HPEXPIRE', KEYS[1], fieldTtl, 'FIELDS', 1, ARGV[1]) end
end
local keyTtl = tonumber(ARGV[5])
if keyTtl > 0 then redis.call('PEXPIRE', KEYS[1], keyTtl) end
return 1
`);

/** A field change: `null` deletes; `undefined` from the updater leaves the field as it is. */
type FieldChange<T> = { value: T | null; fieldTtlMs?: number; keyTtlMs?: number };

/**
 * Reads, updates and writes one JSON hash field atomically: the write applies only if the field
 * did not change since the read, otherwise the update runs again on the new value.
 *
 * @returns the value now stored (the current one when the updater made no change).
 */
async function updateField<T>(
  kv: Kv,
  key: string,
  field: string,
  update: (current: T | null) => FieldChange<T> | undefined,
): Promise<T | null> {
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
    const [raw] = await kvHashGet(kv, key, [field]);
    const current = raw ? (JSON.parse(raw) as T) : null;
    const change = update(current);
    if (change === undefined) return current;
    const applied = await kvRun(
      kv,
      casField,
      [key],
      [
        field,
        raw ?? "",
        change.value === null ? "" : JSON.stringify(change.value),
        String(Math.max(0, Math.ceil(change.fieldTtlMs ?? 0))),
        String(Math.max(0, Math.ceil(change.keyTtlMs ?? 0))),
      ],
    );
    if (Number(applied) === 1) return change.value;
    // Lost the race: back off with jitter so a burst of picks on one cursor spreads out.
    await setTimeout(Math.random() * Math.min(2 ** attempt, CAS_BACKOFF_MAX_MS));
  }
  throw new Error("Routing state is busy.");
}

/** Sets one JSON hash field unconditionally, with its TTL, in one atomic step. */
async function setField(kv: Kv, key: string, field: string, value: unknown, fieldTtlMs: number) {
  await kvRun(kv, casField, [key], [field, "*", JSON.stringify(value), String(Math.ceil(fieldTtlMs)), "0"]);
}

async function readField<T>(kv: Kv, key: string, field: string): Promise<{ raw: string; value: T } | null> {
  const [raw] = await kvHashGet(kv, key, [field]);
  return raw ? { raw, value: JSON.parse(raw) as T } : null;
}

/** Deletes one field only while it still holds `raw` (another writer may have replaced it). */
async function deleteFieldIf(kv: Kv, key: string, field: string, raw: string) {
  await kvRun(kv, casField, [key], [field, raw, "", "0", "0"]);
}

/** The workspace's effective routing settings. */
export async function routingSettingsFor(db: Database, workspace: string) {
  const row = await readWorkspaceSettings(db, workspace);
  return resolveRoutingSettings((row?.routing as RoutingSettings | null) ?? undefined);
}

/** Normalized service tier of a request (`fast` is `priority`, `auto` is none). */
function requestTier(serviceTier: string | undefined) {
  if (!serviceTier || serviceTier === "auto") return undefined;
  return serviceTier === "fast" ? "priority" : serviceTier;
}

function sessionField(session: string, model: string, tier: string | undefined) {
  return `${session}::${model}:${tier ?? "auto"}`;
}

/** Identity of one provider credential within a pick. */
function targetKey(provider: string, credential: string) {
  return `${provider}/${credential}`;
}

/** Result of one routing decision, consumed by the attempt loop. */
export type RoutingPick =
  | { ok: true; provider: RoutableTarget; settings: RoutingSettings }
  | {
      ok: false;
      status?: number;
      /** Milliseconds until the soonest cooldown ends; 0 when only already-tried credentials remain. */
      retryAfterMs?: number;
      message: string;
      settings: RoutingSettings;
    };

/** One routing decision's inputs. */
export type PickRequest = {
  workspace: string;
  model: string;
  serviceTier?: string;
  inferenceMode?: string;
  preferences: RoutingPreferences;
  session?: RoutingSession;
  /** Credentials already attempted in the current retry round. */
  excluded: Array<{ provider: string; credential: string }>;
};

type ActiveBlock = { until: number; reason: CooldownReason };

/**
 * Chooses the provider credential for the next attempt and advances strategy and
 * session-affinity state atomically, so concurrent requests never reuse a stale cursor. The
 * strategy first picks a provider among those with a usable credential, then rotates among that
 * provider's usable credentials. Configuration errors (unknown model, no credentialed provider,
 * a pinned provider that cannot serve the model) throw `RoutingConfigurationError`.
 */
export async function pickRoute(
  runtime: Pick<Runtime, "drivers" | "secrets">,
  request: PickRequest,
): Promise<RoutingPick> {
  const { db, kv } = runtime.drivers;
  const now = Date.now();
  const settings = await routingSettingsFor(db, request.workspace);
  const tier = requestTier(request.serviceTier);
  const providers = providersForServiceTier(
    await resolveRoutableProviders(db, runtime, request.workspace, request.model),
    tier,
    request.inferenceMode,
  ).filter(
    (provider) =>
      (!provider.inferenceMode?.provider_body.reasoning ||
        provider.npm === "@ai-sdk/openai" ||
        provider.npm === "@opencoredev/loginwithchatgpt-ai") &&
      (!provider.inferenceMode?.provider_body.speed || provider.npm === "@ai-sdk/anthropic") &&
      (!provider.inferenceMode?.provider_headers || provider.npm === "@ai-sdk/anthropic"),
  );
  if ((tier || request.inferenceMode) && providers.length === 0) {
    return {
      ok: false,
      status: 400,
      message: `No provider supports the requested inference mode or service tier for ${request.model}.`,
      settings,
    };
  }
  const metrics = request.preferences.sort
    ? await providerMetrics(db, request, providers, request.preferences.sort, tier)
    : new Map();

  const preferred = applyRoutingPreferences(
    providers.map((provider) => ({
      provider: provider.slug,
      priority: provider.routing.priority,
      weight: provider.routing.weight,
    })),
    request.preferences,
    metrics,
  );
  if (preferred.length === 0) {
    throw new RoutingConfigurationError(
      request.preferences.only?.length === 1
        ? `Model ${request.model} is not available on provider ${request.preferences.only[0]}.`
        : `No configured provider for model ${request.model} matches the request provider preferences.`,
    );
  }

  const providerBySlug = new Map(providers.map((provider) => [provider.slug, provider]));
  const preferredProviders = preferred.map((candidate) => providerBySlug.get(candidate.provider)!);
  const blocks = await activeBlocks(kv, request.workspace, request.model, preferredProviders, now);
  const excluded = new Set(
    request.excluded.map((target) => targetKey(target.provider, target.credential)),
  );

  // A provider is selectable while any of its credentials is neither cooling nor tried (nor,
  // under weighted round-robin, weighted 0).
  const usable = new Map<string, RoutableCredential[]>();
  for (const provider of preferredProviders) {
    usable.set(
      provider.slug,
      provider.credentials.filter((credential) => {
        const key = targetKey(provider.slug, credential.id);
        if (blocks.has(key) || excluded.has(key)) return false;
        return settings.strategy !== "weighted-round-robin" || credential.weight > 0;
      }),
    );
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
  const pickCredentialOf = async (slug: string) =>
    target(
      slug,
      await pickCredential(kv, request, settings.strategy, slug, usable.get(slug)!),
    );
  const pickNew = async () =>
    pickCredentialOf(await pickProvider(kv, request, settings, available));
  const reuseBinding = async (binding: Binding) => {
    if (!highestPriorityTier(available).some((candidate) => candidate.provider === binding.provider)) {
      return undefined;
    }
    const credential = usable
      .get(binding.provider)!
      .find((candidate) => candidate.id === binding.credential);
    return credential ? target(binding.provider, credential) : undefined;
  };

  const session = settings.sessionAffinity ? request.session : undefined;
  if (!session) return await pickNew();

  const ttlMs = settings.sessionAffinityTtlSeconds * 1000;
  const sessions = sessionsKey(request.workspace);
  const primaryField = sessionField(session.primary, request.model, tier);
  const binding = await readField<Binding>(kv, sessions, primaryField);

  if (binding) {
    const reused = await reuseBinding(binding.value);
    if (reused?.ok) {
      await setField(
        kv,
        sessions,
        primaryField,
        { provider: reused.provider.slug, credential: reused.provider.credential.id },
        ttlMs,
      );
      return reused;
    }

    // Under `quota`, a transiently unavailable binding fails over for this request only.
    const block = blocks.get(targetKey(binding.value.provider, binding.value.credential));
    const boundProvider = preferredProviders.find(
      (provider) => provider.slug === binding.value.provider,
    );
    const configured =
      boundProvider !== undefined &&
      boundProvider.credentials.some((credential) => credential.id === binding.value.credential);
    const hardBlocked = !configured || (block !== undefined && HARD_BLOCK_REASONS[block.reason]);
    const picked = await pickNew();
    if (settings.sessionAffinityRebindOn === "quota" && !hardBlocked) return picked;
    if (picked.ok) {
      await setField(
        kv,
        sessions,
        primaryField,
        { provider: picked.provider.slug, credential: picked.provider.credential.id },
        ttlMs,
      );
    }
    return picked;
  }

  // A previous-turn hash or a parent session may already be bound.
  let picked: RoutingPick | undefined;
  const fallbackField = session.fallback
    ? sessionField(session.fallback, request.model, tier)
    : undefined;
  if (fallbackField && (!session.isSubagent || settings.sessionAffinitySubagents)) {
    const fallback = await readField<Binding>(kv, sessions, fallbackField);
    if (fallback) picked = await reuseBinding(fallback.value);
  }
  picked ??= await pickNew();
  if (!picked.ok) return picked;

  const bound = { provider: picked.provider.slug, credential: picked.provider.credential.id };
  await setField(kv, sessions, primaryField, bound, ttlMs);
  // Subagents never move or extend the parent binding.
  if (fallbackField && !session.isSubagent) await setField(kv, sessions, fallbackField, bound, ttlMs);
  return picked;
}

/** Latest active cooldown per credential (keyed by {@link targetKey}), across both scopes. */
async function activeBlocks(
  kv: Kv,
  workspace: string,
  model: string,
  providers: RoutableProvider[],
  now: number,
) {
  const targets = providers.flatMap((provider) =>
    provider.credentials.flatMap((credential) =>
      [ALL_MODELS, model].map((scope) => ({ provider: provider.slug, credential: credential.id, scope })),
    ),
  );
  const values = await kvHashGet(
    kv,
    cooldownsKey(workspace),
    targets.map((target) => cooldownField(target.provider, target.credential, target.scope)),
  );
  const blocks = new Map<string, ActiveBlock>();
  targets.forEach((target, index) => {
    const raw = values[index];
    if (!raw) return;
    const record = JSON.parse(raw) as Cooldown;
    if (record.nextRetryAt <= now) return;
    const key = targetKey(target.provider, target.credential);
    const current = blocks.get(key);
    if (!current || record.nextRetryAt > current.until) {
      blocks.set(key, { until: record.nextRetryAt, reason: record.reason });
    }
  });
  return blocks;
}

/**
 * Why no credential is available. `retryAfterMs` is 0 when an untried-this-round credential
 * would be available again immediately, otherwise the soonest cooldown end.
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

/** Picks a provider from the highest available tier, advancing the shared provider cursor. */
async function pickProvider(
  kv: Kv,
  request: PickRequest,
  settings: RoutingSettings,
  available: Array<{ provider: string; priority: number; weight: number }>,
) {
  const tier = highestPriorityTier(available);
  if (settings.strategy === "fill-first") return tier[0]!.provider;

  let picked: string | undefined;
  await updateField<SelectionCursor>(
    kv,
    cursorKey(request.workspace, request.model),
    "providers",
    (current) => {
      const result = pickFromTier(settings.strategy, tier, current ?? { weighted: [] })!;
      picked = result.picked.provider;
      return { value: result.cursor, keyTtlMs: CURSOR_TTL_MS };
    },
  );
  return picked!;
}

/**
 * Chooses among a provider's usable credentials, mirroring provider selection one level down:
 * only the highest credential priority tier is considered; inside it fill-first takes the first
 * in creation order, round-robin rotates by credential id, and weighted round-robin runs smooth
 * WRR on credential weights. Rotation state lives per provider in the workspace+model cursor.
 */
async function pickCredential(
  kv: Kv,
  request: PickRequest,
  strategy: RoutingSettings["strategy"],
  provider: string,
  credentials: RoutableCredential[],
) {
  const top = Math.max(...credentials.map((credential) => credential.priority));
  const tier = credentials.filter((credential) => credential.priority === top);
  if (strategy === "fill-first" || tier.length === 1) return tier[0]!;

  let picked: RoutableCredential | undefined;
  await updateField<CredentialCursor>(
    kv,
    cursorKey(request.workspace, request.model),
    `credentials:${provider}`,
    (current) => {
      const cursor = current ?? { credits: [] };
      if (strategy === "weighted-round-robin") {
        const result = smoothWeightedStep(tier, (credential) => credential.id, cursor.credits);
        picked = result.picked;
        return { value: { ...cursor, credits: result.credits }, keyTtlMs: CURSOR_TTL_MS };
      }
      const ordered = [...tier].sort((left, right) => (left.id < right.id ? -1 : 1));
      picked = roundRobinSuccessor(ordered, (credential) => credential.id, cursor.last)!;
      return { value: { ...cursor, last: picked.id }, keyTtlMs: CURSOR_TTL_MS };
    },
  );
  return picked!;
}

/**
 * Price from the provider's quote (input + output per token); throughput (tokens/s) and latency
 * (TTFT ms) averaged over the workspace's recent completions of the model.
 */
async function providerMetrics(
  db: Database,
  request: PickRequest,
  providers: Array<RoutableProvider & { quote?: RoutableProvider["pricing"] }>,
  sort: NonNullable<RoutingPreferences["sort"]>,
  tier: string | undefined,
): Promise<ProviderMetrics> {
  const metrics: ProviderMetrics = new Map();
  if (sort === "price") {
    for (const provider of providers) {
      if (!provider.quote?.input.trim() || !provider.quote.output.trim()) continue;
      const input = Number(provider.quote.input);
      const output = Number(provider.quote.output);
      if (Number.isFinite(input) && input >= 0 && Number.isFinite(output) && output >= 0) {
        metrics.set(provider.slug, { price: input + output });
      }
    }
    return metrics;
  }

  const samples = new Map<string, { throughput: number[]; latency: number[] }>();
  for (const completion of await recentModelSamples(db, request.workspace, request.model)) {
    if (completion.canceled) continue;
    if ((completion.requestedServiceTier ?? "auto") !== (tier ?? "auto")) continue;
    if ((completion.inferenceMode ?? undefined) !== request.inferenceMode) continue;
    const entry = samples.get(completion.provider) ?? { throughput: [], latency: [] };
    if (completion.genTime > 0) {
      entry.throughput.push(completion.completionTokens / (completion.genTime / 1000));
    }
    if (completion.ttft > 0) entry.latency.push(completion.ttft);
    samples.set(completion.provider, entry);
  }
  const average = (values: number[]) =>
    values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : undefined;
  for (const [provider, entry] of samples) {
    metrics.set(provider, { throughput: average(entry.throughput), latency: average(entry.latency) });
  }
  return metrics;
}

/** Outcome of one attempt as routing records it. */
export type AttemptOutcomeReport =
  | { type: "success" }
  | {
      type: "failure";
      reason?: CooldownReason;
      retryAfterMs?: number;
      credentialScope: boolean;
      forceCooldown: boolean;
      rebindOnQuota: boolean;
      status?: number;
      message: string;
    };

/**
 * Records one attempt outcome for a provider credential. Failures schedule cooldowns (unless
 * cooling is disabled) and drop the session binding per `sessionAffinityRebindOn`. Successes
 * clear cooldowns recorded before the attempt was dispatched, so a slow success cannot erase a
 * newer failure. Usage-limit meters captured from the upstream response go to the credential's
 * limit snapshot; they never affect routing.
 */
export async function reportAttempt(
  runtime: Runtime,
  report: {
    workspace: string;
    provider: string;
    credential: string;
    model: string;
    serviceTier?: string;
    dispatchedAt: number;
    session?: RoutingSession;
    outcome: AttemptOutcomeReport;
    limits?: LimitObservation;
  },
) {
  const { db, kv } = runtime.drivers;
  const now = Date.now();
  await recordAttemptLimits(runtime, {
    credential: report.credential,
    observation: report.limits,
    outcome:
      report.outcome.type === "success"
        ? { type: "success" }
        : { type: "failure", status: report.outcome.status, message: report.outcome.message },
  });

  const cooldowns = cooldownsKey(report.workspace);
  if (report.outcome.type === "success") {
    for (const model of [report.model, ALL_MODELS]) {
      const field = cooldownField(report.provider, report.credential, model);
      const record = await readField<Cooldown>(kv, cooldowns, field);
      if (!record || record.value.recordedAt > report.dispatchedAt) continue;
      // An active credential-wide quota window outlives unrelated successes.
      if (model === ALL_MODELS && record.value.nextRetryAt > now) continue;
      await deleteFieldIf(kv, cooldowns, field, record.raw);
    }
    return;
  }

  const outcome = report.outcome;
  const settings = await routingSettingsFor(db, report.workspace);
  const record = await workspaceProviderRecord(db, report.workspace, report.provider);
  const providerRouting = resolveProviderRouting(
    (record?.configuration.routing as ProviderRouting | null) ?? undefined,
  );

  if (settings.sessionAffinity && report.session) {
    const sessions = sessionsKey(report.workspace);
    const field = sessionField(report.session.primary, report.model, requestTier(report.serviceTier));
    const binding = await readField<Binding>(kv, sessions, field);
    const rebind = settings.sessionAffinityRebindOn === "any" || outcome.rebindOnQuota;
    if (
      binding &&
      rebind &&
      binding.value.provider === report.provider &&
      binding.value.credential === report.credential
    ) {
      await deleteFieldIf(kv, sessions, field, binding.raw);
    }
  }

  if (settings.disableCooling || providerRouting.disableCooling || !outcome.reason) return;

  const credentialWide =
    outcome.reason === "unauthorized" ||
    outcome.reason === "payment_required" ||
    (outcome.reason === "quota" && outcome.credentialScope && !providerRouting.modelLevelCooling);
  const decision: FailureDecision = {
    reason: outcome.reason,
    retryAfterMs: outcome.retryAfterMs,
    credentialScope: outcome.credentialScope,
    forceCooldown: outcome.forceCooldown,
    rebindOnQuota: outcome.rebindOnQuota,
    action: "continue",
    retryRound: false,
  };
  await updateField<Cooldown>(
    kv,
    cooldowns,
    cooldownField(report.provider, report.credential, credentialWide ? ALL_MODELS : report.model),
    (existing) => {
      const window = nextCooldown(existing, decision, settings.transientErrorCooldownSeconds, now);
      if (!window) return undefined;
      return {
        value: {
          reason: outcome.reason!,
          nextRetryAt: window.nextRetryAt,
          backoffLevel: window.backoffLevel,
          ...(outcome.status !== undefined ? { status: outcome.status } : {}),
          message: outcome.message,
          recordedAt: now,
        },
        fieldTtlMs: window.nextRetryAt + COOLDOWN_RETENTION_MS - now,
      };
    },
  );
}

/** Deletes every cooldown of one credential (it was removed). */
export async function clearCredentialCooldowns(
  kv: Kv,
  workspace: string,
  provider: string,
  credential: string,
) {
  const key = cooldownsKey(workspace);
  const fields = Object.keys(await kvHashGetAll(kv, key)).filter((field) => {
    const parts = parseCooldownField(field);
    return parts !== null && parts[0] === provider && parts[1] === credential;
  });
  await kvHashDelete(kv, key, fields);
}

// ---------------------------------------------------------------------------------------------
// Owner services (`routing.*`). Authorization (owned workspace) is the procedure's.

/**
 * Owner view of workspace routing: effective settings, per-provider overrides with each
 * provider's credentials (creation order, effective priority and weight), and cooldowns.
 * Clients compare `nextRetryAt` (ms epoch) with their clock to show active cooldowns.
 */
export async function getRoutingConfiguration(db: Database, kv: Kv, workspace: string) {
  const [settings, records, credentials, cooldowns] = await Promise.all([
    routingSettingsFor(db, workspace),
    workspaceProviderRecords(db, workspace),
    db
      .select()
      .from(workspaceCredentials)
      .where(eq(workspaceCredentials.workspace, workspace))
      .orderBy(workspaceCredentials.createdAt, workspaceCredentials.id),
    kvHashGetAll(kv, cooldownsKey(workspace)),
  ]);
  const credentialById = new Map(credentials.map((credential) => [credential.id, credential]));

  return {
    settings,
    providers: records.map((record) => ({
      slug: record.provider.slug,
      name: record.provider.name,
      enabled: isWorkspaceProviderEnabled(record),
      credentials: credentials
        .filter((credential) => credential.provider === record.provider.slug)
        .map((credential) => ({
          id: credential.id,
          name: credentialDisplayName(credential),
          enabled: credential.enabled,
          priority: credential.priority,
          weight: credential.weight,
        })),
      routing: resolveProviderRouting(
        (record.configuration.routing as ProviderRouting | null) ?? undefined,
      ),
    })),
    cooldowns: Object.entries(cooldowns)
      .flatMap(([field, raw]) => {
        const parts = parseCooldownField(field);
        if (!parts) return [];
        const [provider, credential, model] = parts;
        const record = JSON.parse(raw) as Cooldown;
        const row = credentialById.get(credential);
        return [
          {
            id: field,
            provider,
            credential,
            credentialName: row ? credentialDisplayName(row) : null,
            model,
            reason: record.reason,
            nextRetryAt: record.nextRetryAt,
            backoffLevel: record.backoffLevel,
            status: record.status ?? null,
            message: record.message ?? null,
          },
        ];
      })
      .sort((left, right) => right.nextRetryAt - left.nextRetryAt)
      .slice(0, MAX_LISTED_COOLDOWNS),
  };
}

/** Replaces the workspace routing settings; out-of-range values are refused, not clamped. */
export async function setRoutingSettings(db: Database, workspace: string, settings: RoutingSettings) {
  assertValid(() => assertValidRoutingSettings(settings));
  await updateWorkspaceSettings(db, workspace, { routing: settings });
}

/**
 * Replaces one provider's routing overrides and, optionally, the priority and weight of some of
 * its credentials, in one transaction under the provider's configuration lock. Error-rule
 * regexes must compile, placements must be in range, and every credential must belong to this
 * workspace provider.
 */
export async function setProviderRouting(
  db: Database,
  workspace: string,
  input: {
    provider: string;
    routing: ProviderRouting;
    credentials?: Array<{ credential: string; priority: number; weight: number }>;
  },
) {
  assertValid(() => assertValidProviderRouting(input.routing));
  for (const placement of input.credentials ?? []) {
    assertValid(() => assertValidPlacement(placement));
  }
  await db.transaction(async (tx) => {
    const record = await requireWorkspaceProvider(tx, workspace, input.provider);
    const placements = input.credentials ?? [];
    if (placements.length > 0) {
      const owned = await tx
        .select({ id: workspaceCredentials.id })
        .from(workspaceCredentials)
        .where(
          and(
            eq(workspaceCredentials.workspace, workspace),
            eq(workspaceCredentials.provider, input.provider),
            inArray(
              workspaceCredentials.id,
              placements.map((placement) => placement.credential),
            ),
          ),
        );
      const ownedIds = new Set(owned.map((row) => row.id));
      if (placements.some((placement) => !ownedIds.has(placement.credential))) {
        throw new AppError("NOT_FOUND", "Credential not found.");
      }
      for (const placement of placements) {
        await tx
          .update(workspaceCredentials)
          .set({ priority: placement.priority, weight: placement.weight })
          .where(eq(workspaceCredentials.id, placement.credential));
      }
    }
    await tx
      .update(workspaceProviders)
      .set({ routing: input.routing })
      .where(eq(workspaceProviders.id, record.configuration.id));
  });
}

/**
 * Clears one cooldown (by its `id` from {@link getRoutingConfiguration}), or every cooldown of a
 * provider when `cooldown` is omitted, resetting their backoff. A cooldown of another provider
 * is left alone.
 */
export async function resetCooldown(
  kv: Kv,
  workspace: string,
  input: { provider: string; cooldown?: string },
) {
  const key = cooldownsKey(workspace);
  if (input.cooldown !== undefined) {
    const parts = parseCooldownField(input.cooldown);
    if (parts && parts[0] === input.provider) await kvHashDelete(kv, key, [input.cooldown]);
    return;
  }
  const fields = Object.keys(await kvHashGetAll(kv, key)).filter(
    (field) => parseCooldownField(field)?.[0] === input.provider,
  );
  await kvHashDelete(kv, key, fields);
}
