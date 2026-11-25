import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestRuntime, type TestRuntime } from "../../test/runtime";
import {
  insertChat,
  insertCompletion,
  usageUsers,
  usageWorkspace,
  type Role,
  type UsageFixture,
  type Users,
} from "../../test/usage";
import { chats } from "../chatroom/schema";
import { apiKeys } from "../gateway/schema";
import { appRouter } from "../trpc/router";
import { projects, workspaces } from "../workspaces/schema";
import { finishLocalUsageSync } from "./local";

// Usage reads through the real router: owner-only workspace reads, the chat-scoped Session cost,
// and Chatroom privacy on every read (Convex `ownership-review.test.ts` usage cases).

let test: TestRuntime;
let users: Users;
let fixture: UsageFixture;
let ids: Record<string, string>;

const db = () => test.runtime.drivers.db;
const call = (role: Role) =>
  appRouter.createCaller({ runtime: test.runtime, headers: users[role].headers });

beforeAll(async () => {
  test = await createTestRuntime();
  users = await usageUsers(test.runtime, "usage");
  fixture = await usageWorkspace(test.runtime, users);
  const { workspace, model } = fixture;
  const [key] = await db()
    .insert(apiKeys)
    .values({ workspace, name: "BYOK key", hash: "hash-usage", preview: "rad-sk-...byok" })
    .returning();
  const ownerChat = await insertChat(test.runtime, { workspace, userId: users.owner.id });
  const memberChat = await insertChat(test.runtime, { workspace, userId: users.member.id });
  const sharedWithOther = await insertChat(test.runtime, {
    workspace,
    userId: users.member.id,
    scope: "shared",
    members: [users.other.id],
  });
  const sharedWithOwner = await insertChat(test.runtime, {
    workspace,
    userId: users.member.id,
    scope: "shared",
    members: [users.owner.id],
  });
  const workspaceChat = await insertChat(test.runtime, {
    workspace,
    userId: users.member.id,
    scope: "workspace",
  });
  const t0 = Date.now() - 60_000;
  const at = (offset: number) => new Date(t0 + offset * 1000);
  // Gateway traffic: a historical credit row and a BYOK key row.
  await insertCompletion(test.runtime, { workspace, model, cost: 3, byok: false, apiKey: key!.id, createdAt: at(1) });
  await insertCompletion(test.runtime, { workspace, model, cost: 7, apiKey: key!.id, createdAt: at(2) });
  // Chatroom completions: visible to the owner only through the chats they can see.
  await insertCompletion(test.runtime, { workspace, model, cost: 11, chat: ownerChat, userId: users.owner.id, createdAt: at(3) });
  await insertCompletion(test.runtime, { workspace, model, cost: 100, chat: memberChat, userId: users.member.id, createdAt: at(4) });
  await insertCompletion(test.runtime, { workspace, model, cost: 200, chat: sharedWithOther, userId: users.member.id, createdAt: at(5) });
  await insertCompletion(test.runtime, { workspace, model, cost: 13, chat: sharedWithOwner, userId: users.member.id, createdAt: at(6) });
  await insertCompletion(test.runtime, { workspace, model, cost: 17, chat: workspaceChat, userId: users.member.id, createdAt: at(7) });
  // A deleted chat's completion (chat set null, user kept) and an unattributed row stay hidden.
  await insertCompletion(test.runtime, { workspace, model, cost: 400, userId: users.member.id, createdAt: at(8) });
  await insertCompletion(test.runtime, { workspace, model, cost: 800, createdAt: at(9) });
  // An unpriced chat completion.
  await insertCompletion(test.runtime, { workspace, model, cost: null, chat: ownerChat, userId: users.owner.id, createdAt: at(10) });
  ids = { key: key!.id, ownerChat, memberChat, sharedWithOther, sharedWithOwner, workspaceChat };
});

afterAll(async () => {
  await test?.close();
});

const OWNER_READS = ["getActivity", "getGenerations", "getUsage", "localUsageSyncs"] as const;

