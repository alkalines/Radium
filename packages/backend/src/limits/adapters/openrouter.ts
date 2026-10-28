import * as z from "zod";
import { LimitPollError, parseJson, type LimitAdapter, type LimitPollResult } from "../adapter";
import {
  epochMs,
  periodEnd,
  periodStart,
  type BudgetPeriod,
  type LimitObservation,
  type Meter,
} from "../meters";

export const OPENROUTER_NPM = "@openrouter/ai-sdk-provider";
export const OPENROUTER_HOST = "openrouter.ai";
export const OPENROUTER_KEY_URL = "https://openrouter.ai/api/v1/key";
export const OPENROUTER_CREDITS_URL = "https://openrouter.ai/api/v1/credits";
const POLL_INTERVAL_MS = 5 * 60 * 1000;

const CREDITS_METER = "openrouter:credits";

/** OpenRouter reset intervals (`daily`/`weekly`/`monthly`, UTC) as budget periods. */
function resetPeriod(value: string | null | undefined): BudgetPeriod | undefined {
  switch (value?.toLowerCase()) {
    case "daily":
    case "day":
      return "day";
    case "weekly":
    case "week":
      return "week";
    case "monthly":
    case "month":
      return "month";
    default:
      return undefined;
  }
}

function periodWindow(period: BudgetPeriod | undefined, now: number) {
  if (!period) return {};
  const resetsAt = periodEnd(period, now);
  return { windowSeconds: (resetsAt - periodStart(period, now)) / 1000, resetsAt };
}

const nullableNumber = z.number().nullish();
const budgetSchema = z.object({
  scope: z.string().nullish(),
  limit_usd: nullableNumber,
  spend_usd: nullableNumber,
  remaining_usd: nullableNumber,
  reset_interval: z.string().nullish(),
  resets_at: z.union([z.string(), z.number()]).nullish(),
});
export const openRouterKeySchema = z.object({
  data: z.object({
    limit: nullableNumber,
    limit_remaining: nullableNumber,
    limit_reset: z.string().nullish(),
    usage: nullableNumber,
    usage_daily: nullableNumber,
    usage_weekly: nullableNumber,
    usage_monthly: nullableNumber,
    is_free_tier: z.boolean().nullish(),
    free_model_daily_requests: z
      .object({ used: nullableNumber, limit: nullableNumber, remaining: nullableNumber })
      .nullish(),
    budgets: z.array(budgetSchema).nullish(),
    effective_budget: budgetSchema.nullish(),
    expires_at: z.union([z.string(), z.number()]).nullish(),
  }),
});
export type OpenRouterKey = z.infer<typeof openRouterKeySchema>;

export const openRouterCreditsSchema = z.object({
  data: z.object({ total_credits: z.number(), total_usage: z.number() }),
});

