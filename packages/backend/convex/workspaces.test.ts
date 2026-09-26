/// <reference types="vite/client" />

import { anyApi, makeFunctionReference } from "convex/server";
import { api } from "./_generated/api";
import { convexTest } from "convex-test";
import { expect, test, vi } from "vitest";
import schema from "./schema";
import { v } from "convex/values";
import { internalWorkspaceMutation, internalWorkspaceQuery } from "./helpers";

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
