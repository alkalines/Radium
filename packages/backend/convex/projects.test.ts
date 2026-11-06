/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { afterEach, expect, test, vi } from "vitest";
import type { Id } from "./_generated/dataModel";
import { api } from "./_generated/api";
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

afterEach(() => {
  vi.useRealTimers();
});

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

async function workspaceFixture(t: ReturnType<typeof makeTest>) {
  return await t.run(async (ctx) => {
    const workspace = await ctx.db.insert("workspaces", {
      ownerType: "user",
      ownerId: "owner",
      name: "Shared workspace",
    });
    const otherWorkspace = await ctx.db.insert("workspaces", {
      ownerType: "user",
      ownerId: "owner",
      name: "Other workspace",
    });
    for (const userId of ["member", "other-member"]) {
      await ctx.db.insert("workspace_members", { workspace, userId, role: "member" });
    }
    return { workspace, otherWorkspace };
  });
}

function insertChat(
  t: ReturnType<typeof makeTest>,
  chat: {
    userId: string;
    workspace: Id<"workspaces">;
    scope: "personal" | "workspace";
    project?: Id<"projects">;
    lastInteractionAt: number;
  },
) {
  return t.run((ctx) =>
    ctx.db.insert("aisdk_chats", {
      ...chat,
      activeStream: false,
    }),
  );
}

const folders = [{ workerId: "worker-1", directory: "/srv/project" }];

test("Project lists sort by name, expose folders only to the owner, and mark managers", async () => {
  const t = makeTest();
  const ids = await workspaceFixture(t);
  const owner = asUser(t, "owner");
  const member = asUser(t, "member");

  const memberProject = await member.mutation(api.projects.create, {
    workspace: ids.workspace,
    name: "  zeta \n  project ",
    color: "teal",
    icon: "rocket",
  });
  const ownerProject = await owner.mutation(api.projects.create, {
    workspace: ids.workspace,
    name: "Alpha",
  });
  await t.run((ctx) => ctx.db.patch(ownerProject, { folders, defaultWorkerId: "worker-1" }));

  await expect(member.query(api.projects.list, { workspace: ids.workspace })).resolves.toEqual([
    expect.objectContaining({ _id: ownerProject, name: "Alpha", canManage: false }),
    expect.objectContaining({
      _id: memberProject,
      name: "zeta project",
      color: "teal",
      icon: "rocket",
      canManage: true,
    }),
  ]);
  const memberView = await member.query(api.projects.list, { workspace: ids.workspace });
  expect(memberView[0]).not.toHaveProperty("folders");
  expect(memberView[0]).not.toHaveProperty("defaultWorkerId");

  await expect(owner.query(api.projects.list, { workspace: ids.workspace })).resolves.toEqual([
    expect.objectContaining({
      _id: ownerProject,
      folders,
      defaultWorkerId: "worker-1",
      canManage: true,
    }),
    expect.objectContaining({ _id: memberProject, canManage: true }),
  ]);
  await expect(
    asUser(t, "outsider").query(api.projects.list, { workspace: ids.workspace }),
  ).rejects.toThrow("Workspace not found.");

  await expect(
    member.mutation(api.projects.create, { workspace: ids.workspace, name: "   " }),
  ).rejects.toThrow("Project name is required.");
  await expect(
    member.mutation(api.projects.create, { workspace: ids.workspace, name: "x", color: "#fff" }),
  ).rejects.toThrow("Unsupported Project color.");
  await expect(
    member.mutation(api.projects.create, { workspace: ids.workspace, name: "x", icon: "nope" }),
  ).rejects.toThrow("Unsupported Project icon.");
});

test("only the Project creator or workspace owner can update or remove a Project", async () => {
  const t = makeTest();
  const ids = await workspaceFixture(t);
  const owner = asUser(t, "owner");
  const member = asUser(t, "member");
  const otherMember = asUser(t, "other-member");

  const project = await member.mutation(api.projects.create, {
    workspace: ids.workspace,
    name: "Member project",
  });

  await expect(
    otherMember.mutation(api.projects.update, { project, name: "Taken over" }),
  ).rejects.toThrow("Only the Project creator or workspace owner can change this Project.");
  await expect(otherMember.mutation(api.projects.remove, { project })).rejects.toThrow(
    "Only the Project creator or workspace owner can change this Project.",
  );
  await expect(asUser(t, "outsider").mutation(api.projects.remove, { project })).rejects.toThrow(
    "Workspace not found.",
  );

  await expect(
    member.mutation(api.projects.update, { project, name: "Renamed", color: "red" }),
  ).resolves.toBeNull();
  await expect(
    owner.mutation(api.projects.update, { project, icon: "server" }),
  ).resolves.toBeNull();
  await expect(t.run((ctx) => ctx.db.get(project))).resolves.toMatchObject({
    name: "Renamed",
    color: "red",
    icon: "server",
    userId: "member",
  });

  await expect(owner.mutation(api.projects.remove, { project })).resolves.toBeNull();
  await expect(t.run((ctx) => ctx.db.get(project))).resolves.toBeNull();
});

