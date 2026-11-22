import type { RoutingSettings } from "contracts/routing/settings";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addModel, addProvider, offer, setRouting } from "../../../test/gateway";
import { createTestRuntime, type TestRuntime } from "../../../test/runtime";
import { classicUser } from "../../../test/users";
import { workspaces } from "../../workspaces/schema";
import { RoutingConfigurationError } from "../providers";
import { workspaceCredentials } from "../schema";
import { eq } from "drizzle-orm";
import { getRoutingConfiguration, pickRoute, reportAttempt, resetCooldown } from "./state";

// Routing decisions and their Valkey state (cursors, cooldowns, session affinity), ported from
// `packages/backend/convex/routing.test.ts`, plus the atomicity Convex got from serializing
// mutations.

const MODEL = "test-model";
let test: TestRuntime;
let owner = "";

beforeAll(async () => {
  test = await createTestRuntime();
  owner = (await classicUser(test.runtime, "routing-owner@example.test")).id;
  await addModel(test.runtime, MODEL);
});

afterAll(async () => {
  await test?.close();
});

type Harness = { workspace: string; credentials: Record<string, string[]> };

async function setup(
  providers: Array<{ slug: string; priority?: number; weight?: number; credentials?: number }>,
  routing: Partial<RoutingSettings> = {},
): Promise<Harness> {
  const [row] = await test.runtime.drivers.db
    .insert(workspaces)
    .values({ ownerId: owner, name: "Routing" })
    .returning();
  const workspace = row!.id;
  await setRouting(test.runtime, workspace, routing);
  const credentials: Record<string, string[]> = {};
  for (const provider of providers) {
    credentials[provider.slug] = await addProvider(test.runtime, workspace, {
      slug: provider.slug,
      models: [offer(MODEL)],
      routing: { priority: provider.priority ?? 0, weight: provider.weight ?? 1 },
      credentials: provider.credentials,
    });
  }
  return { workspace, credentials };
}

/** `slug` for a single-credential provider, else `slug#n` (1-based creation index). */
function targetName(harness: Harness, provider: string, credential: string) {
  const list = harness.credentials[provider]!;
  return list.length === 1 ? provider : `${provider}#${list.indexOf(credential) + 1}`;
}

function targets(harness: Harness, name: string) {
  const [provider, index] = name.split("#") as [string, string | undefined];
  const list = harness.credentials[provider]!;
  const selected = index === undefined ? list : [list[Number(index) - 1]!];
  return selected.map((credential) => ({ provider, credential }));
}

async function pick(harness: Harness, options: { excluded?: string[]; session?: string } = {}) {
  const result = await pickRoute(test.runtime, {
    workspace: harness.workspace,
    model: MODEL,
    preferences: { allowFallbacks: true },
    excluded: (options.excluded ?? []).flatMap((name) => targets(harness, name)),
    ...(options.session ? { session: { primary: options.session, isSubagent: false } } : {}),
  });
  if (!result.ok) return result;
  return targetName(harness, result.provider.slug, result.provider.credential.id);
}

const transientFailure = {
  type: "failure" as const,
  reason: "transient" as const,
  credentialScope: false,
  forceCooldown: false,
  rebindOnQuota: false,
  status: 503,
  message: "Service unavailable",
};
const unauthorizedFailure = {
  ...transientFailure,
  reason: "unauthorized" as const,
  status: 401,
  message: "Invalid API key",
};
const quotaFailure = {
  ...transientFailure,
  reason: "quota" as const,
  credentialScope: true,
  status: 429,
  message: "Rate limited",
};

async function report(
  harness: Harness,
  name: string,
  outcome: Parameters<typeof reportAttempt>[1]["outcome"],
  options: { dispatchedAt?: number; session?: string } = {},
) {
  const [target] = targets(harness, name);
  await reportAttempt(test.runtime, {
    workspace: harness.workspace,
    ...target!,
    model: MODEL,
    dispatchedAt: options.dispatchedAt ?? Date.now(),
    ...(options.session ? { session: { primary: options.session, isSubagent: false } } : {}),
    outcome,
  });
}

async function clearCooldowns(harness: Harness) {
  for (const provider of Object.keys(harness.credentials)) {
    await resetCooldown(test.runtime.drivers.kv, harness.workspace, { provider });
  }
}

