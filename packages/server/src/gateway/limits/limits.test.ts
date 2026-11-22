import { and, eq } from "drizzle-orm";
import type { Meter } from "contracts/limits/meters";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestRuntime, type TestRuntime } from "../../../test/runtime";
import { classicUser } from "../../../test/users";
import { dispatchJobs } from "../../jobs/outbox";
import { jobs } from "../../jobs/schema";
import { notifications } from "../../notifications/schema";
import { router } from "../../trpc/init";
import { chatCompletions } from "../../usage/schema";
import { userPreferences, workspaceMembers, workspaces } from "../../workspaces/schema";
import { limitKeySecretName, type CredentialRow } from "../credentials";
import {
  authors,
  credentialLimits,
  limitEvents,
  models,
  workspaceCredentials,
  workspaceProviders,
} from "../schema";
import { getSecret, putSecret, workspaceProviderSecretNamespace } from "../secrets";
import { pruneLimitEvents } from "./events";
import { limitsRouter } from "./router";
import { claimDuePolls, pollDueCredentials, refreshCredentialLimits } from "./poll";
import {
  ensureCredentialLimits,
  recordAttemptLimits,
  recordLoginPlan,
  scheduleBudgetRefresh,
} from "./store";

// The Limits domain against real Postgres and Valkey: owner-only boundaries of every procedure,
// the behavior of the Convex `limits.test.ts`, and the invariants that relied on Convex
// serializing mutations (poll claims, refresh rate limit, budget debounce, snapshot updates).
// Upstream HTTP is `runtime.fetch`, stubbed per test.

const testRouter = router({ limits: limitsRouter });
const HOUR = 60 * 60 * 1000;
const keyBody = { data: { limit: 10, limit_remaining: 1.5, limit_reset: "daily", usage: 8.5 } };

type Role = "owner" | "member" | "outsider";

let test: TestRuntime;
const users = {} as Record<Role, { id: string; headers: Headers }>;
const fetchMock = vi.fn();
let counter = 0;
let modelId = "";

const db = () => test.runtime.drivers.db;
const callAs = (headers: Headers) => testRouter.createCaller({ runtime: test.runtime, headers });
const call = (role: Role) => callAs(users[role].headers);

beforeAll(async () => {
  test = await createTestRuntime();
  for (const role of ["owner", "member", "outsider"] as const) {
    users[role] = await classicUser(test.runtime, `${role}@limits.test`);
  }
  const [author] = await db().insert(authors).values({ name: "Test", slug: "test" }).returning();
  const [model] = await db()
    .insert(models)
    .values({
      name: "Model",
      launchDate: new Date(0),
      author: author!.id,
      slug: "test/model",
      type: "chat",
      description: "",
      reasoning: false,
      architecture: { input_modalities: ["text"], output_modalities: ["text"], tokenizer: "GPT" },
    })
    .returning();
  modelId = model!.id;
});

afterAll(async () => {
  await test.close();
});

beforeEach(() => {
  fetchMock.mockReset();
  test.runtime.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
});

const openRouterSnapshot = {
  slug: "openrouter",
  name: "OpenRouter",
  npm: "@openrouter/ai-sdk-provider" as const,
  env: ["OPENROUTER_API_KEY"],
  models: [],
};
const plainSnapshot = {
  slug: "plain",
  name: "Plain",
  npm: "@ai-sdk/openai-compatible" as const,
  env: ["API_KEY"],
  api: "https://upstream.example.test/v1",
  models: [],
};

/** A credential of `workspace` with its stored values and snapshot row, as creation leaves it. */
async function addCredential(
  workspace: string,
  provider: "openrouter" | "plain",
  label: string,
  options: { secret?: boolean } = {},
): Promise<CredentialRow> {
  counter += 1;
  const secretName = `credential-${counter}`;
  const [credential] = await db()
    .insert(workspaceCredentials)
    .values({ workspace, provider, preview: { KEY: "****1234" }, label, secretName })
    .returning();
  if (options.secret !== false) {
    const values =
      provider === "openrouter"
        ? { OPENROUTER_API_KEY: "sk-or-inference-1234" }
        : { API_KEY: "plain-key" };
    await putSecret(
      db(),
      test.runtime.secrets,
      { namespace: workspaceProviderSecretNamespace(workspace, provider), name: secretName },
      JSON.stringify(values),
    );
  }
  await ensureCredentialLimits(db(), credential!);
  return credential!;
}

