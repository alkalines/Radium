/// <reference types="vite/client" />

import { anyApi } from "convex/server";
import { convexTest } from "convex-test";
import { expect, test, vi } from "vitest";
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
