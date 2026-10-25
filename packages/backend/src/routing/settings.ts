import { v, type Infer } from "convex/values";

/**
 * Workspace routing configuration, modeled on CLIProxyAPI's `routing`, `request-retry`,
 * and `cooldown` settings. Stored on `workspace_settings.routing`; absent means defaults.
 */
export const routingStrategyValidator = v.union(
  v.literal("round-robin"),
  v.literal("weighted-round-robin"),
  v.literal("fill-first"),
);

export const sessionAffinityRebindValidator = v.union(v.literal("any"), v.literal("quota"));

export const routingSettingsValidator = v.object({
  strategy: routingStrategyValidator,
  /** Bind a conversation to the provider that first served it. */
  sessionAffinity: v.boolean(),
  /** Sliding binding lifetime in seconds. */
  sessionAffinityTtlSeconds: v.number(),
  /** Child sessions with a parent reference inherit the parent's provider. */
  sessionAffinitySubagents: v.boolean(),
  /** `quota` keeps a binding through transient failures; `any` rebinds on every provider failure. */
  sessionAffinityRebindOn: sessionAffinityRebindValidator,
  /** Extra retry rounds after the first round of attempts. */
  requestRetry: v.number(),
  /** Providers tried per round; 0 means every eligible provider. */
  maxRetryCredentials: v.number(),
  /** Longest wait in seconds for a cooldown to end between rounds; 0 never waits. */
  maxRetryIntervalSeconds: v.number(),
  /** Never cool down providers after failures. */
  disableCooling: v.boolean(),
  /** Cooldown for 408/5xx failures; 0 uses 60 seconds, -1 disables transient cooldowns. */
  transientErrorCooldownSeconds: v.number(),
});

export type RoutingStrategy = Infer<typeof routingStrategyValidator>;
export type RoutingSettings = Infer<typeof routingSettingsValidator>;

export const DEFAULT_ROUTING_SETTINGS: RoutingSettings = {
  strategy: "round-robin",
  sessionAffinity: false,
  sessionAffinityTtlSeconds: 3600,
  sessionAffinitySubagents: true,
  sessionAffinityRebindOn: "any",
  requestRetry: 3,
  maxRetryCredentials: 0,
  maxRetryIntervalSeconds: 30,
  disableCooling: false,
  transientErrorCooldownSeconds: 0,
};

/** Upper bounds keep a misconfigured workspace from holding an action open indefinitely. */
export const ROUTING_LIMITS = {
  maxRequestRetry: 10,
  maxRetryCredentials: 1000,
  /** Owner priorities are bounded so request `order`/`sort` ranks always outrank them. */
  maxPriority: 1_000_000,
  maxRetryIntervalSeconds: 300,
  maxSessionAffinityTtlSeconds: 7 * 24 * 3600,
  maxTransientErrorCooldownSeconds: 24 * 3600,
  maxWeight: 1_000_000,
  maxErrorRules: 32,
  maxErrorRuleMatches: 16,
  maxErrorRuleMatchLength: 512,
} as const;

/**
 * Validate an owner-submitted settings object. Values outside the documented ranges are
 * rejected instead of clamped so the stored configuration always matches what the UI shows.
 */
export function assertValidRoutingSettings(settings: RoutingSettings) {
  assertInteger("Request retry", settings.requestRetry, 0, ROUTING_LIMITS.maxRequestRetry);
  assertInteger(
    "Max retry providers",
    settings.maxRetryCredentials,
    0,
    ROUTING_LIMITS.maxRetryCredentials,
  );
  assertInteger(
    "Max retry interval",
    settings.maxRetryIntervalSeconds,
    0,
    ROUTING_LIMITS.maxRetryIntervalSeconds,
  );
  assertInteger(
    "Session affinity TTL",
    settings.sessionAffinityTtlSeconds,
    1,
    ROUTING_LIMITS.maxSessionAffinityTtlSeconds,
  );
  assertInteger(
    "Transient error cooldown",
    settings.transientErrorCooldownSeconds,
    -1,
    ROUTING_LIMITS.maxTransientErrorCooldownSeconds,
  );
}

