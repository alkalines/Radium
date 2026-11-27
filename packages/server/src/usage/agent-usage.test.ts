import { and, asc, count, eq, sql } from "drizzle-orm";
import { utcDay } from "contracts/usage/local_contract";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { addProvider, offer } from "../../test/gateway";
import { createTestRuntime, type TestRuntime } from "../../test/runtime";
import {
  acpChat,
  claimedCommand,
  deferredWork,
  insertCompletion,
  usageUsers,
  usageWorkspace,
  type Role,
  type Users,
} from "../../test/usage";
import { acpAgents, acpAgentSessions, type acpSessions } from "../acp/schema";
import { chats } from "../chatroom/schema";
import { apiKeys } from "../gateway/schema";
import { dispatchJobs } from "../jobs/outbox";
import { jobs } from "../jobs/schema";
import { appRouter } from "../trpc/router";
import { projectFolders, projects } from "../workspaces/schema";
import { recordAcpTurn, type AcpTurnRecord } from "./agent-turns";
import {
  finishLocalUsageSync,
  listLocalUsageSyncs,
  localUsageCursor,
  reportLocalUsage,
  type LocalUsageReport,
} from "./local";
import { PRICE_TURN_JOB, resolveModelPrices } from "./prices";
import { acpModelPrices, acpUsage, localUsage } from "./schema";

// Agent usage against real Postgres: ACP turn recording and pricing (workspace rates and
// models.dev), local CLI usage from Workers, their reconciliation in Activity and the Session
// cost (Convex `acp.test.ts` usage cases), and the idempotency guards that replaced Convex's
// serialized mutations.

type Session = typeof acpSessions.$inferSelect;

let test: TestRuntime;
let users: Users;
let settle: () => Promise<void>;

const db = () => test.runtime.drivers.db;
const call = (role: Role) =>
  appRouter.createCaller({ runtime: test.runtime, headers: users[role].headers });

const sonnet = {
  id: "claude-sonnet-4-5",
  name: "Claude Sonnet 4.5",
  cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
};
const opus = { id: "claude-opus-4-1", name: "Claude Opus 4.1", cost: { input: 15, output: 0 } };

/** Stubs models.dev with `models` under `anthropic`; returns the fetch mock. */
function stubModelsDev(models: Record<string, unknown> = { [sonnet.id]: sonnet }) {
  const fetch = vi.fn(
    async () =>
      new Response(JSON.stringify({ anthropic: { id: "anthropic", name: "Anthropic", models } })),
  );
  test.runtime.fetch = fetch as unknown as typeof globalThis.fetch;
  return fetch;
}

beforeAll(async () => {
  test = await createTestRuntime();
  users = await usageUsers(test.runtime, "agent-usage");
  settle = deferredWork(test.runtime);
  test.runtime.fetch = (async () => {
    throw new Error("unexpected network call");
  }) as unknown as typeof fetch;
});

afterAll(async () => {
  await test?.close();
});

/** A workspace with an ACP chat of the owner on its Worker. */
async function acpWorkspace(options: { sessionId?: string; profile?: "native" | "gateway" } = {}) {
  const fixture = await usageWorkspace(test.runtime, users);
  const { chat, session } = await acpChat(test.runtime, {
    workspace: fixture.workspace,
    worker: fixture.worker,
    userId: users.owner.id,
    ...options,
  });
  return { ...fixture, chat, session };
}

/** One finished prompt turn reported with the turn-end patch, then its pricing job run. */
async function turn(
  session: Session,
  report: {
    tokens?: { inputTokens: number; outputTokens: number; totalTokens: number };
    model?: { id: string; name: string; description?: string };
    cost?: { amount: number; currency: string };
    now?: number;
    retries?: number;
  } = {},
) {
  const command = await claimedCommand(test.runtime, {
    workspace: session.workspace,
    worker: session.worker,
    chat: session.chat,
    issuedBy: users.owner.id,
  });
  const now = report.now ?? Date.now();
  const records: AcpTurnRecord[] = [];
  for (let attempt = 0; attempt <= (report.retries ?? 0); attempt++) {
    // A retried patch whose receipt was lost must not count the turn twice.
    const record = await db().transaction((tx) =>
      recordAcpTurn(
        tx,
        session,
        {
          command,
          startedAt: now - 1000,
          ...(report.model ? { model: report.model } : {}),
          ...(report.cost ? { cost: report.cost } : {}),
        },
        report.tokens ?? { inputTokens: 1_000_000, outputTokens: 100_000, totalTokens: 1_100_000 },
        "end_turn",
        now,
      ),
    );
    records.push(record);
    if (record.status === "recorded") await dispatchJobs(test.runtime, [record.job]);
  }
  await settle();
  return { command, records };
}