describe("credential pools", () => {
  it("round-robin alternates providers and rotates each provider's credentials", async () => {
    const harness = await setup([{ slug: "a", credentials: 2 }, { slug: "b" }]);
    const picks = [];
    for (let attempt = 0; attempt < 5; attempt++) picks.push(await pick(harness));
    expect([picks[1], picks[3]]).toEqual(["b", "b"]);
    expect(new Set([picks[0], picks[2]])).toEqual(new Set(["a#1", "a#2"]));
    expect(picks[4]).toBe(picks[0]);
  });

  it("a failing credential cools down without blocking the provider's other credentials", async () => {
    const harness = await setup([{ slug: "a", credentials: 2 }, { slug: "b" }], {
      strategy: "fill-first",
    });
    expect(await pick(harness)).toBe("a#1");
    expect(await pick(harness, { excluded: ["a#1"] })).toBe("a#2");
    await report(harness, "a#1", unauthorizedFailure);
    expect(await pick(harness)).toBe("a#2");
    await report(harness, "a#2", transientFailure);
    expect(await pick(harness)).toBe("b");
  });

  it("disabled credentials are never routed", async () => {
    const harness = await setup([{ slug: "a", credentials: 2 }], { strategy: "fill-first" });
    await test.runtime.drivers.db
      .update(workspaceCredentials)
      .set({ enabled: false })
      .where(eq(workspaceCredentials.id, harness.credentials.a![0]!));
    expect(await pick(harness)).toBe("a#2");
    expect(await pick(harness, { excluded: ["a#2"] })).toMatchObject({ ok: false });
  });

  it("credential weights split weighted round-robin traffic inside a provider", async () => {
    const harness = await setup([{ slug: "a", credentials: 3 }], {
      strategy: "weighted-round-robin",
    });
    const [first, , third] = harness.credentials.a!;
    await test.runtime.drivers.db
      .update(workspaceCredentials)
      .set({ weight: 3 })
      .where(eq(workspaceCredentials.id, first!));
    await test.runtime.drivers.db
      .update(workspaceCredentials)
      .set({ weight: 0 })
      .where(eq(workspaceCredentials.id, third!));
    const picks = [];
    for (let attempt = 0; attempt < 8; attempt++) picks.push(await pick(harness));
    expect(picks.filter((name) => name === "a#1")).toHaveLength(6);
    expect(picks.filter((name) => name === "a#2")).toHaveLength(2);
    expect(await pick(harness, { excluded: ["a#1", "a#2"] })).toMatchObject({ ok: false });
  });

  it("session affinity binds a conversation to one credential", async () => {
    const harness = await setup([{ slug: "a", credentials: 2 }], { sessionAffinity: true });
    const bound = await pick(harness, { session: "chat:1" });
    const other = bound === "a#1" ? "a#2" : "a#1";
    expect(await pick(harness)).toBe(other);
    expect(await pick(harness, { session: "chat:1" })).toBe(bound);
    expect(await pick(harness, { session: "chat:1" })).toBe(bound);

    // Under the default `any` policy a failure moves the binding to the failover credential.
    await report(harness, bound as string, transientFailure, { session: "chat:1" });
    expect(await pick(harness, { session: "chat:1" })).toBe(other);
    await clearCooldowns(harness);
    expect(await pick(harness, { session: "chat:1" })).toBe(other);
  });
});

