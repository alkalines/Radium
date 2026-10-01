/// <reference types="vite/client" />

import { anyApi, makeFunctionReference } from "convex/server";
import { api } from "./_generated/api";
import { convexTest } from "convex-test";
import { expect, test, vi } from "vitest";
import schema from "./schema";
import { v } from "convex/values";
import { canManageChat } from "../src/workspaces/policy";
import {
  internalWorkspaceMutation,
  internalWorkspaceQuery,
  ownedWorkspaceMutation,
  ownedWorkspaceQuery,
  workspaceMutation,
  workspaceQuery,
} from "./helpers";

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
    createAuth: vi.fn(),
  };
});

vi.mock("./auth", () => ({
  authComponent: {
    getAuthUser: authMock.getAuthUser,
    getAnyUserById: authMock.getAnyUserById,
    safeGetAuthUser: authMock.safeGetAuthUser,
  },
  createAuth: authMock.createAuth,
}));

const modules = import.meta.glob("./**/*.ts");

const readWorkspaceSettings = workspaceQuery({
  args: {},
  handler: (ctx) => ctx.workspace.settings,
});

const readManagedChat = workspaceQuery({
  args: { chatId: v.id("aisdk_chats") },
  handler: async (ctx, args) => {
    const chat = await ctx.db.get("aisdk_chats", args.chatId);
    if (!chat) throw new Error("Chat not found.");
    return canManageChat(chat, ctx.workspace, ctx.identity._id);
  },
});

const updateWorkspaceSettings = workspaceMutation({
  args: { clearDefaultModel: v.boolean() },
  handler: async (ctx, args) => {
    await ctx.workspace.updateSettings({
      defaultModel: args.clearDefaultModel ? undefined : "replacement-model",
    });
    return null;
  },
});

const readOwnedWorkspace = ownedWorkspaceQuery({
  args: {},
  handler: (ctx) => ctx.workspace._id,
});

const writeOwnedWorkspace = ownedWorkspaceMutation({
  args: {},
  handler: async (ctx) => {
    await ctx.db.patch("workspaces", ctx.workspace._id, { name: "Owner updated" });
    return null;
  },
});

const workspaceContextFixture = {
  readWorkspaceSettings,
  readManagedChat,
  updateWorkspaceSettings,
  readOwnedWorkspace,
  writeOwnedWorkspace,
};

function makeWorkspaceContextTest() {
  return convexTest({
    schema,
    modules: {
      ...modules,
      "./workspace_context_fixture.ts": async () => workspaceContextFixture,
    },
  });
}

const readWorkspaceSettingsRef = makeFunctionReference<"query">(
  "workspace_context_fixture:readWorkspaceSettings",
);
const readManagedChatRef = makeFunctionReference<"query">(
  "workspace_context_fixture:readManagedChat",
);
const updateWorkspaceSettingsRef = makeFunctionReference<"mutation">(
  "workspace_context_fixture:updateWorkspaceSettings",
);
const readOwnedWorkspaceRef = makeFunctionReference<"query">(
  "workspace_context_fixture:readOwnedWorkspace",
);
const writeOwnedWorkspaceRef = makeFunctionReference<"mutation">(
  "workspace_context_fixture:writeOwnedWorkspace",
);

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

const messagesQueue = {
  text: "",
  files: [],
  model: "test-model",
  webSearch: false,
};

