import type { ChatGPTTokens } from "@opencoredev/loginwithchatgpt-server";
import * as z from "zod";
import { getChatGPTTokens } from "../../subscriptions/chatgpt";
import { LimitPollError, parseJson, type LimitAdapter, type LimitPollResult } from "../adapter";
import { epochMs, finiteNumber, windowLabel, type LimitObservation, type Meter } from "../meters";

/** Codex plan usage endpoint (undocumented; `openai/codex` `backend-client`). */
export const CHATGPT_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const POLL_INTERVAL_MS = 5 * 60 * 1000;
const HEADER_PREFIX = "x-codex";
/** Any `x-<limit>-{primary,secondary}-used-percent` family, as Codex CLI's `parse_all_rate_limits`. */
const LIMIT_WINDOW_HEADER = /^x-(.+)-(primary|secondary)-used-percent$/;

type WindowInput = {
  id: string;
  /** Prefix for additional metered limits, e.g. the limit name. */
  name?: string;
  used: number;
  windowSeconds?: number;
  resetsAt?: number;
  source: Meter["source"];
  now: number;
};

function windowMeter(input: WindowInput): Meter {
  const window = input.windowSeconds !== undefined ? windowLabel(input.windowSeconds) : undefined;
  const label = [input.name, window ?? (input.name ? undefined : "Usage limit")]
    .filter(Boolean)
    .join(" ");
  return {
    id: input.id,
    label,
    scope: "credential",
    unit: "percent",
    used: Math.max(0, input.used),
    ...(input.windowSeconds !== undefined ? { windowSeconds: input.windowSeconds } : {}),
    ...(input.resetsAt !== undefined ? { resetsAt: input.resetsAt } : {}),
    source: input.source,
    observedAt: input.now,
  };
}

/**
 * Codex's metered limit ID: header family `x-codex-other-*` and `wham/usage`
 * `metered_feature: "codex_other"` both normalize to `codex_other` (`normalize_limit_id`).
 */
function limitId(name: string) {
  return name.trim().toLowerCase().replace(/-/g, "_");
}

function headerWindow(
  headers: Headers,
  prefix: string,
  meter: { id: string; name?: string },
  now: number,
): Meter | undefined {
  const used = finiteNumber(headers.get(`${prefix}-used-percent`));
  if (used === undefined) return undefined;
  const minutes = finiteNumber(headers.get(`${prefix}-window-minutes`));
  const resetAt = finiteNumber(headers.get(`${prefix}-reset-at`));
  const resetAfter = finiteNumber(headers.get(`${prefix}-reset-after-seconds`));
  return windowMeter({
    ...meter,
    used,
    windowSeconds: minutes !== undefined && minutes > 0 ? minutes * 60 : undefined,
    resetsAt:
      resetAt !== undefined
        ? resetAt * 1000
        : resetAfter !== undefined
          ? now + resetAfter * 1000
          : undefined,
    source: "header",
    now,
  });
}

function creditsMeter(
  credits: { hasCredits?: boolean; unlimited?: boolean; balance?: number },
  source: Meter["source"],
  now: number,
): Meter | undefined {
  // Accounts without purchased credits (the common case) or with unlimited ones have no meter.
  if (!credits.hasCredits || credits.unlimited || credits.balance === undefined) return undefined;
  return {
    id: "codex:credits",
    label: "Credits",
    scope: "credential",
    unit: "credits",
    remaining: credits.balance,
    source,
    observedAt: now,
  };
}

/**
 * `x-codex-*` rate-limit headers on Codex responses: primary and secondary windows (labelled by
 * length, since free plans report a 30-day window), credits, plan, and additional metered limits
 * as `x-codex-<name>-{primary,secondary}-*`. Both `-reset-at` and the older
 * `-reset-after-seconds` are read.
 */