test("only the workspace owner can change Project folders and the default Worker", async () => {
  const t = makeTest();
  const ids = await workspaceFixture(t);
  const owner = asUser(t, "owner");
  const member = asUser(t, "member");

  await expect(
    member.mutation(api.projects.create, { workspace: ids.workspace, name: "Repo", folders }),
  ).rejects.toThrow("Only the workspace owner can set a Project folder.");

  const project = await member.mutation(api.projects.create, {
    workspace: ids.workspace,
    name: "Repo",
  });
  await expect(member.mutation(api.projects.update, { project, folders })).rejects.toThrow(
    "Only the workspace owner can set a Project folder.",
  );
  await t.run((ctx) => ctx.db.patch(project, { folders, defaultWorkerId: "worker-1" }));
  await expect(
    member.mutation(api.projects.update, { project, defaultWorkerId: null }),
  ).rejects.toThrow("Only the workspace owner can set a Project folder.");
  await expect(member.mutation(api.projects.update, { project, folders: [] })).rejects.toThrow(
    "Only the workspace owner can set a Project folder.",
  );
  // Members still manage the rest of a Project they created.
  await expect(
    member.mutation(api.projects.update, { project, name: "Repo 2" }),
  ).resolves.toBeNull();

  await expect(
    owner.mutation(api.projects.update, {
      project,
      folders: [{ workerId: "worker-2", directory: "relative/path" }],
    }),
  ).rejects.toThrow("Worker directory must be an absolute path on the Worker.");
  await expect(
    owner.mutation(api.projects.update, {
      project,
      folders: [
        { workerId: "worker-2", directory: "/a" },
        { workerId: "worker-2", directory: "/b" },
      ],
    }),
  ).rejects.toThrow("Each Worker can have only one Project folder.");
  await expect(
    owner.mutation(api.projects.update, { project, defaultWorkerId: "worker-2" }),
  ).rejects.toThrow("The default Worker must have a Project folder.");
  // No Worker is enrolled in this offline fixture, so a new folder's identity lookup fails closed.
  await expect(
    owner.mutation(api.projects.update, {
      project,
      folders: [...folders, { workerId: "worker-2", directory: "/srv/two" }],
    }),
  ).rejects.toThrow("Worker must be active in this workspace.");

  // Removing the default Worker's folder clears the default with it.
  await expect(owner.mutation(api.projects.update, { project, folders: [] })).resolves.toBeNull();
  const cleared = await t.run((ctx) => ctx.db.get(project));
  expect(cleared).not.toHaveProperty("folders");
  expect(cleared).not.toHaveProperty("defaultWorkerId");
});

test("ListChats with a Project keeps personal chats private to their creator", async () => {
  const t = makeTest();
  const ids = await workspaceFixture(t);
  const owner = asUser(t, "owner");
  const member = asUser(t, "member");
  const otherMember = asUser(t, "other-member");

  const project = await owner.mutation(api.projects.create, {
    workspace: ids.workspace,
    name: "Shared project",
  });
  const memberPersonal = await insertChat(t, {
    userId: "member",
    workspace: ids.workspace,
    scope: "personal",
    project,
    lastInteractionAt: 3,
  });
  const ownerShared = await insertChat(t, {
    userId: "owner",
    workspace: ids.workspace,
    scope: "workspace",
    project,
    lastInteractionAt: 2,
  });
  const otherPersonal = await insertChat(t, {
    userId: "other-member",
    workspace: ids.workspace,
    scope: "personal",
    project,
    lastInteractionAt: 1,
  });
  const unfiled = await insertChat(t, {
    userId: "member",
    workspace: ids.workspace,
    scope: "personal",
    lastInteractionAt: 4,
  });

  const list = async (user: typeof owner, project?: Id<"projects"> | null) =>
    (
      await user.query(api.aisdk.ListChats, {
        workspace: ids.workspace,
        project,
        paginationOpts: { cursor: null, numItems: 50 },
      })
    ).page;

  const memberChats = await list(member, project);
  expect(memberChats.map((chat) => chat.id)).toEqual([memberPersonal, ownerShared]);
  expect(memberChats[0]).toMatchObject({ project, canManage: true });

  const ownerChats = await list(owner, project);
  expect(ownerChats.map((chat) => chat.id)).toEqual([ownerShared]);

  const otherChats = await list(otherMember, project);
  expect(otherChats.map((chat) => chat.id)).toEqual([ownerShared, otherPersonal]);

  const allMemberChats = await list(member);
  expect(allMemberChats.map((chat) => chat.id)).toEqual([unfiled, memberPersonal, ownerShared]);

  const foreignProject = await owner.mutation(api.projects.create, {
    workspace: ids.otherWorkspace,
    name: "Elsewhere",
  });
  await expect(list(owner, foreignProject)).rejects.toThrow("Project not found.");
});