test("workspace builders reject absent and expired Better Auth sessions before reading or writing", async () => {
  const t = makeTest();
  const workspace = await t.run((ctx) =>
    ctx.db.insert("workspaces", { ownerType: "user", ownerId: "owner", name: "Private" }),
  );
  await expect(t.query(api.aisdk.ListChats, { workspace })).rejects.toThrow("Not logged in.");
  await expect(
    t.mutation(api.aisdk.CreateChat, { workspace, messages_queue: messagesQueue }),
  ).rejects.toThrow("Not logged in.");

  // A JWT identity is insufficient when Better Auth rejects the session.
  authMock.getAuthUser.mockRejectedValueOnce(new Error("Unauthenticated"));
  await expect(asUser(t, "owner").query(api.models.availableModels, { workspace })).rejects.toThrow(
    "Unauthenticated",
  );
  authMock.getAuthUser.mockRejectedValueOnce(new Error("Unauthenticated"));
  await expect(
    asUser(t, "owner").mutation(api.aisdk.ForkChat, { workspace, messages: [] }),
  ).rejects.toThrow("Unauthenticated");
  expect(await t.run((ctx) => ctx.db.query("aisdk_chats").collect())).toEqual([]);
});

test("workspace mutation uses the Better Auth user once and preserves member attribution", async () => {
  const t = makeTest();
  const workspace = await t.run(async (ctx) => {
    const workspace = await ctx.db.insert("workspaces", {
      ownerType: "user",
      ownerId: "owner",
      name: "Shared",
    });
    await ctx.db.insert("workspace_members", { workspace, userId: "member", role: "member" });
    return workspace;
  });
  authMock.getAuthUser.mockClear();
  const chatId = await asUser(t, "member").mutation(api.aisdk.ForkChat, {
    workspace,
    messages: [],
  });
  expect(authMock.getAuthUser).toHaveBeenCalledTimes(1);
  expect(await t.run((ctx) => ctx.db.get("aisdk_chats", chatId))).toMatchObject({
    workspace,
    userId: "member",
    scope: "personal",
  });
  await t.run((ctx) => ctx.db.patch("workspaces", workspace, { archivedAt: Date.now() }));
  for (const userId of ["owner", "member"]) {
    await expect(asUser(t, userId).query(api.aisdk.ListChats, { workspace })).rejects.toThrow(
      "Workspace not found.",
    );
    await expect(
      asUser(t, userId).mutation(api.aisdk.ForkChat, { workspace, messages: [] }),
    ).rejects.toThrow("Workspace not found.");
  }
});

test("internal workspace builders retain internal visibility and require a session and membership", async () => {
  const read = internalWorkspaceQuery({
    args: {},
    returns: v.object({ userId: v.string(), name: v.string() }),
    handler: (ctx) => ({ userId: ctx.identity._id, name: ctx.workspace.name }),
  });
  const write = internalWorkspaceMutation({
    args: { name: v.string() },
    returns: v.null(),
    handler: async (ctx, args) => {
      await ctx.db.patch("workspaces", args.workspace, { name: args.name });
      return null;
    },
  });
  expect(read.isInternal).toBe(true);
  expect(write.isInternal).toBe(true);
  const readRef = makeFunctionReference<"query">("workspace_builder_fixture:read");
  const writeRef = makeFunctionReference<"mutation">("workspace_builder_fixture:write");
  const t = convexTest({
    schema,
    modules: {
      ...modules,
      "./workspace_builder_fixture.ts": async () => ({ read, write }),
    },
  });
  const workspace = await t.run((ctx) =>
    ctx.db.insert("workspaces", {
      ownerType: "user",
      ownerId: "owner",
      name: "Original",
    }),
  );
  for (const caller of [t, asUser(t, "outsider")]) {
    await expect(caller.query(readRef, { workspace })).rejects.toThrow();
    await expect(caller.mutation(writeRef, { workspace, name: "Denied" })).rejects.toThrow();
  }
  const owner = asUser(t, "owner");
  await expect(owner.query(readRef, { workspace })).resolves.toEqual({
    userId: "owner",
    name: "Original",
  });
  await owner.mutation(writeRef, { workspace, name: "Updated" });
  await expect(owner.query(readRef, { workspace })).resolves.toEqual({
    userId: "owner",
    name: "Updated",
  });
});