export function parseCodexHeaders(headers: Headers, now: number): LimitObservation | undefined {
  const meters: Meter[] = [];
  for (const window of ["primary", "secondary"] as const) {
    const meter = headerWindow(
      headers,
      `${HEADER_PREFIX}-${window}`,
      { id: `codex:${window}` },
      now,
    );
    if (meter) meters.push(meter);
  }

  for (const [name] of headers) {
    const match = LIMIT_WINDOW_HEADER.exec(name.toLowerCase());
    if (!match) continue;
    const family = match[1]!;
    const id = limitId(family);
    if (id === "codex") continue;
    const window = match[2]!;
    const display = headers.get(`x-${family}-limit-name`) ?? id;
    const meter = headerWindow(
      headers,
      `x-${family}-${window}`,
      { id: `codex:${id}:${window}`, name: display },
      now,
    );
    if (meter) meters.push(meter);
  }

  const credits = creditsMeter(
    {
      hasCredits: headers.get(`${HEADER_PREFIX}-credits-has-credits`)?.toLowerCase() === "true",
      unlimited: headers.get(`${HEADER_PREFIX}-credits-unlimited`)?.toLowerCase() === "true",
      balance: finiteNumber(headers.get(`${HEADER_PREFIX}-credits-balance`)),
    },
    "header",
    now,
  );
  if (credits) meters.push(credits);

  const plan = headers.get(`${HEADER_PREFIX}-plan-type`) ?? undefined;
  if (meters.length === 0 && !plan) return undefined;
  return { meters, ...(plan ? { plan } : {}) };
}

const usageLimitErrorSchema = z.object({
  error: z.object({
    type: z.string().nullish(),
    code: z.string().nullish(),
    plan_type: z.string().nullish(),
    resets_at: z.union([z.number(), z.string()]).nullish(),
    resets_in_seconds: z.number().nullish(),
  }),
});
/** The library's proxy wraps upstream failures: `{ error, status, detail: <raw body> }`. */
const proxyErrorSchema = z.object({
  error: z.literal("responses_request_failed"),
  detail: z.string(),
});

/**
 * `usage_limit_reached` bodies (raw, or inside the library's `responses_request_failed`
 * wrapper) → an exhausted meter until `resets_at` / `resets_in_seconds`. When a stored window
 * resets at that time, the snapshot marks that window exhausted instead.
 */
export function parseCodexError(
  _status: number,
  body: string,
  now: number,
): LimitObservation | undefined {
  let parsed = parseJson(body);
  const wrapped = proxyErrorSchema.safeParse(parsed);
  if (wrapped.success) parsed = parseJson(wrapped.data.detail);

  const result = usageLimitErrorSchema.safeParse(parsed);
  if (!result.success) return undefined;
  const error = result.data.error;
  if (error.type !== "usage_limit_reached" && error.code !== "usage_limit_reached")
    return undefined;

  const resetsAt =
    error.resets_at != null
      ? epochMs(error.resets_at)
      : error.resets_in_seconds != null
        ? now + error.resets_in_seconds * 1000
        : undefined;
  const meter = windowMeter({ id: "codex:usage-limit", used: 100, resetsAt, source: "error", now });
  return { meters: [meter], ...(error.plan_type ? { plan: error.plan_type } : {}) };
}

const usageWindowSchema = z
  .object({
    used_percent: z.number(),
    limit_window_seconds: z.number().nullish(),
    reset_after_seconds: z.number().nullish(),
    reset_at: z.number().nullish(),
  })
  .nullish();
const usageRateLimitSchema = z
  .object({ primary_window: usageWindowSchema, secondary_window: usageWindowSchema })
  .nullish();
export const codexUsageSchema = z.object({
  plan_type: z.string().nullish(),
  rate_limit: usageRateLimitSchema,
  credits: z
    .object({
      has_credits: z.boolean().nullish(),
      unlimited: z.boolean().nullish(),
      balance: z.union([z.string(), z.number()]).nullish(),
    })
    .nullish(),
  additional_rate_limits: z
    .array(
      z.object({
        limit_name: z.string().nullish(),
        metered_feature: z.string().nullish(),
        rate_limit: usageRateLimitSchema,
      }),
    )
    .nullish(),
});
export type CodexUsage = z.infer<typeof codexUsageSchema>;

