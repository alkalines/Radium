/// <reference types="vite/client" />

import { anyApi } from "convex/server";
import { convexTest } from "convex-test";
import { expect, test, vi } from "vitest";
import type { Id } from "./_generated/dataModel";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { filterVisibleTraces, isTraceVisible } from "./chatroom";

type TestIdentity = {
  tokenIdentifier?: string;
  subject?: string;
  email?: string;
  name?: string;
};

type AuthContext = {
  auth: {
    getUserIdentity: () => Promise<TestIdentity | null>;
  };
};

const authMock = vi.hoisted(() => {
  const getAuthUser = vi.fn(async (ctx: AuthContext) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;

    const userId = identity.tokenIdentifier ?? identity.subject;
    if (!userId) return null;

    return {
      _id: userId,
      email: identity.email ?? `${userId}@example.invalid`,
      name: identity.name ?? userId,
    };
  });

  return {
    getAuthUser,
    getAnyUserById: vi.fn(),
    safeGetAuthUser: getAuthUser,
  };
});

vi.mock("./auth", () => ({
  authComponent: {
    getAuthUser: authMock.getAuthUser,
    getAnyUserById: authMock.getAnyUserById,
    safeGetAuthUser: authMock.safeGetAuthUser,
  },
}));

const modules = import.meta.glob("./**/*.ts");

function makeTest() {
  return convexTest({ schema, modules });
}

function asUser(t: ReturnType<typeof makeTest>, userId: string) {
  return t.withIdentity({
    tokenIdentifier: userId,
    subject: userId,
    email: `${userId}@example.invalid`,
    name: userId,
  });
}

async function chatFixture(t: ReturnType<typeof makeTest>) {
  return await t.run(async (ctx) => {
    const workspace = await ctx.db.insert("workspaces", {
      ownerType: "user",
      ownerId: "owner",
      name: "Shared workspace",
    });
    await ctx.db.insert("workspace_members", {
      workspace,
      userId: "member",
      role: "member",
    });

    const ownerPersonal = await ctx.db.insert("aisdk_chats", {
      userId: "owner",
      workspace,
      scope: "personal",
      messages: [],
      chat_completions: [],
      activeStream: false,
      lastInteractionAt: 1,
    });
    const ownerShared = await ctx.db.insert("aisdk_chats", {
      userId: "owner",
      workspace,
      scope: "workspace",
      messages: [],
      chat_completions: [],
      activeStream: false,
      lastInteractionAt: 2,
    });
    const memberPersonal = await ctx.db.insert("aisdk_chats", {
      userId: "member",
      workspace,
      scope: "personal",
      messages: [],
      chat_completions: [],
      activeStream: false,
      lastInteractionAt: 3,
    });

    return { workspace, ownerPersonal, ownerShared, memberPersonal };
  });
}

test("ListChats separates personal chats and marks shared managers", async () => {
  const t = makeTest();
  const ids = await chatFixture(t);
  const memberChats = await asUser(t, "member").query(anyApi.aisdk.ListChats, {
    workspace: ids.workspace,
  });
  const ownerChats = await asUser(t, "owner").query(anyApi.aisdk.ListChats, {
    workspace: ids.workspace,
  });

  expect(memberChats).toEqual([
    expect.objectContaining({ id: ids.memberPersonal, canManage: true }),
    expect.objectContaining({ id: ids.ownerShared, canManage: false }),
  ]);
  expect((memberChats as Array<{ id: Id<"aisdk_chats"> }>).map((chat) => chat.id)).not.toContain(
    ids.ownerPersonal,
  );
  expect(ownerChats).toEqual([
    expect.objectContaining({ id: ids.ownerShared, canManage: true }),
    expect.objectContaining({ id: ids.ownerPersonal, canManage: true }),
  ]);
  expect((ownerChats as Array<{ id: Id<"aisdk_chats"> }>).map((chat) => chat.id)).not.toContain(
    ids.memberPersonal,
  );
  await expect(
    asUser(t, "member").query(anyApi.aisdk.GetChat, { chatId: ids.ownerShared }),
  ).resolves.toMatchObject({ canManage: false, canManageScope: false });
  await expect(
    asUser(t, "owner").query(anyApi.aisdk.GetChat, { chatId: ids.ownerShared }),
  ).resolves.toMatchObject({ canManage: true, canManageScope: true });
});