test("CreateChat and ForkChat reject a caller outside the workspace", async () => {
  const t = makeTest();
  const workspace = await t.run(async (ctx) =>
    ctx.db.insert("workspaces", {
      ownerType: "user",
      ownerId: "owner",
      name: "Owner workspace",
    }),
  );
  const outsider = asUser(t, "outsider");

  await expect(
    outsider.mutation(anyApi.aisdk.CreateChat, {
      workspace,
      messages_queue: messagesQueue,
    }),
  ).rejects.toThrow("Workspace not found.");
  await expect(
    outsider.mutation(anyApi.aisdk.ForkChat, {
      workspace,
      scope: "personal",
      messages: [],
    }),
  ).rejects.toThrow("Workspace not found.");

  const chats = await t.run(async (ctx) =>
    ctx.db
      .query("aisdk_chats")
      .withIndex("by_workspace", (q) => q.eq("workspace", workspace))
      .take(10),
  );
  expect(chats).toHaveLength(0);
});

test("HTTP chat authorization allows member shared chats but keeps personal chats private", async () => {
  const t = makeTest();
  const ids = await t.run(async (ctx) => {
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

    const sharedChat = await ctx.db.insert("aisdk_chats", {
      userId: "owner",
      workspace,
      scope: "workspace",
      messages: [],
      chat_completions: [],
      activeStream: false,
      lastInteractionAt: Date.now(),
    });
    const personalChat = await ctx.db.insert("aisdk_chats", {
      userId: "member",
      workspace,
      scope: "personal",
      messages: [],
      chat_completions: [],
      activeStream: false,
      lastInteractionAt: Date.now(),
    });

    return { workspace, sharedChat, personalChat };
  });

  const member = asUser(t, "member");
  const owner = asUser(t, "owner");
  const outsider = asUser(t, "outsider");

  await expect(
    member.query(anyApi.workspaces.authorizeChatForUser, {
      chatId: ids.sharedChat,
      userId: "member",
    }),
  ).resolves.toMatchObject({
    chat: { _id: ids.sharedChat },
    workspace: { _id: ids.workspace },
  });
  await expect(
    member.query(anyApi.workspaces.authorizeChatForUser, {
      chatId: ids.personalChat,
      userId: "member",
    }),
  ).resolves.toMatchObject({
    chat: { _id: ids.personalChat },
    workspace: { _id: ids.workspace },
  });
  await expect(
    outsider.query(anyApi.workspaces.authorizeChatForUser, {
      chatId: ids.sharedChat,
      userId: "outsider",
    }),
  ).resolves.toBeNull();

  await expect(owner.query(anyApi.aisdk.GetChat, { chatId: ids.personalChat })).rejects.toThrow(
    "Chat not found.",
  );
  await expect(
    member.query(anyApi.aisdk.GetChat, { chatId: ids.personalChat }),
  ).resolves.toMatchObject({
    id: ids.personalChat,
    scope: "personal",
  });
});

test("workspace icons are owner-managed and visible to members", async () => {
  const t = makeTest();
  const workspace = await t.run(async (ctx) => {
    const workspaceId = await ctx.db.insert("workspaces", {
      ownerType: "user",
      ownerId: "owner",
      name: "Shared workspace",
    });
    await ctx.db.insert("workspace_members", {
      workspace: workspaceId,
      userId: "member",
      role: "member",
    });
    return workspaceId;
  });
  const owner = asUser(t, "owner");
  const member = asUser(t, "member");

  await expect(
    owner.mutation(anyApi.workspaces.setIcon, { workspace, icon: "rocket" }),
  ).resolves.toBeNull();
  await expect(member.query(anyApi.workspaces.list, {})).resolves.toContainEqual(
    expect.objectContaining({ _id: workspace, icon: "rocket", role: "member" }),
  );
  await expect(
    member.mutation(anyApi.workspaces.setIcon, { workspace, icon: "server" }),
  ).rejects.toThrow("Workspace not found.");
  await expect(
    owner.mutation(anyApi.workspaces.setIcon, { workspace, icon: "not-supported" }),
  ).rejects.toThrow("Unsupported workspace icon.");

  await t.run(async (ctx) => ctx.db.patch(workspace, { archivedAt: Date.now() }));
  await expect(
    owner.mutation(anyApi.workspaces.setIcon, { workspace, icon: "server" }),
  ).rejects.toThrow("Workspace not found.");
});

