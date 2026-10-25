import { describe, expect, test } from "vitest";
import { COOLDOWN, decideFailure, nextCooldown, type UpstreamFailure } from "./failures";
import { applyRoutingPreferences, routingPreferencesFromRequest } from "./preferences";
import { highestPriorityTier, pickFromTier, type SelectionCursor } from "./selection";
import { extractRoutingSession } from "./session";
import type { ChatCompletions_RequestBody_Type } from "@/types/openai/types";

const NOW = 1_000_000;

function failure(status: number, body = "", headers: Record<string, string> = {}): UpstreamFailure {
  return { kind: "http", status, message: `HTTP ${status}`, body, headers, outputStarted: false };
}

function candidate(provider: string, priority = 0, weight = 1) {
  return { provider, priority, weight };
}

describe("selection strategies", () => {
  test("only the highest priority tier is eligible", () => {
    const tier = highestPriorityTier([candidate("b"), candidate("c", 5), candidate("a", 5)]);
    expect(tier.map((entry) => entry.provider)).toEqual(["a", "c"]);
  });

  test("round-robin continues after the last pick when the tier shrinks", () => {
    let cursor: SelectionCursor = { weighted: [] };
    const picks: string[] = [];
    for (const tier of [
      ["a", "b", "c"],
      ["a", "b", "c"],
      ["a", "c"],
      ["a", "b", "c"],
    ]) {
      const result = pickFromTier(
        "round-robin",
        tier.map((slug) => candidate(slug)),
        cursor,
      )!;
      picks.push(result.picked.provider);
      cursor = result.cursor;
    }
    // "b" was excluded on the third pick, so rotation moves on to "c" instead of re-seating.
    expect(picks).toEqual(["a", "b", "c", "a"]);
  });

  test("smooth weighted round-robin interleaves by weight and skips zero weights", () => {
    let cursor: SelectionCursor = { weighted: [] };
    const tier = [
      candidate("a", 0, 5),
      candidate("b", 0, 1),
      candidate("c", 0, 1),
      candidate("d", 0, 0),
    ];
    const picks: string[] = [];
    for (let index = 0; index < 7; index++) {
      const result = pickFromTier("weighted-round-robin", tier, cursor)!;
      picks.push(result.picked.provider);
      cursor = result.cursor;
    }
    expect(picks).toEqual(["a", "a", "b", "a", "c", "a", "a"]);
  });

  test("fill-first stays on the first provider", () => {
    const tier = [candidate("a"), candidate("b")];
    expect(pickFromTier("fill-first", tier, { weighted: [] })!.picked.provider).toBe("a");
  });
});

describe("failure classification and cooldowns", () => {
  test("status classes map to CLIProxyAPI cooldowns", () => {
    const cooldownFor = (status: number) =>
      nextCooldown(null, decideFailure(failure(status), [], NOW), 0, NOW)?.nextRetryAt;

    expect(cooldownFor(401)).toBe(NOW + COOLDOWN.authMs);
    expect(cooldownFor(403)).toBe(NOW + COOLDOWN.authMs);
    expect(cooldownFor(404)).toBe(NOW + COOLDOWN.notFoundMs);
    expect(cooldownFor(503)).toBe(NOW + COOLDOWN.transientMs);
    expect(cooldownFor(418)).toBe(NOW + COOLDOWN.otherMs);
    expect(cooldownFor(400)).toBeUndefined();
    expect(decideFailure(failure(400), [], NOW).action).toBe("stop");
  });

  test("429 backoff escalates once per window and honors Retry-After with a floor", () => {
    const decision = decideFailure(failure(429), [], NOW);
    const first = nextCooldown(null, decision, 0, NOW)!;
    expect(first).toEqual({ nextRetryAt: NOW + 1000, backoffLevel: 1 });

    // A concurrent 429 inside the open window reuses it instead of escalating.
    expect(nextCooldown(first, decision, 0, NOW + 10)).toEqual(first);

    const afterExpiry = nextCooldown(first, decision, 0, NOW + 2000)!;
    expect(afterExpiry).toEqual({ nextRetryAt: NOW + 2000 + 2000, backoffLevel: 2 });

    const withRetryAfter = decideFailure(failure(429, "", { "retry-after": "2" }), [], NOW);
    expect(nextCooldown(null, withRetryAfter, 0, NOW)!.nextRetryAt).toBe(
      NOW + COOLDOWN.minQuotaCooldownMs,
    );
  });

  test("plan-limit bodies scope quota to the credential and bound the reset", () => {
    const body = JSON.stringify({ error: { type: "usage_limit_reached", resets_in_seconds: 600 } });
    const decision = decideFailure(failure(429, body), [], NOW);
    expect(decision.credentialScope).toBe(true);
    expect(decision.retryAfterMs).toBe(600_000);

    const billingBoundary = JSON.stringify({ error: { resets_in_seconds: 30 * 24 * 3600 } });
    expect(decideFailure(failure(429, billingBoundary), [], NOW).retryAfterMs).toBeUndefined();
  });

  test("later failures never shorten an active cooldown", () => {
    const longWindow = { nextRetryAt: NOW + COOLDOWN.authMs, backoffLevel: 0 };
    const transient = decideFailure(failure(503), [], NOW);
    expect(nextCooldown(longWindow, transient, 0, NOW)!.nextRetryAt).toBe(NOW + COOLDOWN.authMs);
  });

  test("transient cooldown setting: 0 uses 60s, -1 disables, n uses n seconds", () => {
    const transient = decideFailure(failure(502), [], NOW);
    expect(nextCooldown(null, transient, 0, NOW)!.nextRetryAt).toBe(NOW + 60_000);
    expect(nextCooldown(null, transient, -1, NOW)).toBeNull();
    expect(nextCooldown(null, transient, 5, NOW)!.nextRetryAt).toBe(NOW + 5_000);
  });

  test("owner error rules override the status class", () => {
    const rules = [
      {
        status: 400,
        match: ["context_length_exceeded"],
        matchRegex: [],
        action: "continue" as const,
      },
      {
        status: 503,
        match: [],
        matchRegex: ["^over.?loaded"],
        action: "stop-and-cooldown" as const,
      },
    ];

    const contextLength = decideFailure(failure(400, "context_length_exceeded"), rules, NOW);
    expect(contextLength).toMatchObject({ action: "continue", reason: undefined });

    const overloaded = decideFailure(failure(503, "overloaded"), rules, NOW);
    expect(overloaded).toMatchObject({ action: "stop", reason: "transient", forceCooldown: true });
    // Forced cooldown applies even when transient cooldowns are disabled.
    expect(nextCooldown(null, overloaded, -1, NOW)).not.toBeNull();
  });

  test("failures after output started are never retried", () => {
    const streamed = { ...failure(503), outputStarted: true };
    expect(decideFailure(streamed, [], NOW)).toMatchObject({ action: "stop", reason: "transient" });
  });
});

