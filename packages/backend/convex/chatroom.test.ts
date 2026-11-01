/// <reference types="vite/client" />

import { anyApi } from "convex/server";
import { convexTest } from "convex-test";
import { expect, test, vi } from "vitest";
import type { Id } from "./_generated/dataModel";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { filterVisibleRequests, isRequestVisible } from "./chatroom";

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
      activeStream: false,
      lastInteractionAt: 1,
    });
    const ownerShared = await ctx.db.insert("aisdk_chats", {
      userId: "owner",
      workspace,
      scope: "workspace",
      activeStream: false,
      lastInteractionAt: 2,
    });
    const memberPersonal = await ctx.db.insert("aisdk_chats", {
      userId: "member",
      workspace,
      scope: "personal",
      activeStream: false,
      lastInteractionAt: 3,
    });

    return { workspace, ownerPersonal, ownerShared, memberPersonal };
  });
}

test("ListChats separates personal chats and marks shared managers", async () => {
  const t = makeTest();
  const ids = await chatFixture(t);
  const list = async (userId: string) =>
    (
      await asUser(t, userId).query(anyApi.aisdk.ListChats, {
        workspace: ids.workspace,
        paginationOpts: { cursor: null, numItems: 50 },
      })
    ).page;
  const memberChats = await list("member");
  const ownerChats = await list("owner");

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

test("Worker tool defaults are owner-written, member-readable, and keep legacy settings", async () => {
  const t = makeTest();
  const ids = await chatFixture(t);
  await t.run((ctx) =>
    ctx.db.insert("chatroom_settings", {
      userId: "owner",
      defaultModel: "legacy-model",
      builtinToolSets: ["web_search"],
      mcpServers: [],
    }),
  );
  const owner = asUser(t, "owner");
  const member = asUser(t, "member");

  await expect(
    member.query(api.chatroom.getWorkerToolDefaults, { workspace: ids.workspace }),
  ).resolves.toEqual([]);
  await expect(
    member.mutation(api.chatroom.setWorkerToolDefaults, {
      workspace: ids.workspace,
      tools: ["read"],
    }),
  ).rejects.toThrow("Workspace not found.");
  await expect(
    owner.mutation(api.chatroom.setWorkerToolDefaults, {
      workspace: ids.workspace,
      tools: ["read", "read"],
    }),
  ).rejects.toThrow("Worker tools must be unique.");

  await owner.mutation(api.chatroom.setWorkerToolDefaults, {
    workspace: ids.workspace,
    tools: ["read", "edit"],
  });
  await expect(
    member.query(api.chatroom.getWorkerToolDefaults, { workspace: ids.workspace }),
  ).resolves.toEqual(["read", "edit"]);
  // The first workspace write materializes the legacy fallback instead of dropping it. Legacy
  // settings predate the default-on session sets, so those count as enabled.
  await expect(
    member.query(api.chatroom.getToolDefaults, { workspace: ids.workspace }),
  ).resolves.toEqual({
    builtinToolSets: ["question", "todo_write", "web_search", "code_interpreter"],
    mcpServers: [],
  });
});

test("CreateChat stores draft tool choices as a sanitized chat override without touching defaults", async () => {
  const t = makeTest();
  const ids = await chatFixture(t);
  const member = asUser(t, "member");

  // A draft's list is complete: leaving out the default-on session sets switches them off.
  const chatId = await member.mutation(api.aisdk.CreateChat, {
    workspace: ids.workspace,
    messages_queue: { text: "", files: [], model: "test-model", webSearch: false },
    tools: { builtinToolSets: ["web_search", "unknown-tool"], mcpServers: [] },
  });

  await expect(member.query(api.chatroom.getChatTools, { chatId })).resolves.toEqual({
    builtinToolSets: ["web_search"],
    mcpServers: [],
    source: "chat",
  });
  await expect(
    member.query(api.chatroom.getToolDefaults, { workspace: ids.workspace }),
  ).resolves.toEqual({
    builtinToolSets: ["question", "todo_write", "code_interpreter"],
    mcpServers: [],
  });
  expect(await t.run((ctx) => ctx.db.query("workspace_settings").collect())).toEqual([]);
});

test("workspace defaults keep a switched-off default-on tool set off", async () => {
  const t = makeTest();
  const ids = await chatFixture(t);
  const owner = asUser(t, "owner");

  await owner.mutation(api.chatroom.setToolDefaults, {
    workspace: ids.workspace,
    selection: { builtinToolSets: ["todo_write"], mcpServers: [] },
  });

  await expect(
    owner.query(api.chatroom.getToolDefaults, { workspace: ids.workspace }),
  ).resolves.toEqual({ builtinToolSets: ["todo_write"], mcpServers: [] });
  await expect(
    owner.query(api.chatroom.getChatTools, { chatId: ids.ownerShared }),
  ).resolves.toEqual({ builtinToolSets: ["todo_write"], mcpServers: [], source: "defaults" });
});

test("system prompt switches: owner-only, identity hidden on request, off returns no prompt", async () => {
  const t = makeTest();
  const ids = await chatFixture(t);
  const owner = asUser(t, "owner");
  await t.run(async (ctx) => {
    const author = await ctx.db.insert("authors", { name: "Anthropic", slug: "anthropic" });
    await ctx.db.insert("models", {
      name: "Claude Opus",
      slug: "anthropic/claude-opus",
      author,
      launch_date: 0,
      type: "chat",
      description: "Chat model",
      reasoning: true,
      features: {},
      architecture: {
        input_modalities: ["text"],
        output_modalities: ["text"],
        tokenizer: "Claude",
      },
    });
  });
  const resolve = () =>
    t.query(internal.chatroom.resolveSystemPrompt, {
      workspace: ids.workspace,
      model: "anthropic/claude-opus",
    });

  await expect(resolve()).resolves.toEqual({
    model: { slug: "anthropic/claude-opus", name: "Claude Opus", author: "Anthropic" },
  });

  await expect(
    asUser(t, "member").mutation(api.chatroom.setSystemPromptSettings, {
      workspace: ids.workspace,
      enabled: false,
      modelIdentity: false,
    }),
  ).rejects.toThrow("Workspace not found.");

  await owner.mutation(api.chatroom.setSystemPromptSettings, {
    workspace: ids.workspace,
    enabled: true,
    modelIdentity: false,
  });
  await expect(resolve()).resolves.toEqual({});

  // The identity switch only matters while the prompt is on.
  await owner.mutation(api.chatroom.setSystemPromptSettings, {
    workspace: ids.workspace,
    enabled: false,
    modelIdentity: true,
  });
  await expect(resolve()).resolves.toBeNull();
  await expect(
    owner.query(api.chatroom.getSystemPromptSettings, { workspace: ids.workspace }),
  ).resolves.toEqual({ enabled: false, modelIdentity: true });
});

test("Code Mode prompts: only the requesting user answers, once, with the matching kind", async () => {
  const t = makeTest();
  const ids = await chatFixture(t);
  const interaction = await t.mutation(internal.code_mode.openInteraction, {
    chatId: ids.ownerShared,
    userId: "member",
    kind: "approval",
  });
  const answer = (userId: string, approved: boolean) =>
    asUser(t, userId).mutation(api.code_mode.answerInteraction, {
      interaction,
      response: { kind: "approval", approved },
    });

  // The chat owner can read this shared chat but did not start the run.
  await expect(answer("owner", true)).rejects.toThrow("no longer waiting");
  await expect(
    asUser(t, "member").mutation(api.code_mode.answerInteraction, {
      interaction,
      response: { kind: "question", answers: [] },
    }),
  ).rejects.toThrow("does not match");
  await expect(
    t.query(internal.code_mode.interactionResponse, { interaction }),
  ).resolves.toBeNull();

  await answer("member", false);
  await expect(answer("member", true)).rejects.toThrow("already answered");
  await expect(t.query(internal.code_mode.interactionResponse, { interaction })).resolves.toEqual({
    kind: "approval",
    approved: false,
  });

  await t.mutation(internal.code_mode.closeInteraction, { interaction });
  await expect(answer("member", true)).rejects.toThrow("no longer waiting");
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

test("request visibility hides other users' private chats in lists and direct reads", async () => {
  const t = makeTest();
  const ids = await chatFixture(t);
  const requestIds = await t.run(async (ctx) => {
    const fields = {
      workspace: ids.workspace,
      source: "gateway" as const,
      model: "model",
      stream: false,
      status: "ok" as const,
      startedAt: 1,
      endedAt: 2,
      durationMs: 1,
      attempts: [],
      recordsInputs: false,
      recordsOutputs: false,
      lineage: { kind: "root" as const },
    };
    const privateRequest = await ctx.db.insert("telemetry_requests", {
      ...fields,
      requestId: "private-request",
      chatId: ids.memberPersonal,
      userId: "member",
    });
    const ownerPersonal = await ctx.db.insert("telemetry_requests", {
      ...fields,
      requestId: "owner-personal",
      chatId: ids.ownerPersonal,
      userId: "owner",
    });
    const sharedRequest = await ctx.db.insert("telemetry_requests", {
      ...fields,
      requestId: "shared-request",
      chatId: ids.ownerShared,
    });
    const standaloneGateway = await ctx.db.insert("telemetry_requests", {
      ...fields,
      requestId: "gateway-request",
    });
    return { privateRequest, ownerPersonal, sharedRequest, standaloneGateway };
  });
  await asUser(t, "owner").run(async (ctx) => {
    const workspace = (await ctx.db.get("workspaces", ids.workspace))!;
    const requests = await ctx.db.query("telemetry_requests").collect();
    const visible = await filterVisibleRequests(ctx, workspace, requests);
    expect(visible.map((request) => request._id)).toEqual([
      requestIds.ownerPersonal,
      requestIds.sharedRequest,
      requestIds.standaloneGateway,
    ]);
    const hidden = (await ctx.db.get("telemetry_requests", requestIds.privateRequest))!;
    expect(await isRequestVisible(ctx, workspace, hidden)).toBe(false);
  });
});