test("workspaceQuery exposes effective settings without leaking legacy settings", async () => {
  const t = makeWorkspaceContextTest();
  const ids = await t.run(async (ctx) => {
    const defaultWorkspace = await ctx.db.insert("workspaces", {
      ownerType: "user",
      ownerId: "owner",
      name: "Default workspace",
    });
    const otherWorkspace = await ctx.db.insert("workspaces", {
      ownerType: "user",
      ownerId: "owner",
      name: "Other workspace",
    });
    await ctx.db.insert("chatroom_settings", {
      userId: "owner",
      defaultModel: "legacy-model",
      titleModel: "legacy-title-model",
      enableChainOfThought: false,
      telemetry: { enabled: true, recordInputs: true, recordOutputs: true },
      builtinToolSets: ["legacy-tool"],
      mcpServers: [],
    });
    return { defaultWorkspace, otherWorkspace };
  });

  const owner = asUser(t, "owner");
  await expect(
    owner.query(readWorkspaceSettingsRef, { workspace: ids.defaultWorkspace }),
  ).resolves.toEqual({
    workspace: ids.defaultWorkspace,
    defaultModel: "legacy-model",
    titleModel: "legacy-title-model",
    enableChainOfThought: false,
    telemetry: { enabled: true, recordInputs: true, recordOutputs: true },
    builtinToolSets: ["legacy-tool"],
    mcpServers: [],
  });
  await expect(
    owner.query(readWorkspaceSettingsRef, { workspace: ids.otherWorkspace }),
  ).resolves.toEqual({
    workspace: ids.otherWorkspace,
    builtinToolSets: [],
    mcpServers: [],
  });
});

test("workspaceMutation updateSettings preserves fields and clears an explicit model", async () => {
  const t = makeWorkspaceContextTest();
  const ids = await t.run(async (ctx) => {
    const defaultWorkspace = await ctx.db.insert("workspaces", {
      ownerType: "user",
      ownerId: "owner",
      name: "Default workspace",
    });
    const existingWorkspace = await ctx.db.insert("workspaces", {
      ownerType: "user",
      ownerId: "owner",
      name: "Existing settings workspace",
    });
    await ctx.db.insert("workspace_members", {
      workspace: defaultWorkspace,
      userId: "member",
      role: "member",
    });
    await ctx.db.insert("chatroom_settings", {
      userId: "owner",
      defaultModel: "legacy-model",
      titleModel: "legacy-title-model",
      enableChainOfThought: false,
      telemetry: { enabled: true, recordInputs: true, recordOutputs: true },
      builtinToolSets: ["legacy-tool"],
      mcpServers: [],
    });
    const existingSettings = await ctx.db.insert("workspace_settings", {
      workspace: existingWorkspace,
      defaultModel: "current-model",
      titleModel: "current-title-model",
      enableChainOfThought: true,
      telemetry: { enabled: false, recordInputs: false, recordOutputs: false },
      builtinToolSets: ["current-tool"],
      mcpServers: [],
    });
    return { defaultWorkspace, existingWorkspace, existingSettings };
  });

  const owner = asUser(t, "owner");
  const member = asUser(t, "member");

  await expect(
    member.mutation(updateWorkspaceSettingsRef, {
      workspace: ids.defaultWorkspace,
      clearDefaultModel: true,
    }),
  ).rejects.toThrow();

  await owner.mutation(updateWorkspaceSettingsRef, {
    workspace: ids.defaultWorkspace,
    clearDefaultModel: true,
  });
  const materialized = await t.run(
    async (ctx) =>
      await ctx.db
        .query("workspace_settings")
        .withIndex("by_workspace", (q) => q.eq("workspace", ids.defaultWorkspace))
        .unique(),
  );
  expect(materialized).toMatchObject({
    workspace: ids.defaultWorkspace,
    titleModel: "legacy-title-model",
    enableChainOfThought: false,
    telemetry: { enabled: true, recordInputs: true, recordOutputs: true },
    builtinToolSets: ["legacy-tool"],
    mcpServers: [],
  });
  expect(materialized).not.toHaveProperty("defaultModel");
  await expect(
    owner.query(readWorkspaceSettingsRef, { workspace: ids.defaultWorkspace }),
  ).resolves.toEqual({
    workspace: ids.defaultWorkspace,
    titleModel: "legacy-title-model",
    enableChainOfThought: false,
    telemetry: { enabled: true, recordInputs: true, recordOutputs: true },
    builtinToolSets: ["legacy-tool"],
    mcpServers: [],
  });

  await owner.mutation(updateWorkspaceSettingsRef, {
    workspace: ids.existingWorkspace,
    clearDefaultModel: true,
  });
  const patched = await t.run((ctx) => ctx.db.get("workspace_settings", ids.existingSettings));
  expect(patched?._id).toBe(ids.existingSettings);
  expect(patched).toMatchObject({
    workspace: ids.existingWorkspace,
    titleModel: "current-title-model",
    enableChainOfThought: true,
    telemetry: { enabled: false, recordInputs: false, recordOutputs: false },
    builtinToolSets: ["current-tool"],
    mcpServers: [],
  });
  expect(patched).not.toHaveProperty("defaultModel");
});