describe("routing pick", () => {
  it("round-robin rotates within the top priority tier and skips tried providers", async () => {
    const harness = await setup([{ slug: "a" }, { slug: "b" }, { slug: "backup", priority: -1 }]);
    expect([await pick(harness), await pick(harness), await pick(harness)]).toEqual([
      "a",
      "b",
      "a",
    ]);
    expect(await pick(harness, { excluded: ["a"] })).toBe("b");
    expect(await pick(harness, { excluded: ["a", "b"] })).toBe("backup");
    expect(await pick(harness, { excluded: ["a", "b", "backup"] })).toMatchObject({
      ok: false,
      retryAfterMs: 0,
    });
  });

  it("cooldowns exclude providers until a newer success clears them", async () => {
    const harness = await setup([{ slug: "a" }, { slug: "b" }], { strategy: "fill-first" });
    const dispatchedBeforeFailure = Date.now() - 1000;
    await report(harness, "a", transientFailure);
    expect(await pick(harness)).toBe("b");

    // A success dispatched before the failure was recorded must not clear its cooldown.
    await report(harness, "a", { type: "success" }, { dispatchedAt: dispatchedBeforeFailure });
    expect(await pick(harness)).toBe("b");

    await report(harness, "b", transientFailure);
    const exhausted = await pick(harness);
    expect(exhausted).toMatchObject({ ok: false });
    expect((exhausted as { retryAfterMs: number }).retryAfterMs).toBeGreaterThan(55_000);

    await report(harness, "a", { type: "success" }, { dispatchedAt: Date.now() + 1 });
    expect(await pick(harness)).toBe("a");
  });

  it("session affinity reuses the bound provider and rebinds per the configured policy", async () => {
    const quota = await setup([{ slug: "a" }, { slug: "b" }], {
      sessionAffinity: true,
      sessionAffinityRebindOn: "quota",
    });
    expect(await pick(quota, { session: "chat:1" })).toBe("a");
    expect(await pick(quota)).toBe("b");
    expect(await pick(quota, { session: "chat:1" })).toBe("a");
    await report(quota, "a", transientFailure, { session: "chat:1" });
    expect(await pick(quota, { session: "chat:1" })).toBe("b");
    await clearCooldowns(quota);
    expect(await pick(quota, { session: "chat:1" })).toBe("a");

    const any = await setup([{ slug: "a" }, { slug: "b" }], {
      sessionAffinity: true,
      sessionAffinityRebindOn: "any",
    });
    expect(await pick(any, { session: "chat:1" })).toBe("a");
    await report(any, "a", transientFailure, { session: "chat:1" });
    expect(await pick(any, { session: "chat:1" })).toBe("b");
    await clearCooldowns(any);
    expect(await pick(any, { session: "chat:1" })).toBe("b");
  });

  it("a pinned provider that cannot serve the model is a configuration error", async () => {
    const harness = await setup([{ slug: "a" }]);
    await expect(
      pickRoute(test.runtime, {
        workspace: harness.workspace,
        model: MODEL,
        preferences: { only: ["missing"], allowFallbacks: false },
        excluded: [],
      }),
    ).rejects.toThrow(new RoutingConfigurationError("Model test-model is not available on provider missing."));
    await expect(
      pickRoute(test.runtime, {
        workspace: harness.workspace,
        model: "unknown-model",
        preferences: { allowFallbacks: true },
        excluded: [],
      }),
    ).rejects.toThrow("Unknown model: unknown-model");
  });

  it("lists cooldowns for the owner and resets one or all of a provider's", async () => {
    const harness = await setup([{ slug: "a", credentials: 2 }, { slug: "b" }]);
    await report(harness, "a#1", transientFailure);
    await report(harness, "a#2", unauthorizedFailure);
    await report(harness, "b", transientFailure);
    const { kv } = test.runtime.drivers;
    const listed = await getRoutingConfiguration(test.runtime.drivers.db, kv, harness.workspace);
    expect(listed.cooldowns).toHaveLength(3);
    const credentialWide = listed.cooldowns.find((cooldown) => cooldown.reason === "unauthorized")!;
    // Unauthorized cools the whole credential (model ""); transient only the model.
    expect(credentialWide).toMatchObject({ provider: "a", model: "", credentialName: "****1" });

    // A cooldown id of another provider is ignored.
    await resetCooldown(kv, harness.workspace, { provider: "b", cooldown: credentialWide.id });
    expect(
      (await getRoutingConfiguration(test.runtime.drivers.db, kv, harness.workspace)).cooldowns,
    ).toHaveLength(3);
    await resetCooldown(kv, harness.workspace, { provider: "a", cooldown: credentialWide.id });
    await resetCooldown(kv, harness.workspace, { provider: "b" });
    const remaining = (await getRoutingConfiguration(test.runtime.drivers.db, kv, harness.workspace))
      .cooldowns;
    expect(remaining.map((cooldown) => [cooldown.provider, cooldown.reason])).toEqual([
      ["a", "transient"],
    ]);
    // Every state key expires: cursors by key TTL, cooldowns and bindings by field TTL.
    const ttl = await kv.send("HPTTL", [
      `routing:cooldowns:${harness.workspace}`,
      "FIELDS",
      "1",
      remaining[0]!.id,
    ]);
    expect(Number((ttl as unknown[])[0])).toBeGreaterThan(24 * 60 * 60 * 1000);
  });
});

describe("credential-wide quota windows", () => {
  it("outlive unrelated successes until they end", async () => {
    const harness = await setup([{ slug: "a" }, { slug: "b" }], { strategy: "fill-first" });
    await report(harness, "a", { ...quotaFailure, retryAfterMs: 120_000 });
    expect(await pick(harness)).toBe("b");
    // A later success of the same credential does not lift an active credential-wide window.
    await report(harness, "a", { type: "success" }, { dispatchedAt: Date.now() + 1 });
    expect(await pick(harness)).toBe("b");
    const { cooldowns } = await getRoutingConfiguration(
      test.runtime.drivers.db,
      test.runtime.drivers.kv,
      harness.workspace,
    );
    expect(cooldowns).toMatchObject([{ provider: "a", model: "", reason: "quota" }]);
  });
});

describe("routing state under concurrency", () => {
  it("parallel round-robin picks never reuse a stale cursor", async () => {
    const harness = await setup([{ slug: "a" }, { slug: "b" }]);
    const picks = await Promise.all(Array.from({ length: 20 }, () => pick(harness)));
    expect(picks.filter((name) => name === "a")).toHaveLength(10);
    expect(picks.filter((name) => name === "b")).toHaveLength(10);
  });

  it("parallel weighted picks keep every smooth round-robin credit", async () => {
    const harness = await setup(
      [
        { slug: "a", weight: 3 },
        { slug: "b", weight: 1 },
      ],
      { strategy: "weighted-round-robin" },
    );
    const picks = await Promise.all(Array.from({ length: 40 }, () => pick(harness)));
    expect(picks.filter((name) => name === "a")).toHaveLength(30);
    expect(picks.filter((name) => name === "b")).toHaveLength(10);
  });
});