test("shared chat management is limited to its creator or workspace owner", async () => {
  const t = makeTest();
  const ids = await chatFixture(t);
  const owner = asUser(t, "owner");
  const member = asUser(t, "member");

  await expect(
    member.mutation(anyApi.aisdk.RenameChat, {
      chatId: ids.ownerShared,
      title: "Not allowed",
    }),
  ).rejects.toThrow("Chat not found.");
  await expect(
    member.mutation(anyApi.aisdk.SetChatScope, {
      chatId: ids.ownerShared,
      scope: "personal",
    }),
  ).rejects.toThrow("Only the chat creator can change its scope.");
  await expect(
    owner.mutation(anyApi.aisdk.RenameChat, {
      chatId: ids.memberPersonal,
      title: "Not allowed",
    }),
  ).rejects.toThrow("Chat not found.");
  await expect(
    member.mutation(anyApi.aisdk.SetChatScope, {
      chatId: ids.memberPersonal,
      scope: "workspace",
    }),
  ).resolves.toEqual({ scope: "workspace" });

  await expect(
    owner.mutation(anyApi.aisdk.RenameChat, {
      chatId: ids.ownerShared,
      title: "Owner managed",
    }),
  ).resolves.toBeNull();
  await expect(
    member.mutation(anyApi.chatroom.setChatTools, {
      chatId: ids.ownerShared,
      selection: { builtinToolSets: ["web_search"], mcpServers: [] },
    }),
  ).rejects.toThrow("Chat not found.");
  await expect(
    member.query(anyApi.chatroom.getChatTools, { chatId: ids.ownerShared }),
  ).resolves.toMatchObject({ source: "defaults" });
  await expect(
    owner.mutation(anyApi.chatroom.setChatTools, {
      chatId: ids.ownerShared,
      selection: { builtinToolSets: ["web_search"], mcpServers: [] },
    }),
  ).resolves.toBeDefined();
});

test("setting a default materializes legacy fields and does not bleed to another workspace", async () => {
  const t = makeTest();
  const ids = await t.run(async (ctx) => {
    const firstWorkspace = await ctx.db.insert("workspaces", {
      ownerType: "user",
      ownerId: "owner",
      name: "First workspace",
    });
    const secondWorkspace = await ctx.db.insert("workspaces", {
      ownerType: "user",
      ownerId: "owner",
      name: "Second workspace",
    });
    await ctx.db.insert("chatroom_settings", {
      userId: "owner",
      defaultModel: "legacy-model",
      titleModel: "legacy-title-model",
      enableChainOfThought: false,
      telemetry: { enabled: true, recordInputs: true, recordOutputs: true },
      builtinToolSets: ["web_search"],
      mcpServers: [],
    });
    return { firstWorkspace, secondWorkspace };
  });

  const owner = asUser(t, "owner");
  await expect(
    owner.mutation(anyApi.chatroom.setChainOfThoughtEnabled, {
      workspace: ids.firstWorkspace,
      enabled: true,
    }),
  ).resolves.toBeDefined();

  const settings = await t.run((ctx) =>
    ctx.db
      .query("workspace_settings")
      .withIndex("by_workspace", (q) => q.eq("workspace", ids.firstWorkspace))
      .unique(),
  );
  expect(settings).toMatchObject({
    workspace: ids.firstWorkspace,
    defaultModel: "legacy-model",
    titleModel: "legacy-title-model",
    enableChainOfThought: true,
    telemetry: { enabled: true, recordInputs: true, recordOutputs: true },
    builtinToolSets: ["web_search"],
    mcpServers: [],
  });
  await expect(
    owner.query(anyApi.chatroom.getChainOfThoughtEnabled, { workspace: ids.secondWorkspace }),
  ).resolves.toBe(true);
});

test("moved title handlers preserve existing titles unless regeneration is forced", async () => {
  const t = makeTest();
  const { ownerShared: chatId } = await chatFixture(t);
  await t.mutation(internal.chatroom.saveGeneratedTitle, {
    chatId,
    emoji: "💡",
    title: "  First\n  title  ",
  });
  await t.mutation(internal.chatroom.saveGeneratedTitle, {
    chatId,
    emoji: "💬",
    title: "Replacement",
  });
  expect(await t.run((ctx) => ctx.db.get("aisdk_chats", chatId))).toMatchObject({
    emoji: "💡",
    title: "First title",
  });
  await t.mutation(internal.chatroom.saveGeneratedTitle, {
    chatId,
    emoji: "💬",
    title: "Replacement",
    force: true,
  });
  expect(await t.run((ctx) => ctx.db.get("aisdk_chats", chatId))).toMatchObject({
    emoji: "💬",
    title: "Replacement",
  });
  await t.run((ctx) => ctx.db.delete("aisdk_chats", chatId));
  await expect(
    t.mutation(internal.chatroom.saveGeneratedTitle, { chatId, emoji: "💬", title: "Deleted" }),
  ).resolves.toBeNull();
});