function ownerRead(role: Role, read: (typeof OWNER_READS)[number], workspace = fixture.workspace) {
  const usage = call(role).usage;
  switch (read) {
    case "getActivity":
      return usage.getActivity({ workspace, since: 0 });
    case "getGenerations":
      return usage.getGenerations({ workspace });
    case "getUsage":
      return usage.getUsage({ workspace });
    case "localUsageSyncs":
      return usage.localUsageSyncs({ workspace });
  }
}

describe("authorization", () => {
  it("serves workspace reads to the owner only; members and outsiders get NOT_FOUND", async () => {
    for (const read of OWNER_READS) {
      await expect(ownerRead("owner", read)).resolves.toBeDefined();
      for (const role of ["member", "other", "outsider"] as const) {
        await expect(ownerRead(role, read)).rejects.toMatchObject({ code: "NOT_FOUND" });
      }
      await expect(ownerRead("owner", read, "unknown-workspace")).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
    }
  });

  it("refuses every read of an archived workspace", async () => {
    await db().update(workspaces).set({ archivedAt: new Date() }).where(eq(workspaces.id, fixture.workspace));
    try {
      for (const read of OWNER_READS) {
        await expect(ownerRead("owner", read)).rejects.toMatchObject({ code: "NOT_FOUND" });
      }
      await expect(call("owner").usage.getChatCost({ chat: ids.ownerChat! })).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
    } finally {
      await db().update(workspaces).set({ archivedAt: null }).where(eq(workspaces.id, fixture.workspace));
    }
  });

  it("serves a Session's cost to whoever can open the chat, and NOT_FOUND to everyone else", async () => {
    const cases: Array<[string, Role[], Role[]]> = [
      ["ownerChat", ["owner"], ["member", "other", "outsider"]],
      // The owner never sees a member's personal-chat cost.
      ["memberChat", ["member"], ["owner", "other", "outsider"]],
      ["sharedWithOther", ["member", "other"], ["owner", "outsider"]],
      ["sharedWithOwner", ["member", "owner"], ["other", "outsider"]],
      ["workspaceChat", ["owner", "member", "other"], ["outsider"]],
    ];
    for (const [chat, allowed, refused] of cases) {
      for (const role of allowed) {
        const cost = await call(role).usage.getChatCost({ chat: ids[chat]! });
        expect(cost.steps).toBeGreaterThan(0);
      }
      for (const role of refused) {
        await expect(call(role).usage.getChatCost({ chat: ids[chat]! })).rejects.toMatchObject({
          code: "NOT_FOUND",
        });
      }
    }
    await expect(call("owner").usage.getChatCost({ chat: "unknown-chat" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("refuses a removed member's former chats", async () => {
    const chat = await insertChat(test.runtime, {
      workspace: fixture.workspace,
      userId: users.outsider.id,
    });
    await expect(call("outsider").usage.getChatCost({ chat })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("personal-chat privacy and Convex usage semantics", () => {
  it("getActivity counts only Gateway traffic and the chats the owner can see", async () => {
    const activity = await call("owner").usage.getActivity({ workspace: fixture.workspace, since: 0 });
    // Visible: two Gateway rows, the owner's chat (priced and unpriced), the shared chat that
    // includes the owner, and the workspace chat. Hidden: the member's personal chat, a shared
    // chat without the owner, a deleted chat's row and an unattributed row.
    expect(activity.summary).toMatchObject({ requests: 6, unknownCostRequests: 1, agentTurns: 0 });
    expect(activity.summary.gatewayCost).toBeCloseTo(3 + 7 + 11 + 13 + 17);
    expect(activity.usageTypes).toEqual({
      byok: { requests: 5, cost: 7 + 11 + 13 + 17 },
      legacyCredits: { requests: 1, cost: 3 },
    });
    expect(activity.apiKeys).toEqual([
      { id: "unattributed", name: "Radium Chatroom", requests: 4, cost: 41 },
      { id: `api:${ids.key}`, name: "BYOK key", requests: 2, cost: 10 },
    ]);
    expect(activity.harnesses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "radium", kind: "radium", requests: 4, agentId: null }),
        expect.objectContaining({ id: "api", kind: "api", name: "Gateway API", requests: 2 }),
      ]),
    );
    expect(activity.projects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "none", name: "No project", requests: 4 }),
        expect.objectContaining({ id: "outside", name: "Outside Chatroom", requests: 2 }),
      ]),
    );
    expect(activity.models).toEqual([
      expect.objectContaining({ id: fixture.model, name: "test/model", requests: 6, tokens: 120 }),
    ]);
    expect(activity.truncated).toBe(false);

    const outside = await call("owner").usage.getActivity({
      workspace: fixture.workspace,
      since: 0,
      project: "outside",
    });
    expect(outside.summary.requests).toBe(2);
    const later = await call("owner").usage.getActivity({
      workspace: fixture.workspace,
      since: Date.now() + 60_000,
    });
    expect(later.summary.requests).toBe(0);
  });

  it("Project filing follows the chat at read time", async () => {
    const [project] = await db()
      .insert(projects)
      .values({ workspace: fixture.workspace, userId: users.owner.id, name: "Project", color: "teal" })
      .returning();
    await db().update(chats).set({ project: project!.id }).where(eq(chats.id, ids.ownerChat!));
    try {
      const activity = await call("owner").usage.getActivity({
        workspace: fixture.workspace,
        since: 0,
        project: project!.id,
      });
      expect(activity.summary.requests).toBe(2);
      expect(activity.projects).toEqual([
        expect.objectContaining({ id: project!.id, name: "Project", color: "teal", icon: null, requests: 2 }),
      ]);
    } finally {
      await db().update(chats).set({ project: null }).where(eq(chats.id, ids.ownerChat!));
    }
  });

  it("getUsage and getGenerations apply the same privacy, newest first", async () => {
    const usage = await call("owner").usage.getUsage({ workspace: fixture.workspace });
    expect(usage.completions).toBe(6);
    expect(usage.unknownCostRequests).toBe(1);
    expect(usage.spentRecent).toBeCloseTo(51);
    expect(usage.recent.map((row) => row.cost)).toEqual([null, 17, 13, 11, 7, 3]);
    expect(usage.recent.map((row) => row.byok)).toEqual([true, true, true, true, true, false]);

    const generations = await call("owner").usage.getGenerations({ workspace: fixture.workspace });
    expect(generations.map((row) => row.response.pricing.cost)).toEqual([null, 17, 13, 11, 7, 3]);
    expect(generations.at(-1)).toMatchObject({
      apiKey: { name: "BYOK key", preview: "rad-sk-...byok" },
      request: {
        provider: "plain",
        credentialName: null,
        byok: false,
        model: { id: fixture.model, name: "test/model", slug: "test/model" },
      },
      response: { genId: "gen", finish_reason: "stop", usage: { prompt_tokens: 10 } },
    });
    expect(generations[0]!.apiKey).toBeNull();

    // `limit` bounds the visible rows, reading twice as many before privacy.
    const limited = await call("owner").usage.getUsage({ workspace: fixture.workspace, limit: 2 });
    expect(limited.recent.map((row) => row.cost)).toEqual([null, 17]);
  });

  it("sums a built-in Session's own completions, unpriced ones counted as unknown", async () => {
    await expect(call("owner").usage.getChatCost({ chat: ids.ownerChat! })).resolves.toEqual({
      cost: 11,
      steps: 2,
      unknown: 1,
      pending: 0,
    });
    await expect(call("member").usage.getChatCost({ chat: ids.memberChat! })).resolves.toEqual({
      cost: 100,
      steps: 1,
      unknown: 0,
      pending: 0,
    });
  });

  it("lists each Worker's local usage sync for the owner", async () => {
    const worker = { workerId: fixture.worker, workspaceId: fixture.workspace };
    await finishLocalUsageSync(db(), worker, { syncedThrough: "2026-11-20" }, 1_000);
    await finishLocalUsageSync(db(), worker, { error: "ccusage timed out" }, 2_000);
    await expect(call("owner").usage.localUsageSyncs({ workspace: fixture.workspace })).resolves.toEqual([
      { worker: fixture.worker, lastSyncAt: 2_000, syncedThrough: "2026-11-20", error: "ccusage timed out" },
    ]);
  });
});