describe("routing sessions", () => {
  const request = (fields: Partial<ChatCompletions_RequestBody_Type>) =>
    ({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      ...fields,
    }) as ChatCompletions_RequestBody_Type;

  test("chat context, then client headers, then body identifiers win", () => {
    const headers = new Headers({ "X-Session-ID": "client-session" });
    expect(
      extractRoutingSession(request({ prompt_cache_key: "pck" }), headers, "chat-1")?.primary,
    ).toBe("chat:chat-1");
    expect(extractRoutingSession(request({ prompt_cache_key: "pck" }), headers)?.primary).toBe(
      "header:client-session",
    );
    expect(
      extractRoutingSession(request({ session_id: "s", prompt_cache_key: "pck" }))?.primary,
    ).toBe("session:s");
    expect(extractRoutingSession(request({ prompt_cache_key: "pck" }))?.primary).toBe("pck:pck");
  });

  test("a parent session header makes the request a subagent of the parent", () => {
    const headers = new Headers({ "X-Session-ID": "child", "X-Parent-Session-ID": "parent" });
    expect(extractRoutingSession(request({}), headers)).toEqual({
      primary: "header:child",
      fallback: "header:parent",
      isSubagent: true,
    });
  });

  test("the first-turn message hash carries over once an assistant reply exists", () => {
    const firstTurn = extractRoutingSession(
      request({
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: "hi" },
        ],
      }),
    )!;
    const secondTurn = extractRoutingSession(
      request({
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: "hi" },
          { role: "assistant", content: "hello" },
          { role: "user", content: "more" },
        ],
      }),
    )!;
    expect(firstTurn.primary).toMatch(/^msg:[0-9a-f]{16}$/);
    expect(secondTurn.fallback).toBe(firstTurn.primary);
    expect(secondTurn.primary).not.toBe(firstTurn.primary);
  });
});

describe("request provider preferences", () => {
  const candidates = [candidate("a", 10), candidate("b"), candidate("c")];

  test("a provider slug pins without fallbacks", () => {
    const preferences = routingPreferencesFromRequest("b");
    expect(applyRoutingPreferences(candidates, preferences, new Map())).toEqual([candidate("b")]);
  });

  test("order outranks owner priority; allow_fallbacks false drops unlisted providers", () => {
    const ordered = applyRoutingPreferences(
      candidates,
      routingPreferencesFromRequest({ order: ["c", "b"] }),
      new Map(),
    );
    expect(highestPriorityTier(ordered).map((entry) => entry.provider)).toEqual(["c"]);
    expect(ordered.map((entry) => entry.provider).sort()).toEqual(["a", "b", "c"]);

    const strict = applyRoutingPreferences(
      candidates,
      routingPreferencesFromRequest({ order: ["c"], allow_fallbacks: false }),
      new Map(),
    );
    expect(strict.map((entry) => entry.provider)).toEqual(["c"]);
  });

  test("sort ranks by metric and places unknown values last", () => {
    const metrics = new Map([
      ["a", { throughput: 10 }],
      ["b", { throughput: 80 }],
    ]);
    const sorted = applyRoutingPreferences(
      candidates,
      routingPreferencesFromRequest({ sort: { by: "throughput" }, ignore: [] }),
      metrics,
    );
    const byPriority = [...sorted].sort((left, right) => right.priority - left.priority);
    expect(byPriority.map((entry) => entry.provider)).toEqual(["b", "a", "c"]);
  });
});