/** A workspace owned by the owner (member added) with an OpenRouter and a plain credential. */
async function fresh(overrides: Partial<typeof workspaces.$inferInsert> = {}) {
  // Rows of earlier tests must not be due: a poll run claims every due row of the database.
  await db().update(credentialLimits).set({ nextPollAt: null });
  const [workspace] = await db()
    .insert(workspaces)
    .values({ ownerId: users.owner.id, name: "Limits workspace", ...overrides })
    .returning();
  const id = workspace!.id;
  await db()
    .insert(workspaceMembers)
    .values({ workspace: id, userId: users.member.id, role: "member" });
  for (const snapshot of [openRouterSnapshot, plainSnapshot]) {
    await db()
      .insert(workspaceProviders)
      .values({ workspace: id, provider: snapshot.slug, enabled: true, active: true, snapshot });
  }
  const openrouter = await addCredential(id, "openrouter", "Work key");
  const plain = await addCredential(id, "plain", "Plain key");
  return { workspace: id, openrouter, plain };
}

type Harness = Awaited<ReturnType<typeof fresh>>;

function weekly(used: number, resetsAt: number): Meter {
  return {
    id: "codex:secondary",
    label: "Weekly",
    scope: "credential",
    unit: "percent",
    used,
    windowSeconds: 7 * 24 * 3600,
    resetsAt,
    source: "header",
    observedAt: Date.now(),
  };
}

/** Reports one attempt on `credential`; `step` spaces the attempts' clocks one second apart. */
let clock = Date.now();
async function report(
  credential: CredentialRow,
  outcome: { type: "success" } | { type: "failure"; status: number },
  meters?: Meter[],
) {
  clock += 1000;
  await recordAttemptLimits(
    test.runtime,
    {
      credential: credential.id,
      ...(meters ? { observation: { meters } } : {}),
      outcome:
        outcome.type === "success"
          ? outcome
          : { ...outcome, message: `Upstream returned ${outcome.status}` },
    },
    clock,
  );
}

async function eventKinds(workspace: string) {
  const events = await call("owner").limits.listEvents({ workspace });
  return events.map((event) => event.kind).reverse();
}

async function limitRow(credential: string) {
  const [row] = await db()
    .select()
    .from(credentialLimits)
    .where(eq(credentialLimits.credential, credential));
  return row;
}

async function makeDue(credential: string) {
  await db()
    .update(credentialLimits)
    .set({ nextPollAt: new Date(Date.now() - 1) })
    .where(eq(credentialLimits.credential, credential));
}

async function addCompletion(workspace: string, credential: string, cost: number | null) {
  await db()
    .insert(chatCompletions)
    .values({
      workspace,
      provider: "plain",
      credential,
      byok: true,
      model: modelId,
      streamed: false,
      canceled: false,
      genId: "gen",
      providerGenId: "upstream",
      promptTokens: 10,
      completionTokens: 10,
      usageDetails: { completion_tokens_details: {}, prompt_tokens_details: {} },
      cost,
      pricingDetails: { prompt_tokens_details: {} },
      ttft: 1,
      genTime: 1,
      finishReason: "stop",
    });
}

