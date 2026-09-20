/// <reference types="vite/client" />

import { anyApi } from "convex/server";
import { convexTest } from "convex-test";
import { expect, test, vi } from "vitest";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

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