/** Runs the `usage:prices` task body, then the reprice jobs it queued. */
async function resolvePrices() {
  const resolved = await resolveModelPrices(test.runtime);
  await settle();
  return resolved;
}

async function turnsOf(chat: string) {
  return await db()
    .select()
    .from(acpUsage)
    .where(eq(acpUsage.chat, chat))
    .orderBy(asc(acpUsage.endedAt), asc(acpUsage.id));
}

const defaultModel = (description: string) => ({ id: "default", name: "Default", description });

describe("ACP turn usage", () => {
  it("is recorded once per prompt, priced from models.dev, and shown in Activity", async () => {
    const f = await acpWorkspace();
    const fetch = stubModelsDev();
    const model = defaultModel("Currently Claude Sonnet 4.5");
    // A subscription agent reports nothing spent; owners still see the list-price estimate.
    const cost = { amount: 0, currency: "USD" };

    const first = await turn(f.session, { model, cost, retries: 1 });
    expect(first.records.map((record) => record.status)).toEqual(["recorded", "duplicate"]);
    // The model was never looked up: the turn waits for the catalogue.
    expect((await turnsOf(f.chat))[0]!.pricing).toEqual({ status: "pending" });
    await expect(call("owner").usage.getChatCost({ chat: f.chat })).resolves.toMatchObject({
      steps: 1,
      pending: 1,
    });
    expect(await resolvePrices()).toBe(1);
    await turn(f.session, { model, cost, retries: 1 });
    // Nothing queued: no fetch.
    expect(await resolvePrices()).toBe(0);

    // One catalogue lookup serves every later turn of the same model.
    expect(fetch).toHaveBeenCalledOnce();
    const rows = await turnsOf(f.chat);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.pricing).toMatchObject({ status: "priced", source: "models.dev", reportedCost: 0 });
      expect(row.pricing.cost).toBeCloseTo(3 + 1.5);
      expect(row.priceKey).toBeNull();
    }
    const sessionCost = await call("owner").usage.getChatCost({ chat: f.chat });
    expect(sessionCost).toMatchObject({ steps: 2, unknown: 0, pending: 0 });
    expect(sessionCost.cost).toBeCloseTo(9);

    const all = await call("owner").usage.getActivity({ workspace: f.workspace, since: 0 });
    expect(all.summary).toMatchObject({ agentTurns: 2, requests: 0 });
    expect(all.summary.agentCost).toBeCloseTo(9);
    expect(all.harnesses).toMatchObject([
      { id: "acp:test-agent", kind: "agent", agentId: "test-agent", name: "test-agent", turns: 2 },
    ]);
    expect(all.projects).toMatchObject([{ id: "none", turns: 2 }]);
    expect(all.models).toMatchObject([{ name: "Claude Sonnet 4.5", turns: 2 }]);

    const gatewayOnly = await call("owner").usage.getActivity({
      workspace: f.workspace,
      since: 0,
      sources: "gateway",
    });
    expect(gatewayOnly.summary).toMatchObject({ agentTurns: 0, spend: 0 });

    // Another user's personal ACP chat stays out of the owner's Activity and Session cost.
    await db().update(chats).set({ userId: users.member.id }).where(eq(chats.id, f.chat));
    const hidden = await call("owner").usage.getActivity({ workspace: f.workspace, since: 0 });
    expect(hidden.summary.agentTurns).toBe(0);
    await expect(call("owner").usage.getChatCost({ chat: f.chat })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    const own = await call("member").usage.getChatCost({ chat: f.chat });
    expect(own.cost).toBeCloseTo(9);
  });

  it("re-matches a model choice whose description changed instead of pricing the old match", async () => {
    const f = await acpWorkspace();
    const fetch = stubModelsDev({ [sonnet.id]: { ...sonnet, cost: { input: 3, output: 0 } }, [opus.id]: opus });
    const tokens = { inputTokens: 1_000_000, outputTokens: 0, totalTokens: 1_000_000 };
    await turn(f.session, { tokens, model: defaultModel("Currently Claude Sonnet 4.5") });
    await resolvePrices();
    // The `default` alias now points at another model.
    await turn(f.session, { tokens, model: defaultModel("Currently Claude Opus 4.1") });
    await resolvePrices();

    expect(fetch).toHaveBeenCalledTimes(2);
    expect((await turnsOf(f.chat)).map((row) => [row.pricing.modelName, row.pricing.cost])).toEqual([
      ["Claude Sonnet 4.5", 3],
      ["Claude Opus 4.1", 15],
    ]);
  });

  it("prices from the workspace's own provider rates without a lookup", async () => {
    const f = await acpWorkspace();
    await addProvider(test.runtime, f.workspace, {
      slug: "anthropic",
      models: [offer("anthropic/claude-sonnet-4-5", { pricing: { input: "0.000003", output: "0.000015" } })],
    });
    await turn(f.session, { model: { id: "claude-sonnet-4.5", name: "Sonnet 4.5" } });
    const [row] = await turnsOf(f.chat);
    expect(row!.pricing).toMatchObject({
      status: "priced",
      source: "workspace",
      provider: "anthropic",
      slug: "anthropic/claude-sonnet-4-5",
    });
    expect(row!.pricing.cost).toBeCloseTo(4.5);
    // Workspace rates win before any models.dev lookup is queued.
    const [lookups] = await db().select({ n: count() }).from(acpModelPrices).where(eq(acpModelPrices.workspace, f.workspace));
    expect(lookups!.n).toBe(0);
  });

  it("falls back to the agent's USD cost and keeps other currencies unconverted", async () => {
    const f = await acpWorkspace();
    await turn(f.session, { cost: { amount: 7, currency: "usd" } });
    await turn(f.session, { cost: { amount: 5, currency: "EUR" } });
    const rows = await turnsOf(f.chat);
    expect(rows.map((row) => row.pricing)).toEqual([
      { status: "priced", reportedCost: 7, cost: 7 },
      { status: "unknown" },
    ]);
    expect(rows[1]).toMatchObject({ agentCostAmount: 5, agentCostCurrency: "EUR" });
  });

  it("ignores Gateway-profile sessions and commands that are not this chat's prompts", async () => {
    const gateway = await acpWorkspace({ profile: "gateway" });
    const { records } = await turn(gateway.session);
    expect(records).toEqual([{ status: "ignored" }]);
    expect(await turnsOf(gateway.chat)).toEqual([]);

    const f = await acpWorkspace();
    const other = await acpChat(test.runtime, {
      workspace: f.workspace,
      worker: f.worker,
      userId: users.owner.id,
    });
    const foreign = await claimedCommand(test.runtime, {
      workspace: f.workspace,
      worker: f.worker,
      chat: other.chat,
      issuedBy: users.owner.id,
    });
    const cancel = await claimedCommand(test.runtime, {
      workspace: f.workspace,
      worker: f.worker,
      chat: f.chat,
      issuedBy: users.owner.id,
      kind: "cancel",
    });
    for (const command of [foreign, cancel, "unknown-command"]) {
      await expect(
        db().transaction((tx) =>
          recordAcpTurn(tx, f.session, { command, startedAt: Date.now() }, undefined, undefined),
        ),
      ).resolves.toEqual({ status: "ignored" });
    }
    expect(await turnsOf(f.chat)).toEqual([]);
  });

  it("records a turn once when the Worker's retried patches race (unique key, on conflict)", async () => {
    const f = await acpWorkspace();
    const command = await claimedCommand(test.runtime, {
      workspace: f.workspace,
      worker: f.worker,
      chat: f.chat,
      issuedBy: users.owner.id,
    });
    const report = { command, startedAt: Date.now() };
    const records = await Promise.all(
      Array.from({ length: 5 }, () =>
        db().transaction(async (tx) => {
          const record = await recordAcpTurn(tx, f.session, report, undefined, "end_turn");
          // Real database concurrency: hold the transaction open so the other patches reach
          // their insert before it commits (fake timers cannot make Postgres overlap them).
          const { promise, resolve } = Promise.withResolvers<void>();
          setTimeout(resolve, 50);
          await promise;
          return record;
        }),
      ),
    );
    expect(records.map((record) => record.status).sort()).toEqual([
      "duplicate",
      "duplicate",
      "duplicate",
      "duplicate",
      "recorded",
    ]);
    expect(await turnsOf(f.chat)).toHaveLength(1);
    const recorded = records.find((record) => record.status === "recorded");
    if (recorded?.status !== "recorded") throw new Error("no turn was recorded");
    const [queued] = await db()
      .select({ n: count() })
      .from(jobs)
      .where(and(eq(jobs.kind, PRICE_TURN_JOB), sql`${jobs.payload}->>'turn' = ${recorded.turn}`));
    expect(queued!.n).toBe(1);
    await settle();
  });
});