test("chat management policy uses the authenticated workspace caller", async () => {
  const t = makeWorkspaceContextTest();
  const ids = await t.run(async (ctx) => {
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
    const insertChat = (userId: string, scope: "personal" | "workspace") =>
      ctx.db.insert("aisdk_chats", {
        userId,
        workspace,
        scope,
        messages: [],
        chat_completions: [],
        activeStream: false,
        lastInteractionAt: Date.now(),
      });
    const ownerShared = await insertChat("owner", "workspace");
    const memberShared = await insertChat("member", "workspace");
    const memberPersonal = await insertChat("member", "personal");
    return { workspace, ownerShared, memberShared, memberPersonal };
  });

  const owner = asUser(t, "owner");
  const member = asUser(t, "member");
  const canManage = (caller: typeof owner, chatId: typeof ids.ownerShared) =>
    caller.query(readManagedChatRef, { workspace: ids.workspace, chatId });

  await expect(canManage(owner, ids.ownerShared)).resolves.toBe(true);
  await expect(canManage(member, ids.ownerShared)).resolves.toBe(false);
  await expect(canManage(owner, ids.memberShared)).resolves.toBe(true);
  await expect(canManage(member, ids.memberShared)).resolves.toBe(true);
  await expect(canManage(owner, ids.memberPersonal)).resolves.toBe(false);
  await expect(canManage(member, ids.memberPersonal)).resolves.toBe(true);
});

test("owned workspace builders reject members", async () => {
  const t = makeWorkspaceContextTest();
  const workspace = await t.run(async (ctx) => {
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
    return workspace;
  });

  await expect(asUser(t, "owner").query(readOwnedWorkspaceRef, { workspace })).resolves.toBe(
    workspace,
  );
  await expect(asUser(t, "member").query(readOwnedWorkspaceRef, { workspace })).rejects.toThrow(
    "Workspace not found.",
  );

  await expect(
    asUser(t, "owner").mutation(writeOwnedWorkspaceRef, { workspace }),
  ).resolves.toBeNull();
  await expect(asUser(t, "member").mutation(writeOwnedWorkspaceRef, { workspace })).rejects.toThrow(
    "Workspace not found.",
  );
});