test("title model selection uses only enabled workspace models and rejects archived workspaces", async () => {
  const t = makeTest();
  const { workspace, ownerShared: chatId } = await chatFixture(t);
  const configuration = await t.run(async (ctx) => {
    const author = await ctx.db.insert("authors", { name: "Test", slug: "test" });
    for (const slug of ["unconfigured", "fallback", "preferred"]) {
      await ctx.db.insert("models", {
        name: slug,
        slug,
        author,
        launch_date: 0,
        type: "chat",
        description: "Title model",
        reasoning: false,
        features: {},
        architecture: {
          input_modalities: ["text"],
          output_modalities: ["text"],
          tokenizer: "GPT",
        },
      });
    }
    await ctx.db.insert("workspace_settings", {
      workspace,
      titleModel: "preferred",
      builtinToolSets: [],
      mcpServers: [],
    });
    await ctx.db.patch("aisdk_chats", chatId, {
      messages_queue: {
        text: "  Explain gravity  ",
        files: [],
        model: "preferred",
        webSearch: false,
      },
    });
    return ctx.db.insert("workspace_configurations", {
      workspace,
      provider: "test",
      enabled: true,
      active: true,
      snapshot: {
        slug: "test",
        name: "Test",
        npm: "@ai-sdk/openai-compatible",
        env: [],
        models: ["fallback", "preferred"].map((model) => ({
          model,
          context: 1000,
          max_output: 100,
          pricing: { input: "0", output: "0" },
          supported_parameters: [],
          moderated: false,
        })),
      },
    });
  });
  await expect(t.query(internal.chatroom.titleGenerationInfo, { chatId })).resolves.toMatchObject({
    workspace,
    userId: "owner",
    model: "preferred",
    initialUserMessage: "Explain gravity",
  });
  await t.run(async (ctx) => {
    const settings = await ctx.db.query("workspace_settings").unique();
    await ctx.db.patch("workspace_settings", settings!._id, { titleModel: "unconfigured" });
  });
  await expect(t.query(internal.chatroom.titleGenerationInfo, { chatId })).resolves.toMatchObject({
    model: "fallback",
  });
  await t.run((ctx) => ctx.db.patch("workspace_configurations", configuration, { enabled: false }));
  await expect(t.query(internal.chatroom.titleGenerationInfo, { chatId })).resolves.toBeNull();
  await t.run(async (ctx) => {
    await ctx.db.patch("workspace_configurations", configuration, { enabled: true });
    await ctx.db.patch("workspaces", workspace, { archivedAt: 1 });
  });
  await expect(t.query(internal.chatroom.titleGenerationInfo, { chatId })).resolves.toBeNull();
});

test("chat creation schedules the consolidated title action", async () => {
  vi.useFakeTimers();
  try {
    const t = makeTest();
    const { workspace } = await chatFixture(t);
    const chatId = await asUser(t, "owner").mutation(api.aisdk.CreateChat, {
      workspace,
      messages_queue: { text: "Explain gravity", files: [], model: "test", webSearch: false },
    });
    const jobs = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(jobs).toEqual([
      expect.objectContaining({ name: "chatroom:generateForChat", args: [{ chatId }] }),
    ]);
    // No configured model: the scheduled action should resolve cleanly without an upstream call.
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const finished = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(finished[0]?.state).toEqual({ kind: "success" });
  } finally {
    vi.useRealTimers();
  }
});

test("consolidated telemetry visibility hides private chat siblings in lists and direct reads", async () => {
  const t = makeTest();
  const ids = await chatFixture(t);
  const traceIds = await t.run(async (ctx) => {
    const fields = {
      workspace: ids.workspace,
      userId: "owner",
      callId: "call",
      operationId: "operation",
      functionId: "function",
      provider: "provider",
      model: "model",
      status: "ok" as const,
      startedAt: 1,
      recordsInputs: false,
      recordsOutputs: false,
    };
    const privateTrace = await ctx.db.insert("telemetry_traces", {
      ...fields,
      source: "chatroom",
      requestId: "private-request",
      chatId: ids.memberPersonal,
      userId: "member",
    });
    const nestedGateway = await ctx.db.insert("telemetry_traces", {
      ...fields,
      source: "gateway",
      requestId: "private-request",
    });
    const sharedTrace = await ctx.db.insert("telemetry_traces", {
      ...fields,
      source: "chatroom",
      requestId: "shared-request",
      chatId: ids.ownerShared,
    });
    const standaloneGateway = await ctx.db.insert("telemetry_traces", {
      ...fields,
      source: "gateway",
      requestId: "gateway-request",
    });
    return { privateTrace, nestedGateway, sharedTrace, standaloneGateway };
  });
  await asUser(t, "owner").run(async (ctx) => {
    const workspace = (await ctx.db.get("workspaces", ids.workspace))!;
    const traces = await ctx.db.query("telemetry_traces").collect();
    const visible = await filterVisibleTraces(ctx, workspace, traces);
    expect(visible.map((trace) => trace._id)).toEqual([
      traceIds.sharedTrace,
      traceIds.standaloneGateway,
    ]);
    const nested = (await ctx.db.get("telemetry_traces", traceIds.nestedGateway))!;
    expect(await isTraceVisible(ctx, workspace, nested)).toBe(false);
    const standalone = (await ctx.db.get("telemetry_traces", traceIds.standaloneGateway))!;
    expect(await isTraceVisible(ctx, workspace, standalone)).toBe(true);
  });
});