/** A ccusage session-day row of `agent`. */
const localRow = (sessionId: string, cost?: number, model = "claude-sonnet-4-5") => ({
  agent: "opencode",
  sessionId,
  lastActivity: Date.now(),
  totalTokens: 1000,
  models: [
    {
      model,
      inputTokens: 1000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      ...(cost === undefined ? {} : { cost }),
    },
  ],
});

describe("local CLI usage and reconciliation", () => {
  it("replaces the turns ccusage covered, per session, and places terminal sessions", async () => {
    const f = await acpWorkspace({ sessionId: "ses-chat" });
    stubModelsDev({ [sonnet.id]: { ...sonnet, cost: { input: 3, output: 15 } } });
    const worker = { workerId: f.worker, workspaceId: f.workspace };
    // A terminal session the agent indexed in a Project folder, and one Radium knows nothing about.
    const [project] = await db()
      .insert(projects)
      .values({ workspace: f.workspace, userId: users.owner.id, name: "Repo" })
      .returning();
    await db().insert(projectFolders).values({ project: project!.id, workspace: f.workspace, worker: f.worker, directory: "/repo/", position: 0 });
    // An ACP agent definition that runs the OpenCode CLI ccusage reads.
    await db().insert(acpAgents).values({
      workspace: f.workspace,
      agentId: "opencode",
      name: "OpenCode",
      command: "opencode",
      args: ["acp"],
      env: [],
      enabled: true,
      source: "registry",
      updatedAt: new Date(),
    });
    await db().insert(acpAgentSessions).values({
      workspace: f.workspace,
      worker: f.worker,
      agentId: "test-agent",
      sessionId: "ses-terminal",
      cwd: "/repo",
      updatedAt: new Date(),
    });

    const noon = Date.parse(`${utcDay(Date.now())}T12:00:00Z`);
    const model = defaultModel("Currently Claude Sonnet 4.5");
    await turn(f.session, { model, now: noon });
    const day = utcDay(noon);
    const rows = [localRow("ses-chat", 0.5), localRow("ses-terminal", 2), localRow("ses-unknown")];
    // ccusage read the logs just after the first turn ended.
    await reportLocalUsage(test.runtime, worker, { day, syncedAt: noon + 1, rows }, noon + 5);
    await settle();
    await turn(f.session, { model, now: noon + 10 });
    await resolvePrices();

    const activity = await call("owner").usage.getActivity({ workspace: f.workspace, since: 0 });
    // The first turn is inside ccusage's row; the second ended after that read and still counts.
    // ccusage's own costs stay as reported; the model it could not price gets Radium's models.dev
    // rate ($3 per million input tokens × 1,000 tokens).
    expect(activity.summary).toMatchObject({ agentTurns: 1, localSessions: 3, unknownCostTurns: 0, pendingTurns: 0 });
    expect(activity.summary.agentCost).toBeCloseTo(0.5 + 4.5 + 2 + 0.003);
    // The indexed terminal session joins its agent's row; an unindexed one joins the agent whose
    // definition runs that CLI.
    expect(activity.harnesses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "acp:test-agent", turns: 1, sessions: 2 }),
        expect.objectContaining({ id: "acp:opencode", name: "OpenCode", sessions: 1 }),
      ]),
    );
    expect(activity.projects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: project!.id, sessions: 1 }),
        expect.objectContaining({ id: "none", name: "No project", turns: 1, sessions: 2 }),
      ]),
    );
    const narrowed = await call("owner").usage.getActivity({
      workspace: f.workspace,
      since: 0,
      project: project!.id,
    });
    expect(narrowed.summary).toMatchObject({ agentTurns: 0, localSessions: 1 });
    expect(narrowed.summary.agentCost).toBeCloseTo(2);

    const sessionCost = await call("owner").usage.getChatCost({ chat: f.chat });
    expect(sessionCost.cost).toBeCloseTo(0.5 + 4.5);

    // A later read with the same totals still advances coverage: the second turn's tokens were
    // already in these rows, so it stops counting on its own.
    await reportLocalUsage(test.runtime, worker, { day, syncedAt: noon + 11, rows }, noon + 20);
    await settle();
    const reread = await call("owner").usage.getActivity({ workspace: f.workspace, since: 0 });
    expect(reread.summary).toMatchObject({ agentTurns: 0, localSessions: 3 });
    expect(reread.summary.agentCost).toBeCloseTo(0.5 + 2 + 0.003);
    // Unchanged rows kept Radium's estimate and were not priced again.
    const [unknown] = await db().select().from(localUsage).where(eq(localUsage.sessionId, "ses-unknown"));
    expect(unknown!.models[0]!.estimatedCost).toBeCloseTo(0.003);
    expect(unknown!.priceKey).toBeNull();

    // The local rows of a chat that becomes another member's personal chat are hidden too.
    await db().update(chats).set({ userId: users.member.id }).where(eq(chats.id, f.chat));
    const hidden = await call("owner").usage.getActivity({ workspace: f.workspace, since: 0 });
    expect(hidden.summary).toMatchObject({ agentTurns: 0, localSessions: 2 });
    expect(hidden.summary.agentCost).toBeCloseTo(2 + 0.003);
  });

  it("lets an agent's Gateway calls join its session and replace its local rows and turns that day", async () => {
    const f = await acpWorkspace({ sessionId: "ses-chat" });
    const worker = { workerId: f.worker, workspaceId: f.workspace };
    const now = Date.now();
    await turn(f.session, { tokens: { inputTokens: 1000, outputTokens: 100, totalTokens: 1100 }, cost: { amount: 7, currency: "USD" }, now });
    const day = utcDay(now);
    await reportLocalUsage(
      test.runtime,
      worker,
      {
        day,
        syncedAt: now - 1,
        rows: [localRow("ses-chat", 0.5, "glm-5"), localRow("ses-terminal", 2, "glm-5"), localRow("ses-other", 3, "glm-5")],
      },
      now,
    );
    await settle();
    await db().insert(acpAgents).values({
      workspace: f.workspace,
      agentId: "opencode",
      name: "OpenCode",
      command: "opencode",
      args: ["acp"],
      env: [],
      enabled: true,
      source: "registry",
      updatedAt: new Date(),
    });
    const [key] = await db()
      .insert(apiKeys)
      .values({ workspace: f.workspace, name: "OpenCode", hash: `hash-${f.workspace}`, preview: "rad-sk-...code" })
      .returning();
    // OpenCode sends its session id as `x-session-id`; a client with an unrelated id stays API.
    for (const [clientSession, cost] of [
      ["ses-chat", 0.25],
      ["ses-terminal", 0.1],
      ["unrelated", 1],
    ] as const) {
      await insertCompletion(test.runtime, {
        workspace: f.workspace,
        model: f.model,
        cost,
        apiKey: key!.id,
        clientSession,
        createdAt: new Date(now),
      });
    }

    const activity = await call("owner").usage.getActivity({ workspace: f.workspace, since: 0 });
    // The turn and both tagged sessions' ccusage rows are replaced by the exact Gateway figures.
    expect(activity.summary).toMatchObject({ requests: 3, agentTurns: 0, localSessions: 1 });
    expect(activity.summary.gatewayCost).toBeCloseTo(1.35);
    expect(activity.summary.agentCost).toBeCloseTo(3);
    expect(activity.harnesses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "acp:test-agent", requests: 1, turns: 0 }),
        expect.objectContaining({ id: "acp:opencode", requests: 1, sessions: 1 }),
        expect.objectContaining({ id: "api", requests: 1 }),
      ]),
    );
    const byId = Object.fromEntries(activity.harnesses.map((harness) => [harness.id, harness.cost]));
    expect(byId["acp:test-agent"]).toBeCloseTo(0.25);
    expect(byId["acp:opencode"]).toBeCloseTo(3.1);
    expect(activity.projects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "none", requests: 2, sessions: 1 }),
        expect.objectContaining({ id: "outside", requests: 1 }),
      ]),
    );

    const sessionCost = await call("owner").usage.getChatCost({ chat: f.chat });
    expect(sessionCost).toMatchObject({ steps: 1, unknown: 0, pending: 0 });
    expect(sessionCost.cost).toBeCloseTo(0.25);

    // Once the chat is another member's private chat, its session's Gateway calls leave Activity
    // instead of falling back to plain API traffic.
    await db().update(chats).set({ userId: users.member.id }).where(eq(chats.id, f.chat));
    const hidden = await call("owner").usage.getActivity({ workspace: f.workspace, since: 0 });
    expect(hidden.summary.requests).toBe(2);
    expect(hidden.summary.gatewayCost).toBeCloseTo(1.1);
    expect(hidden.harnesses).toEqual(expect.arrayContaining([expect.objectContaining({ id: "api", requests: 1 })]));
    expect(hidden.harnesses.map((harness) => harness.id)).not.toContain("acp:test-agent");
  });

  it("prices local rows from workspace rates, keeping ccusage's own costs", async () => {
    const f = await acpWorkspace();
    await addProvider(test.runtime, f.workspace, {
      slug: "anthropic",
      models: [offer("anthropic/claude-sonnet-4-5", { pricing: { input: "0.000003", output: "0.000015" } })],
    });
    const worker = { workerId: f.worker, workspaceId: f.workspace };
    await reportLocalUsage(test.runtime, worker, {
      day: utcDay(Date.now()),
      syncedAt: Date.now(),
      rows: [localRow("ses-a"), localRow("ses-b", 9)],
    });
    await settle();
    const rows = await db().select().from(localUsage).where(eq(localUsage.worker, f.worker)).orderBy(asc(localUsage.sessionId));
    expect(rows[0]!.models[0]!.estimatedCost).toBeCloseTo(0.003);
    expect(rows[1]!.models[0]).toMatchObject({ cost: 9 });
    expect(rows[1]!.models[0]!.estimatedCost).toBeUndefined();
  });

  it("upserts re-reports: unchanged rows only advance syncedAt, changed rows are replaced", async () => {
    const f = await acpWorkspace();
    const worker = { workerId: f.worker, workspaceId: f.workspace };
    const day = "2026-11-20";
    const base = Date.parse(`${day}T10:00:00Z`);
    await reportLocalUsage(test.runtime, worker, { day, syncedAt: base, rows: [localRow("ses-a", 1)] }, base);
    await reportLocalUsage(test.runtime, worker, { day, syncedAt: base + 1000, rows: [localRow("ses-a", 1)] }, base + 1000);
    // An older read never moves coverage back.
    await reportLocalUsage(test.runtime, worker, { day, syncedAt: base + 500, rows: [localRow("ses-a", 1)] }, base + 2000);
    let rows = await db().select().from(localUsage).where(eq(localUsage.worker, f.worker));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.syncedAt.getTime()).toBe(base + 1000);

    await reportLocalUsage(
      test.runtime,
      worker,
      { day, syncedAt: base + 3000, rows: [{ ...localRow("ses-a", 2), totalTokens: 5000 }] },
      base + 3000,
    );
    rows = await db().select().from(localUsage).where(eq(localUsage.worker, f.worker));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ totalTokens: 5000 });
    expect(rows[0]!.models[0]!.cost).toBe(2);
    // A report from the future is clamped to now.
    await reportLocalUsage(test.runtime, worker, { day, syncedAt: base + 99_000, rows: [{ ...localRow("ses-a", 2), totalTokens: 5000 }] }, base + 4000);
    rows = await db().select().from(localUsage).where(eq(localUsage.worker, f.worker));
    expect(rows[0]!.syncedAt.getTime()).toBe(base + 4000);
    await settle();
  });

  it("serializes overlapping reports of one Worker (advisory lock): no unique-key failure", async () => {
    const f = await acpWorkspace();
    const worker = { workerId: f.worker, workspaceId: f.workspace };
    const report: LocalUsageReport = {
      day: utcDay(Date.now()),
      syncedAt: Date.now(),
      rows: [localRow("ses-a"), localRow("ses-b", 1)],
    };
    await Promise.all(Array.from({ length: 5 }, () => reportLocalUsage(test.runtime, worker, report)));
    const rows = await db().select().from(localUsage).where(eq(localUsage.worker, f.worker));
    expect(rows.map((row) => row.sessionId).sort()).toEqual(["ses-a", "ses-b"]);
    // Every report queued a pricing job for the unpriced row; they all converge on one estimate.
    stubModelsDev();
    await settle();
    await resolvePrices();
    const [priced] = await db().select().from(localUsage).where(and(eq(localUsage.worker, f.worker), eq(localUsage.sessionId, "ses-a")));
    expect(priced!.priceKey).toBeNull();
    expect(priced!.models[0]!.estimatedCost).toBeCloseTo(0.003);
  });

  it("validates reports as Convex did: real days, at most 100 rows, sane counts; labels are cut", async () => {
    const f = await acpWorkspace();
    const worker = { workerId: f.worker, workspaceId: f.workspace };
    const report = (change: Partial<LocalUsageReport>): LocalUsageReport => ({
      day: "2026-11-20",
      syncedAt: Date.now(),
      rows: [localRow("ses-a", 1)],
      ...change,
    });
    for (const bad of [
      report({ day: "2026-02-30" }),
      report({ day: "20261120" }),
      report({ rows: Array.from({ length: 101 }, (_, index) => localRow(`ses-${index}`, 1)) }),
      report({ rows: [{ ...localRow("ses-a", 1), totalTokens: -1 }] }),
      report({ rows: [{ ...localRow("ses-a", 1), totalTokens: 1.5 }] }),
    ]) {
      await expect(reportLocalUsage(test.runtime, worker, bad)).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
    }
    const long = {
      ...localRow("s".repeat(400), 1),
      agent: "a".repeat(100),
      models: Array.from({ length: 40 }, () => ({ ...localRow("x", 1).models[0]!, model: "m".repeat(300) })),
    };
    await reportLocalUsage(test.runtime, worker, report({ rows: [long] }));
    const [row] = await db().select().from(localUsage).where(eq(localUsage.worker, f.worker));
    expect(row!.agent).toHaveLength(64);
    expect(row!.sessionId).toHaveLength(256);
    expect(row!.models).toHaveLength(32);
    expect(row!.models[0]!.model).toHaveLength(200);
  });

  it("keeps each Worker's cursor and last sync result", async () => {
    const f = await acpWorkspace();
    const worker = { workerId: f.worker, workspaceId: f.workspace };
    expect(await localUsageCursor(db(), worker)).toBeNull();
    await finishLocalUsageSync(db(), worker, { syncedThrough: "2026-11-20" }, 1_000);
    expect(await localUsageCursor(db(), worker)).toBe("2026-11-20");
    // A failed sync keeps the cursor and stores a short error.
    await finishLocalUsageSync(db(), worker, { error: "x".repeat(400) }, 2_000);
    expect(await localUsageCursor(db(), worker)).toBe("2026-11-20");
    expect((await listLocalUsageSyncs(db(), f.workspace))[0]).toMatchObject({ lastSyncAt: 2_000 });
    expect((await listLocalUsageSyncs(db(), f.workspace))[0]!.error).toHaveLength(300);
    // The next success clears the error.
    await finishLocalUsageSync(db(), worker, { syncedThrough: "2026-11-21" }, 3_000);
    expect(await listLocalUsageSyncs(db(), f.workspace)).toEqual([
      { worker: f.worker, lastSyncAt: 3_000, syncedThrough: "2026-11-21", error: null },
    ]);
    await expect(
      finishLocalUsageSync(db(), worker, { syncedThrough: "2026-13-01" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    // Another workspace's Worker id never reads this cursor.
    expect(await localUsageCursor(db(), { workerId: f.worker, workspaceId: "other" })).toBeNull();
  });
});