test("ListChats with project null lists only unfiled chats under the same privacy filter", async () => {
  const t = makeTest();
  const ids = await workspaceFixture(t);
  const owner = asUser(t, "owner");
  const member = asUser(t, "member");

  const project = await owner.mutation(api.projects.create, {
    workspace: ids.workspace,
    name: "Filed",
  });
  const memberUnfiled = await insertChat(t, {
    userId: "member",
    workspace: ids.workspace,
    scope: "personal",
    lastInteractionAt: 5,
  });
  const otherUnfiledPersonal = await insertChat(t, {
    userId: "other-member",
    workspace: ids.workspace,
    scope: "personal",
    lastInteractionAt: 4,
  });
  const ownerUnfiledShared = await insertChat(t, {
    userId: "owner",
    workspace: ids.workspace,
    scope: "workspace",
    lastInteractionAt: 3,
  });
  await insertChat(t, {
    userId: "member",
    workspace: ids.workspace,
    scope: "personal",
    project,
    lastInteractionAt: 6,
  });
  await insertChat(t, {
    userId: "owner",
    workspace: ids.otherWorkspace,
    scope: "workspace",
    lastInteractionAt: 7,
  });

  const list = async (user: typeof owner) =>
    (
      await user.query(api.aisdk.ListChats, {
        workspace: ids.workspace,
        project: null,
        paginationOpts: { cursor: null, numItems: 50 },
      })
    ).page;
  const memberChats = await list(member);
  expect(memberChats.map((chat) => chat.id)).toEqual([memberUnfiled, ownerUnfiledShared]);

  // Workspace ownership never reveals a member's personal chat, filed or not.
  const ownerChats = await list(owner);
  expect(ownerChats.map((chat) => chat.id)).toEqual([ownerUnfiledShared]);
  expect(ownerChats.map((chat) => chat.id)).not.toContain(otherUnfiledPersonal);
});

test("chats are filed under same-workspace Projects by their managers", async () => {
  const t = makeTest();
  const ids = await workspaceFixture(t);
  const owner = asUser(t, "owner");
  const member = asUser(t, "member");
  const messagesQueue = { text: "", files: [], model: "test-model", webSearch: false };

  const project = await member.mutation(api.projects.create, {
    workspace: ids.workspace,
    name: "Project",
  });
  const foreignProject = await owner.mutation(api.projects.create, {
    workspace: ids.otherWorkspace,
    name: "Elsewhere",
  });

  const chatId = await member.mutation(api.aisdk.CreateChat, {
    workspace: ids.workspace,
    messages_queue: messagesQueue,
    project,
  });
  await expect(member.query(api.aisdk.GetChat, { chatId })).resolves.toMatchObject({ project });
  await expect(
    member.mutation(api.aisdk.CreateChat, {
      workspace: ids.workspace,
      messages_queue: messagesQueue,
      project: foreignProject,
    }),
  ).rejects.toThrow("Project not found.");
  await expect(
    member.mutation(api.aisdk.ForkChat, {
      workspace: ids.workspace,
      messages: [],
      project: foreignProject,
    }),
  ).rejects.toThrow("Project not found.");

  // Workspace ownership does not reach a member's personal chat.
  await expect(owner.mutation(api.aisdk.SetChatProject, { chatId, project: null })).rejects.toThrow(
    "Chat not found.",
  );
  await expect(
    member.mutation(api.aisdk.SetChatProject, { chatId, project: foreignProject }),
  ).rejects.toThrow("Project not found.");
  await expect(
    member.mutation(api.aisdk.SetChatProject, { chatId, project: null }),
  ).resolves.toBeNull();
  await expect(member.query(api.aisdk.GetChat, { chatId })).resolves.toMatchObject({
    project: null,
  });

  const forkId = await member.mutation(api.aisdk.ForkChat, {
    workspace: ids.workspace,
    messages: [],
    project,
  });
  await expect(member.query(api.aisdk.GetChat, { chatId: forkId })).resolves.toMatchObject({
    project,
  });
});

test("removing a Project detaches every chat in batches and never deletes chats", async () => {
  vi.useFakeTimers();
  const t = makeTest();
  const ids = await workspaceFixture(t);
  const owner = asUser(t, "owner");

  const project = await owner.mutation(api.projects.create, {
    workspace: ids.workspace,
    name: "Large project",
  });
  // More than one detach batch, so removal must continue in a scheduled mutation.
  const chatIds = await t.run(async (ctx) => {
    const inserted: Id<"aisdk_chats">[] = [];
    for (let index = 0; index < 300; index++) {
      inserted.push(
        await ctx.db.insert("aisdk_chats", {
          userId: "owner",
          workspace: ids.workspace,
          scope: "personal",
          project,
          activeStream: false,
          lastInteractionAt: index,
        }),
      );
    }
    return inserted;
  });

  await owner.mutation(api.projects.remove, { project });
  await t.finishAllScheduledFunctions(vi.runAllTimers);

  const chats = await t.run(async (ctx) =>
    Promise.all(chatIds.map((chatId) => ctx.db.get(chatId))),
  );
  expect(chats.every((chat) => chat !== null && chat.project === undefined)).toBe(true);
  await expect(t.run((ctx) => ctx.db.get(project))).resolves.toBeNull();
  await expect(
    owner.query(api.aisdk.ListChats, {
      workspace: ids.workspace,
      project,
      paginationOpts: { cursor: null, numItems: 50 },
    }),
  ).resolves.toMatchObject({ page: [], isDone: true });
});
