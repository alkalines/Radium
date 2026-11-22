import { z } from "zod";

/**
 * Workspace routing configuration, modeled on CLIProxyAPI's `routing`, `request-retry`,
 * and `cooldown` settings. Stored on `workspace_settings.routing`; absent means defaults.
 */
export const routingStrategyValidator = z.union([
  z.literal("round-robin"),
  z.literal("weighted-round-robin"),
  z.literal("fill-first"),
]);

export const sessionAffinityRebindValidator = z.union([z.literal("any"), z.literal("quota")]);

export const routingSettingsValidator = z.object({
  strategy: routingStrategyValidator,
  /** Bind a conversation to the provider that first served it. */
  sessionAffinity: z.boolean(),
  /** Sliding binding lifetime in seconds. */
  sessionAffinityTtlSeconds: z.number(),
  /** Child sessions with a parent reference inherit the parent's provider. */
  sessionAffinitySubagents: z.boolean(),
  /** `quota` keeps a binding through transient failures; `any` rebinds on every provider failure. */
  sessionAffinityRebindOn: sessionAffinityRebindValidator,
  /** Extra retry rounds after the first round of attempts. */
  requestRetry: z.number(),
  /** Providers tried per round; 0 means every eligible provider. */
  maxRetryCredentials: z.number(),
  /** Longest wait in seconds for a cooldown to end between rounds; 0 never waits. */
  maxRetryIntervalSeconds: z.number(),
  /** Never cool down providers after failures. */
  disableCooling: z.boolean(),
  /** Cooldown for 408/5xx failures; 0 uses 60 seconds, -1 disables transient cooldowns. */
  transientErrorCooldownSeconds: z.number(),
});

export type RoutingStrategy = z.infer<typeof routingStrategyValidator>;
export type RoutingSettings = z.infer<typeof routingSettingsValidator>;

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
export const errorRuleActionValidator = z.union([
  z.literal("stop"),
  z.literal("stop-and-cooldown"),
  z.literal("continue"),
  z.literal("continue-and-cooldown"),
]);

/**
 * Matches an upstream failure by exact status and any body substring or regular expression.
 * A rule with neither `match` nor `matchRegex` never matches.
 */
export const errorRuleValidator = z.object({
  status: z.number(),
  match: z.array(z.string()),
  matchRegex: z.array(z.string()),
  action: errorRuleActionValidator,
});

export type ErrorRule = z.infer<typeof errorRuleValidator>;
export type ErrorRuleAction = z.infer<typeof errorRuleActionValidator>;

/** Per-provider routing overrides stored on `workspace_configurations.routing`. */
export const providerRoutingValidator = z.object({
  /** Larger values are tried first; lower tiers only serve when every higher provider is blocked. */
  priority: z.number(),
  /** Share for `weighted-round-robin`; 0 excludes the provider under that strategy. */
  weight: z.number(),
  /** Never cool down this provider, overriding the workspace setting. */
  disableCooling: z.boolean(),
  /** Scope quota cooldowns to the requested model instead of the whole provider credential. */
  modelLevelCooling: z.boolean(),
  errorRules: z.array(errorRuleValidator),
});

export type ProviderRouting = z.infer<typeof providerRoutingValidator>;

/** Why a provider (or provider+model) is temporarily excluded from routing. */
export const cooldownReasonValidator = z.union([
  z.literal("quota"),
  z.literal("unauthorized"),
  z.literal("payment_required"),
  z.literal("not_found"),
  z.literal("model_unsupported"),
  z.literal("transient"),
  z.literal("other"),
]);

export type CooldownReason = z.infer<typeof cooldownReasonValidator>;

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

/** Validate a priority and weight, shared by provider and credential routing. */
export function assertValidPlacement(placement: { priority: number; weight: number }) {
  assertInteger(
    "Priority",
    placement.priority,
    -ROUTING_LIMITS.maxPriority,
    ROUTING_LIMITS.maxPriority,
  );
  assertInteger("Weight", placement.weight, 0, ROUTING_LIMITS.maxWeight);
}

/** Validate owner-submitted provider overrides, including that every regex compiles. */
export function assertValidProviderRouting(routing: ProviderRouting) {
  assertValidPlacement(routing);
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