/** Effective workspace routing settings. */
export function resolveRoutingSettings(stored: RoutingSettings | undefined): RoutingSettings {
  return stored ?? DEFAULT_ROUTING_SETTINGS;
}

/** CLIProxyAPI request-scoped error rule actions. */
export const errorRuleActionValidator = v.union(
  v.literal("stop"),
  v.literal("stop-and-cooldown"),
  v.literal("continue"),
  v.literal("continue-and-cooldown"),
);

/**
 * Matches an upstream failure by exact status and any body substring or regular expression.
 * A rule with neither `match` nor `matchRegex` never matches.
 */
export const errorRuleValidator = v.object({
  status: v.number(),
  match: v.array(v.string()),
  matchRegex: v.array(v.string()),
  action: errorRuleActionValidator,
});

export type ErrorRule = Infer<typeof errorRuleValidator>;
export type ErrorRuleAction = Infer<typeof errorRuleActionValidator>;

/** Per-provider routing overrides stored on `workspace_configurations.routing`. */
export const providerRoutingValidator = v.object({
  /** Larger values are tried first; lower tiers only serve when every higher provider is blocked. */
  priority: v.number(),
  /** Share for `weighted-round-robin`; 0 excludes the provider under that strategy. */
  weight: v.number(),
  /** Never cool down this provider, overriding the workspace setting. */
  disableCooling: v.boolean(),
  /** Scope quota cooldowns to the requested model instead of the whole provider credential. */
  modelLevelCooling: v.boolean(),
  errorRules: v.array(errorRuleValidator),
});

export type ProviderRouting = Infer<typeof providerRoutingValidator>;

/** Why a provider (or provider+model) is temporarily excluded from routing. */
export const cooldownReasonValidator = v.union(
  v.literal("quota"),
  v.literal("unauthorized"),
  v.literal("payment_required"),
  v.literal("not_found"),
  v.literal("model_unsupported"),
  v.literal("transient"),
  v.literal("other"),
);

export type CooldownReason = Infer<typeof cooldownReasonValidator>;

export const DEFAULT_PROVIDER_ROUTING: ProviderRouting = {
  priority: 0,
  weight: 1,
  disableCooling: false,
  modelLevelCooling: false,
  errorRules: [],
};

/** Effective provider routing overrides. */
export function resolveProviderRouting(stored: ProviderRouting | undefined): ProviderRouting {
  return stored ?? DEFAULT_PROVIDER_ROUTING;
}

/** Validate owner-submitted provider overrides, including that every regex compiles. */
export function assertValidProviderRouting(routing: ProviderRouting) {
  assertInteger(
    "Priority",
    routing.priority,
    -ROUTING_LIMITS.maxPriority,
    ROUTING_LIMITS.maxPriority,
  );
  assertInteger("Weight", routing.weight, 0, ROUTING_LIMITS.maxWeight);
  if (routing.errorRules.length > ROUTING_LIMITS.maxErrorRules) {
    throw new Error(`At most ${ROUTING_LIMITS.maxErrorRules} error rules are allowed.`);
  }

  for (const rule of routing.errorRules) {
    assertInteger("Error rule status", rule.status, 100, 599);
    const patterns = [...rule.match, ...rule.matchRegex];
    if (patterns.length === 0) throw new Error("Error rules need at least one match pattern.");
    if (patterns.length > ROUTING_LIMITS.maxErrorRuleMatches) {
      throw new Error(`Error rules allow at most ${ROUTING_LIMITS.maxErrorRuleMatches} patterns.`);
    }

    for (const pattern of patterns) {
      if (!pattern || pattern.length > ROUTING_LIMITS.maxErrorRuleMatchLength) {
        throw new Error("Error rule patterns must be 1-512 characters.");
      }
    }

    for (const pattern of rule.matchRegex) {
      try {
        new RegExp(pattern);
      } catch {
        throw new Error(`Invalid error rule regular expression: ${pattern}`);
      }
    }
  }
}

function assertInteger(label: string, value: number, min: number, max: number) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be an integer from ${min} to ${max}.`);
  }
}