function budgetMeter(
  budget: z.infer<typeof budgetSchema>,
  id: string,
  source: Meter["source"],
  now: number,
): Meter | undefined {
  const limit = budget.limit_usd ?? undefined;
  const used =
    budget.spend_usd ??
    (limit !== undefined && budget.remaining_usd != null
      ? limit - budget.remaining_usd
      : undefined);
  const remaining =
    budget.remaining_usd ?? (limit !== undefined && used !== undefined ? limit - used : undefined);
  const period = resetPeriod(budget.reset_interval);
  const resetsAt = budget.resets_at != null ? epochMs(budget.resets_at) : undefined;
  const window = periodWindow(period, now);
  if (limit === undefined && remaining === undefined) return undefined;
  return {
    id: `openrouter:budget:${id}`,
    label: budget.scope ? `Budget (${budget.scope})` : "Budget",
    scope: "credential",
    unit: "usd",
    ...(used !== undefined ? { used } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(remaining !== undefined ? { remaining } : {}),
    ...(window.windowSeconds !== undefined ? { windowSeconds: window.windowSeconds } : {}),
    ...(resetsAt !== undefined || window.resetsAt !== undefined
      ? { resetsAt: resetsAt ?? window.resetsAt }
      : {}),
    source,
    observedAt: now,
  };
}

/**
 * `GET /api/v1/key` → key limit (with its UTC reset period), every budget, and the free-model
 * daily request allowance. Uncapped keys have no key meter.
 */
export function parseOpenRouterKey(key: OpenRouterKey, now: number): LimitPollResult {
  const data = key.data;
  const meters: Meter[] = [];

  if (data.limit != null) {
    const period = resetPeriod(data.limit_reset);
    const periodUsage =
      period === "day"
        ? data.usage_daily
        : period === "week"
          ? data.usage_weekly
          : period === "month"
            ? data.usage_monthly
            : data.usage;
    const used =
      data.limit_remaining != null ? data.limit - data.limit_remaining : (periodUsage ?? undefined);
    meters.push({
      id: "openrouter:key",
      label: "Key limit",
      scope: "credential",
      unit: "usd",
      limit: data.limit,
      ...(used != null ? { used } : {}),
      ...(data.limit_remaining != null ? { remaining: data.limit_remaining } : {}),
      ...periodWindow(period, now),
      source: "poll",
      observedAt: now,
    });
  }

  const budgets = data.budgets ?? (data.effective_budget ? [data.effective_budget] : []);
  budgets.forEach((budget, index) => {
    const meter = budgetMeter(budget, budget.scope ?? String(index), "poll", now);
    if (meter) meters.push(meter);
  });

  const free = data.free_model_daily_requests;
  if (free?.limit != null) {
    const used = free.used ?? (free.remaining != null ? free.limit - free.remaining : undefined);
    meters.push({
      id: "openrouter:free-requests",
      label: "Free requests (daily)",
      scope: "credential",
      unit: "requests",
      limit: free.limit,
      ...(used !== undefined ? { used } : {}),
      ...(free.remaining != null ? { remaining: free.remaining } : {}),
      ...periodWindow("day", now),
      source: "poll",
      observedAt: now,
    });
  }

  const expiresAt = data.expires_at != null ? epochMs(data.expires_at) : undefined;
  return {
    meters,
    ...(data.is_free_tier ? { plan: "Free tier" } : {}),
    ...(expiresAt !== undefined && expiresAt <= now ? { expired: true } : {}),
  };
}

/** `GET /api/v1/credits` → the account balance shared by every key of the account. */
export function parseOpenRouterCredits(
  credits: z.infer<typeof openRouterCreditsSchema>,
  now: number,
): Meter {
  return {
    id: CREDITS_METER,
    label: "Account balance",
    scope: "account",
    unit: "usd",
    used: credits.data.total_usage,
    remaining: credits.data.total_credits - credits.data.total_usage,
    source: "poll",
    observedAt: now,
  };
}

const errorSchema = z.object({
  error: z.object({
    metadata: z
      .object({
        limit_source: z.string().nullish(),
        scope: z.string().nullish(),
        limit_usd: nullableNumber,
        spend_usd: nullableNumber,
        resets_at: z.union([z.string(), z.number()]).nullish(),
      })
      .nullish(),
  }),
});

/**
 * 402 bodies name the exhausted limit in `error.metadata.limit_source` (`openrouter_key_limit`,
 * `openrouter_credits`, `openrouter_in_flight_budget`); 403 budget bodies carry `limit_usd`,
 * `spend_usd`, and `resets_at`. Each becomes an exhausted meter.
 */
export function parseOpenRouterError(
  status: number,
  body: string,
  now: number,
): LimitObservation | undefined {
  if (status !== 402 && status !== 403) return undefined;
  const parsed = errorSchema.safeParse(parseJson(body));
  const metadata = parsed.success ? parsed.data.error.metadata : undefined;
  if (!metadata) return undefined;
  const base = { scope: "credential" as const, unit: "usd" as const, source: "error" as const };

  switch (metadata.limit_source) {
    case "openrouter_key_limit":
      return {
        meters: [
          { ...base, id: "openrouter:key", label: "Key limit", remaining: 0, observedAt: now },
        ],
      };
    case "openrouter_credits":
      return {
        meters: [
          {
            ...base,
            id: CREDITS_METER,
            label: "Account balance",
            scope: "account",
            remaining: 0,
            observedAt: now,
          },
        ],
      };
  }

  const isBudget =
    metadata.limit_source === "openrouter_in_flight_budget" ||
    metadata.limit_usd != null ||
    metadata.limit_source?.includes("budget");
  if (!isBudget) return undefined;
  const meter = budgetMeter(
    {
      scope: metadata.scope,
      limit_usd: metadata.limit_usd,
      spend_usd: metadata.spend_usd ?? metadata.limit_usd,
      remaining_usd: 0,
      resets_at: metadata.resets_at,
    },
    metadata.scope ?? "effective",
    "error",
    now,
  );
  return meter ? { meters: [meter] } : undefined;
}

async function getJson(url: string, key: string) {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
  });
  return { status: response.status, ok: response.ok, body: parseJson(await response.text()) };
}

/** OpenRouter API keys (`@openrouter/ai-sdk-provider`, or a base URL on `openrouter.ai`). */
export const openRouterLimitAdapter: LimitAdapter = {
  id: "openrouter",
  pollIntervalMs: POLL_INTERVAL_MS,
  parseError: parseOpenRouterError,
  limitKey: {
    label: "Management key",
    description:
      "Optional OpenRouter management key, used only to read the account balance (GET /api/v1/credits). It is never used for inference.",
  },
  async poll(_ctx, target, now) {
    const apiKey = target.env.map((name) => target.values[name]).find(Boolean);
    if (!apiKey) throw new LimitPollError("The OpenRouter API key is missing.", 401);

    const key = await getJson(OPENROUTER_KEY_URL, apiKey);
    if (!key.ok) {
      throw new LimitPollError(`OpenRouter /key returned ${key.status}.`, key.status);
    }
    const parsedKey = openRouterKeySchema.safeParse(key.body);
    if (!parsedKey.success) {
      throw new LimitPollError("OpenRouter /key returned an unexpected payload.");
    }
    const result = parseOpenRouterKey(parsedKey.data, now);
    if (!target.limitKey) return result;

    // The balance needs the management key; its failure keeps the last balance and the key data.
    const credits = await getJson(OPENROUTER_CREDITS_URL, target.limitKey);
    const parsedCredits = credits.ok ? openRouterCreditsSchema.safeParse(credits.body) : undefined;
    if (parsedCredits?.success) {
      return {
        ...result,
        meters: [...result.meters, parseOpenRouterCredits(parsedCredits.data, now)],
      };
    }
    return {
      ...result,
      retain: [CREDITS_METER],
      partialError: {
        message:
          credits.status === 403 || credits.status === 401
            ? `OpenRouter rejected the management key (${credits.status}); account balance not updated.`
            : credits.ok
              ? "OpenRouter /credits returned an unexpected payload."
              : `OpenRouter /credits returned ${credits.status}; account balance not updated.`,
        ...(credits.ok ? {} : { status: credits.status }),
      },
    };
  },
};