function usageWindow(
  window: z.infer<typeof usageWindowSchema>,
  meter: { id: string; name?: string },
  now: number,
): Meter | undefined {
  if (!window) return undefined;
  return windowMeter({
    ...meter,
    used: window.used_percent,
    windowSeconds: window.limit_window_seconds ?? undefined,
    resetsAt:
      window.reset_at != null
        ? window.reset_at * 1000
        : window.reset_after_seconds != null
          ? now + window.reset_after_seconds * 1000
          : undefined,
    source: "poll",
    now,
  });
}

/** `wham/usage` payload → the same meters the headers produce, plus `plan_type`. */
export function parseCodexUsage(usage: CodexUsage, now: number): LimitPollResult {
  const meters: Meter[] = [];
  const primary = usageWindow(usage.rate_limit?.primary_window, { id: "codex:primary" }, now);
  const secondary = usageWindow(usage.rate_limit?.secondary_window, { id: "codex:secondary" }, now);
  if (primary) meters.push(primary);
  if (secondary) meters.push(secondary);

  for (const extra of usage.additional_rate_limits ?? []) {
    const key = extra.metered_feature ?? extra.limit_name;
    if (!key) continue;
    const name = extra.limit_name ?? key;
    for (const window of ["primary", "secondary"] as const) {
      const meter = usageWindow(
        extra.rate_limit?.[`${window}_window`],
        { id: `codex:${limitId(key)}:${window}`, name },
        now,
      );
      if (meter) meters.push(meter);
    }
  }

  const credits = creditsMeter(
    {
      hasCredits: usage.credits?.has_credits ?? undefined,
      unlimited: usage.credits?.unlimited ?? undefined,
      balance: finiteNumber(usage.credits?.balance),
    },
    "poll",
    now,
  );
  if (credits) meters.push(credits);

  return { meters, ...(usage.plan_type ? { plan: usage.plan_type } : {}) };
}

/** Login with ChatGPT device flow (`oauth_flow: chatgpt-device`). */
export const chatGPTLimitAdapter: LimitAdapter = {
  id: "chatgpt-device",
  pollIntervalMs: POLL_INTERVAL_MS,
  parseHeaders: parseCodexHeaders,
  parseError: parseCodexError,
  async poll(ctx, target, now) {
    const sessionCookie = target.values.sessionCookie;
    if (!sessionCookie) throw new LimitPollError("The ChatGPT session is missing.", 401);

    let tokens: ChatGPTTokens | undefined;
    try {
      tokens = await getChatGPTTokens(ctx, sessionCookie);
    } catch (error) {
      const status =
        error instanceof Error && "status" in error && typeof error.status === "number"
          ? error.status
          : undefined;
      throw new LimitPollError(
        `The ChatGPT session could not be refreshed: ${error instanceof Error ? error.message : String(error)}`,
        status !== undefined && status >= 400 && status < 500 ? 401 : undefined,
      );
    }
    if (!tokens?.accessToken || !tokens.accountId) {
      throw new LimitPollError("The ChatGPT session has expired.", 401);
    }

    const response = await fetch(CHATGPT_USAGE_URL, {
      headers: {
        Authorization: `Bearer ${tokens.accessToken}`,
        // Without it the endpoint may answer for another workspace of the same login.
        "ChatGPT-Account-Id": tokens.accountId,
        "User-Agent": "codex-cli",
        Accept: "application/json",
      },
    });
    if (!response.ok) {
      throw new LimitPollError(
        `The ChatGPT usage endpoint returned ${response.status}.`,
        response.status,
      );
    }
    const usage = codexUsageSchema.safeParse(parseJson(await response.text()));
    if (!usage.success) {
      throw new LimitPollError("The ChatGPT usage endpoint returned an unexpected payload.");
    }
    return parseCodexUsage(usage.data, now);
  },
};