describe("authorization boundaries", () => {
  type Target = { workspace: string; credential: string };
  const procedures: Array<[string, (headers: Headers, target: Target) => Promise<unknown>]> = [
    ["list", (h, t) => callAs(h).limits.list({ workspace: t.workspace })],
    ["listEvents", (h, t) => callAs(h).limits.listEvents({ workspace: t.workspace })],
    ["getSettings", (h, t) => callAs(h).limits.getSettings({ workspace: t.workspace })],
    [
      "setSettings",
      (h, t) =>
        callAs(h).limits.setSettings({
          workspace: t.workspace,
          settings: { warnPercent: 50, criticalPercent: 90, lowBalance: 1 },
        }),
    ],
    [
      "setBudget",
      (h, t) =>
        callAs(h).limits.setBudget({
          workspace: t.workspace,
          credential: t.credential,
          budget: { amount: 5, period: "day" },
        }),
    ],
    ["setLimitKey", (h, t) => callAs(h).limits.setLimitKey({ ...t, key: "k" })],
    ["refresh", (h, t) => callAs(h).limits.refresh(t)],
  ];

  for (const [name, run] of procedures) {
    it(`${name}: members, outsiders and archived workspaces get NOT_FOUND`, async () => {
      const active = await fresh();
      const archived = await fresh({ archivedAt: new Date() });
      const target = { workspace: active.workspace, credential: active.openrouter.id };

      await expect(run(users.member.headers, target)).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(run(users.outsider.headers, target)).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      await expect(
        run(users.owner.headers, {
          workspace: archived.workspace,
          credential: archived.openrouter.id,
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(run(new Headers(), target)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    });
  }

  it("a credential of another workspace is NOT_FOUND to its owner", async () => {
    const mine = await fresh();
    const other = await fresh();
    const input = { workspace: mine.workspace, credential: other.openrouter.id };
    await expect(call("owner").limits.setBudget({ ...input, budget: null })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(call("owner").limits.setLimitKey({ ...input, key: "k" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(call("owner").limits.refresh(input)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("owner API", () => {
  it("settings default and validate", async () => {
    const { workspace } = await fresh();
    const owner = call("owner");
    expect(await owner.limits.getSettings({ workspace })).toEqual({
      warnPercent: 80,
      criticalPercent: 95,
      lowBalance: 5,
    });
    for (const settings of [
      { warnPercent: 0, criticalPercent: 90, lowBalance: 1 },
      { warnPercent: 90, criticalPercent: 90, lowBalance: 1 },
      { warnPercent: 50, criticalPercent: 101, lowBalance: 1 },
      { warnPercent: 50, criticalPercent: 90, lowBalance: -1 },
      { warnPercent: 50, criticalPercent: Infinity, lowBalance: 1 },
    ]) {
      await expect(owner.limits.setSettings({ workspace, settings })).rejects.toThrow();
    }
    const settings = { warnPercent: 60, criticalPercent: 90, lowBalance: 2 };
    await owner.limits.setSettings({ workspace, settings });
    expect(await owner.limits.getSettings({ workspace })).toEqual(settings);
  });

  it("list returns every pooled credential with adapter capabilities", async () => {
    const { workspace, openrouter, plain } = await fresh();
    const list = await call("owner").limits.list({ workspace });
    expect(list).toEqual([
      expect.objectContaining({
        credential: openrouter.id,
        provider: "openrouter",
        providerName: "OpenRouter",
        credentialName: "Work key",
        enabled: true,
        plan: null,
        meters: [],
        pollable: true,
        polledAt: null,
        nextPollAt: expect.any(Number),
        pollError: null,
        budget: null,
        limitKey: expect.objectContaining({ label: "Management key", preview: null }),
      }),
      expect.objectContaining({
        credential: plain.id,
        provider: "plain",
        pollable: false,
        nextPollAt: null,
        limitKey: null,
      }),
    ]);
  });

  it("listEvents clamps its limit", async () => {
    const { workspace, plain } = await fresh();
    await report(plain, { type: "failure", status: 401 });
    await report(plain, { type: "success" });
    const owner = call("owner");
    expect(await owner.limits.listEvents({ workspace, limit: 1 })).toHaveLength(1);
    expect(await owner.limits.listEvents({ workspace, limit: 0 })).toHaveLength(1);
    expect(await owner.limits.listEvents({ workspace, limit: 10_000 })).toHaveLength(2);
  });

  it("recordLoginPlan stores the plan an OAuth login reported", async () => {
    const { workspace, plain } = await fresh();
    await recordLoginPlan(db(), plain.id, "plus");
    const [entry] = (await call("owner").limits.list({ workspace })).filter(
      (item) => item.credential === plain.id,
    );
    expect(entry?.plan).toBe("plus");
  });

  it("ensureCredentialLimits is idempotent and schedules only pollable providers", async () => {
    const { openrouter, plain } = await fresh();
    await ensureCredentialLimits(db(), openrouter);
    expect((await limitRow(openrouter.id))?.nextPollAt).toBeInstanceOf(Date);
    expect((await limitRow(plain.id))?.nextPollAt).toBeNull();
    const rows = await db()
      .select()
      .from(credentialLimits)
      .where(eq(credentialLimits.credential, openrouter.id));
    expect(rows).toHaveLength(1);
  });
});

describe("passive capture through attempt reports", () => {
  it("thresholds fire once with hysteresis and reset on a new window", async () => {
    const { workspace, plain } = await fresh();
    const resetsAt = Date.now() + 72 * HOUR;
    for (const used of [50, 82, 79, 83, 96]) {
      await report(plain, { type: "success" }, [weekly(used, resetsAt)]);
    }
    expect(await eventKinds(workspace)).toEqual(["limit_low", "limit_critical"]);

    await report(plain, { type: "success" }, [weekly(2, resetsAt + 7 * 24 * HOUR)]);
    expect(await eventKinds(workspace)).toEqual(["limit_low", "limit_critical", "limit_reset"]);

    const [event] = await call("owner").limits.listEvents({ workspace, limit: 1 });
    expect(event).toMatchObject({
      kind: "limit_reset",
      credential: plain.id,
      credentialName: "Plain key",
      previous: expect.objectContaining({ used: 96 }),
      meter: expect.objectContaining({ used: 2 }),
    });
    const row = await limitRow(plain.id);
    expect(row?.meters).toEqual([expect.objectContaining({ id: "codex:secondary", used: 2 })]);
    expect(row?.passiveAt).toBeInstanceOf(Date);

    // Each event notified the workspace owner, and only the owner.
    const rows = await db()
      .select()
      .from(notifications)
      .where(eq(notifications.workspace, workspace));
    expect(rows.map((row) => row.kind).sort()).toEqual([
      "limit_critical",
      "limit_low",
      "limit_reset",
    ]);
    expect(rows.every((row) => row.userId === users.owner.id && row.sealedBox === null)).toBe(true);
  });

  it("unauthorized attempts expire the credential once; the next success restores it", async () => {
    const { workspace, plain } = await fresh();
    await report(plain, { type: "failure", status: 401 });
    await report(plain, { type: "failure", status: 401 });
    await report(plain, { type: "failure", status: 500 });
    expect(await eventKinds(workspace)).toEqual(["credential_expired"]);
    await report(plain, { type: "success" });
    await report(plain, { type: "success" });
    expect(await eventKinds(workspace)).toEqual(["credential_expired", "credential_restored"]);

    const events = await db()
      .select()
      .from(limitEvents)
      .where(eq(limitEvents.workspace, workspace));
    expect(events.find((event) => event.kind === "credential_expired")).toMatchObject({
      status: 401,
      providerName: "Plain",
      credentialName: "Plain key",
      settingsWarnPercent: 80,
    });
    expect((await limitRow(plain.id))?.expiredAt).toBeNull();
  });

  it("an attempt for a deleted credential records nothing", async () => {
    const { plain } = await fresh();
    await db().delete(workspaceCredentials).where(eq(workspaceCredentials.id, plain.id));
    await expect(report(plain, { type: "failure", status: 401 })).resolves.toBeUndefined();
    expect(await limitRow(plain.id)).toBeUndefined();
  });

  it("concurrent reports of different meters all apply", async () => {
    const { plain } = await fresh();
    const resetsAt = Date.now() + 72 * HOUR;
    const ids = Array.from({ length: 12 }, (_, index) => `codex:window-${index}`);
    clock += 1000;
    await Promise.all(
      ids.map((id) =>
        recordAttemptLimits(
          test.runtime,
          {
            credential: plain.id,
            observation: { meters: [{ ...weekly(10, resetsAt), id }] },
            outcome: { type: "success" },
          },
          clock,
        ),
      ),
    );
    const meters = ((await limitRow(plain.id))?.meters ?? []).map((meter) => meter.id).sort();
    expect(meters).toEqual(ids.sort());
  });

  it("a user who switched limit notifications off still gets the event but no notification", async () => {
    const { workspace, plain } = await fresh();
    await db()
      .insert(userPreferences)
      .values({
        userId: users.owner.id,
        notifications: { limits: { enabled: false, sound: false } },
      })
      .onConflictDoUpdate({
        target: userPreferences.userId,
        set: { notifications: { limits: { enabled: false, sound: false } } },
      });
    try {
      await report(plain, { type: "failure", status: 401 });
      expect(await eventKinds(workspace)).toEqual(["credential_expired"]);
      const rows = await db()
        .select()
        .from(notifications)
        .where(eq(notifications.workspace, workspace));
      expect(rows).toEqual([]);
    } finally {
      await db().delete(userPreferences).where(eq(userPreferences.userId, users.owner.id));
    }
  });
});

describe("metered budgets", () => {
  async function runBudgetJob(credential: CredentialRow) {
    const [fresh] = await db()
      .select()
      .from(workspaceCredentials)
      .where(eq(workspaceCredentials.id, credential.id));
    // Due now: the 5 s debounce is the job's `runAt`.
    const id = await db().transaction((tx) =>
      scheduleBudgetRefresh(tx, fresh!, Date.now() - 10_000),
    );
    await dispatchJobs(test.runtime, [id]);
  }

  it("sums Radium's recorded cost for the period and fires thresholds", async () => {
    const { workspace, plain } = await fresh();
    const owner = call("owner");
    await expect(
      owner.limits.setBudget({
        workspace,
        credential: plain.id,
        budget: { amount: 0, period: "month" },
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("greater than 0"),
    });

    await addCompletion(workspace, plain.id, 0.5);
    await owner.limits.setBudget({
      workspace,
      credential: plain.id,
      budget: { amount: 1, period: "month" },
    });
    const entryOf = async () =>
      (await owner.limits.list({ workspace })).find((item) => item.credential === plain.id)!;
    let entry = await entryOf();
    expect(entry.budget).toEqual({ amount: 1, period: "month" });
    expect(entry.meters).toEqual([
      expect.objectContaining({
        id: "budget",
        label: "Budget (month)",
        unit: "usd",
        used: 0.5,
        limit: 1,
        source: "metered",
      }),
    ]);

    await addCompletion(workspace, plain.id, 0.46);
    await runBudgetJob(plain);
    entry = await entryOf();
    expect(entry.meters[0]!.used).toBeCloseTo(0.96);
    expect(await eventKinds(workspace)).toEqual(["limit_critical"]);
    expect((await limitRow(plain.id))?.budgetPendingAt).toBeNull();

    // A completion of unknown cost makes the sum partial: no meter rather than a wrong one.
    await addCompletion(workspace, plain.id, null);
    await runBudgetJob(plain);
    expect((await entryOf()).meters).toEqual([]);

    await owner.limits.setBudget({ workspace, credential: plain.id, budget: null });
    entry = await entryOf();
    expect(entry.meters).toEqual([]);
    expect(entry.budget).toBeNull();
  });

  it("a budget mark whose job was lost is recomputed by the poll task", async () => {
    const { workspace, plain } = await fresh();
    await call("owner").limits.setBudget({
      workspace,
      credential: plain.id,
      budget: { amount: 10, period: "month" },
    });
    await addCompletion(workspace, plain.id, 2);
    await db()
      .update(credentialLimits)
      .set({ budgetPendingAt: new Date(Date.now() - 2 * 60_000) })
      .where(eq(credentialLimits.credential, plain.id));

    await pollDueCredentials(test.runtime);

    const row = await limitRow(plain.id);
    expect(row?.budgetPendingAt).toBeNull();
    expect(row?.meters).toEqual([expect.objectContaining({ id: "budget", used: 2 })]);
  });

  it("an ended budget period rolls over in the poll task", async () => {
    const { workspace, plain } = await fresh();
    await call("owner").limits.setBudget({
      workspace,
      credential: plain.id,
      budget: { amount: 10, period: "day" },
    });
    await db()
      .update(credentialLimits)
      .set({ budgetResetsAt: new Date(Date.now() - 1000) })
      .where(eq(credentialLimits.credential, plain.id));

    await pollDueCredentials(test.runtime);

    const row = await limitRow(plain.id);
    expect(row!.budgetResetsAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it("without a budget, scheduling queues nothing", async () => {
    const { plain } = await fresh();
    expect(await db().transaction((tx) => scheduleBudgetRefresh(tx, plain))).toBeNull();
  });
});

describe("limit keys and cleanup", () => {
  const location = (h: Harness) => ({
    namespace: workspaceProviderSecretNamespace(h.workspace, "openrouter"),
    name: limitKeySecretName(h.openrouter.id),
  });

  it("limit keys exist only where the adapter declares one", async () => {
    const h = await fresh();
    const owner = call("owner");
    await expect(
      owner.limits.setLimitKey({ workspace: h.workspace, credential: h.plain.id, key: "k" }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("no separate limit key"),
    });
    await expect(
      owner.limits.setLimitKey({ workspace: h.workspace, credential: h.openrouter.id, key: "  " }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await owner.limits.setLimitKey({
      workspace: h.workspace,
      credential: h.openrouter.id,
      key: " sk-or-management-9876 ",
    });
    const entry = (await owner.limits.list({ workspace: h.workspace }))[0]!;
    expect(entry.limitKey).toMatchObject({ label: "Management key", preview: "****9876" });
    expect(await getSecret(db(), test.runtime.secrets, location(h))).toMatchObject({
      ok: true,
      value: "sk-or-management-9876",
    });

    // The credits meter the key feeds goes with it.
    await db()
      .update(credentialLimits)
      .set({
        meters: [
          {
            id: "openrouter:credits",
            label: "Account balance",
            scope: "account",
            unit: "usd",
            remaining: 3,
            source: "poll",
            observedAt: Date.now(),
          },
        ],
      })
      .where(eq(credentialLimits.credential, h.openrouter.id));
    await owner.limits.setLimitKey({
      workspace: h.workspace,
      credential: h.openrouter.id,
      key: null,
    });
    const cleared = (await owner.limits.list({ workspace: h.workspace }))[0]!;
    expect(cleared.limitKey?.preview).toBeNull();
    expect(cleared.meters).toEqual([]);
    expect((await getSecret(db(), test.runtime.secrets, location(h))).ok).toBe(false);
  });

  it("deleting a credential removes its snapshot but keeps its events", async () => {
    const h = await fresh();
    await report(h.openrouter, { type: "failure", status: 401 });
    expect(await limitRow(h.openrouter.id)).toBeDefined();

    await db().delete(workspaceCredentials).where(eq(workspaceCredentials.id, h.openrouter.id));

    expect(await limitRow(h.openrouter.id)).toBeUndefined();
    expect(await call("owner").limits.listEvents({ workspace: h.workspace })).toEqual([
      expect.objectContaining({
        kind: "credential_expired",
        credential: null,
        credentialName: "Work key",
      }),
    ]);
  });

  it("retention deletes events older than 30 days in bounded batches, with their notifications", async () => {
    const h = await fresh();
    await report(h.plain, { type: "failure", status: 401 });
    const now = Date.now();
    const [event] = await db()
      .select()
      .from(limitEvents)
      .where(eq(limitEvents.workspace, h.workspace));
    const old = new Date(now - 31 * 24 * HOUR);
    await db()
      .insert(limitEvents)
      .values({ ...event!, id: undefined, occurredAt: old });
    await db()
      .insert(limitEvents)
      .values({ ...event!, id: undefined, occurredAt: old });

    expect(await pruneLimitEvents(db(), now, 1)).toBe(1);
    expect(await pruneLimitEvents(db(), now, 10)).toBe(1);
    expect(await pruneLimitEvents(db(), now, 10)).toBe(0);
    const rest = await db()
      .select()
      .from(limitEvents)
      .where(eq(limitEvents.workspace, h.workspace));
    expect(rest.map((row) => row.id)).toEqual([event!.id]);
  });
});

describe("polling", () => {
  it("owner refresh polls now, at most once a minute, only for pollable providers", async () => {
    const { workspace, openrouter, plain } = await fresh();
    const owner = call("owner");
    fetchMock.mockResolvedValue(Response.json(keyBody));

    await owner.limits.refresh({ workspace, credential: openrouter.id });
    const entry = (await owner.limits.list({ workspace }))[0]!;
    expect(entry.meters).toEqual([
      expect.objectContaining({ id: "openrouter:key", limit: 10, used: 8.5, source: "poll" }),
    ]);
    expect(entry.polledAt).toEqual(expect.any(Number));
    expect(await eventKinds(workspace)).toEqual(["limit_low"]);

    await expect(
      owner.limits.refresh({ workspace, credential: openrouter.id }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("Refreshed too recently"),
    });
    await expect(owner.limits.refresh({ workspace, credential: plain.id })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("no usage endpoint"),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refresh refuses a credential whose stored values are unreadable", async () => {
    const { workspace } = await fresh();
    const bare = await addCredential(workspace, "openrouter", "No secret", { secret: false });
    await expect(
      call("owner").limits.refresh({ workspace, credential: bare.id }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("unreadable"),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a rejected management key keeps the balance and stores a partial poll error", async () => {
    const { workspace, openrouter } = await fresh();
    const owner = call("owner");
    await owner.limits.setLimitKey({ workspace, credential: openrouter.id, key: "bad-key" });
    fetchMock.mockImplementation(async (url: string) =>
      url.endsWith("/key")
        ? Response.json(keyBody)
        : Response.json({ error: "Forbidden" }, { status: 403 }),
    );
    await owner.limits.refresh({ workspace, credential: openrouter.id });
    const entry = (await owner.limits.list({ workspace }))[0]!;
    expect(entry.pollError).toMatchObject({ status: 403 });
    expect(entry.meters.map((meter) => meter.id)).toEqual(["openrouter:key"]);
  });

  it("scheduled polls back off on errors, fire one poll_failed per streak, and expire on 401", async () => {
    const { workspace, openrouter } = await fresh();

    fetchMock.mockImplementation(async () => new Response("Internal error", { status: 500 }));
    await pollDueCredentials(test.runtime);
    let row = await limitRow(openrouter.id);
    expect(row).toMatchObject({ pollErrorStatus: 500, pollFailures: 1 });
    expect(row!.nextPollAt!.getTime() - Date.now()).toBeGreaterThan(4 * 60_000);
    expect(row!.pollAttemptAt).toBeInstanceOf(Date);

    await makeDue(openrouter.id);
    await pollDueCredentials(test.runtime);
    row = await limitRow(openrouter.id);
    expect(row?.pollFailures).toBe(2);
    expect(row!.nextPollAt!.getTime() - Date.now()).toBeGreaterThan(9 * 60_000);
    expect(await eventKinds(workspace)).toEqual(["poll_failed"]);

    await makeDue(openrouter.id);
    fetchMock.mockImplementation(async () => new Response("Unauthorized", { status: 401 }));
    await pollDueCredentials(test.runtime);
    expect(await eventKinds(workspace)).toEqual(["poll_failed", "credential_expired"]);

    await makeDue(openrouter.id);
    fetchMock.mockImplementation(async () => Response.json(keyBody));
    await pollDueCredentials(test.runtime);
    row = await limitRow(openrouter.id);
    expect(row?.pollErrorMessage).toBeNull();
    expect(row?.pollFailures).toBe(0);
    // One update records both; their order within it is not observable.
    expect((await eventKinds(workspace)).slice(0, 2)).toEqual([
      "poll_failed",
      "credential_expired",
    ]);
    expect((await eventKinds(workspace)).slice(2).sort()).toEqual([
      "credential_restored",
      "limit_low",
    ]);
  });

  it("fresh passive data defers a scheduled poll", async () => {
    const { openrouter } = await fresh();
    await db()
      .update(credentialLimits)
      .set({ passiveAt: new Date(Date.now() - 60_000) })
      .where(eq(credentialLimits.credential, openrouter.id));
    await pollDueCredentials(test.runtime);
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await limitRow(openrouter.id))!.nextPollAt!.getTime() - Date.now()).toBeGreaterThan(
      8 * 60_000,
    );
  });

  it("rows that cannot be polled are rescheduled instead of claimed", async () => {
    const { workspace, openrouter, plain } = await fresh();
    const noSecret = await addCredential(workspace, "openrouter", "No secret", { secret: false });
    await db()
      .update(workspaceCredentials)
      .set({ enabled: false })
      .where(eq(workspaceCredentials.id, openrouter.id));
    await Promise.all([plain.id, openrouter.id, noSecret.id].map(makeDue));

    await pollDueCredentials(test.runtime);

    expect(fetchMock).not.toHaveBeenCalled();
    // No pollable adapter: no longer scheduled. Disabled or unreadable: wait for their next slot.
    expect((await limitRow(plain.id))?.nextPollAt).toBeNull();
    for (const credential of [openrouter, noSecret]) {
      const row = await limitRow(credential.id);
      expect(row!.nextPollAt!.getTime() - Date.now()).toBeGreaterThan(4 * 60_000);
      expect(row?.pollAttemptAt).toBeNull();
    }
  });

  it("a claim leases the row for five minutes until the poll is recorded", async () => {
    const { openrouter } = await fresh();
    const { targets } = await claimDuePolls(test.runtime);
    expect(targets.map((target) => target.credential)).toContain(openrouter.id);
    const row = await limitRow(openrouter.id);
    expect(row!.nextPollAt!.getTime() - Date.now()).toBeGreaterThan(4 * 60_000);
    expect(row?.pollAttemptAt).toBeInstanceOf(Date);
    // Nothing is due while the lease holds.
    expect((await claimDuePolls(test.runtime)).targets).toEqual([]);
  });
});

describe("concurrency", () => {
  it("concurrent poll claims get disjoint rows", async () => {
    const { workspace } = await fresh();
    // Drain whatever earlier tests left due so only this test's rows are claimed.
    await db().update(credentialLimits).set({ nextPollAt: null });
    const created = await Promise.all(
      Array.from({ length: 60 }, (_, index) =>
        addCredential(workspace, "openrouter", `Pool ${index}`),
      ),
    );

    const claims = await Promise.all(Array.from({ length: 4 }, () => claimDuePolls(test.runtime)));

    const claimed = claims.flatMap((claim) => claim.targets.map((target) => target.credential));
    expect(new Set(claimed).size).toBe(claimed.length);
    expect(claimed.sort()).toEqual(created.map((credential) => credential.id).sort());
  });

  it("two concurrent owner refreshes poll once", async () => {
    const { workspace, openrouter } = await fresh();
    fetchMock.mockResolvedValue(Response.json(keyBody));

    const results = await Promise.allSettled([
      refreshCredentialLimits(test.runtime, workspace, openrouter.id),
      refreshCredentialLimits(test.runtime, workspace, openrouter.id),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const refused = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(refused.reason).toMatchObject({ code: "CONFLICT" });
  });

  it("concurrent budget schedules queue one job", async () => {
    const { workspace, plain } = await fresh();
    await call("owner").limits.setBudget({
      workspace,
      credential: plain.id,
      budget: { amount: 10, period: "month" },
    });
    const [budgeted] = await db()
      .select()
      .from(workspaceCredentials)
      .where(eq(workspaceCredentials.id, plain.id));

    const ids = await Promise.all(
      Array.from({ length: 8 }, () =>
        db().transaction((tx) => scheduleBudgetRefresh(tx, budgeted!)),
      ),
    );

    expect(ids.filter((id) => id !== null)).toHaveLength(1);
    const queued = await db()
      .select()
      .from(jobs)
      .where(and(eq(jobs.kind, "limits.budget"), eq(jobs.dedupeKey, `limits.budget:${plain.id}`)));
    expect(queued).toHaveLength(1);
    expect(queued[0]!.runAt.getTime()).toBeGreaterThan(Date.now());
    expect((await limitRow(plain.id))?.budgetPendingAt).toBeInstanceOf(Date);
  });
});
