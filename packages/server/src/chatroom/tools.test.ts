import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addModel, addProvider, offer } from "../../test/gateway";
import { createTestRuntime, type TestRuntime } from "../../test/runtime";
import { classicUser } from "../../test/users";
import { authors, models } from "../gateway/schema";
import { getSecret } from "../gateway/secrets";
import { appRouter } from "../trpc/router";
import {
  workspaceMcpServers,
  workspaceMembers,
  workspaces,
  workspaceSettings,
} from "../workspaces/schema";
import { chatMembers, chatMcpServers, chats, mcpServers } from "./schema";
import {
  resolveChatTools,
  resolveSystemPrompt,
  resolveWebSearch,
  titleModelFor,
} from "./settings";
import { builtinToolCredential, mcpBearerToken } from "./tools";

// Chatroom tool configuration and workspace chat settings through the real router:
// owner/member/outsider/archived boundaries, personal-chat privacy of chat tool overrides,
// MCP secrets, selections, and the invariants that relied on Convex serializing mutations.

type Role = "owner" | "member" | "other" | "outsider";

let test: TestRuntime;
const users = {} as Record<Role, { id: string; headers: Headers }>;
let workspace = "";
let archived = "";
let foreign = "";

const call = (role: Role) =>
  appRouter.createCaller({ runtime: test.runtime, headers: users[role].headers });
const db = () => test.runtime.drivers.db;

async function addWorkspace(ownerId: string, values: Partial<typeof workspaces.$inferInsert> = {}) {
  const [row] = await db()
    .insert(workspaces)
    .values({ ownerId, name: "Workspace", ...values })
    .returning();
  return row!.id;
}

async function addChat(
  userId: string,
  scope: "personal" | "shared" | "workspace",
  target = workspace,
) {
  const [row] = await db().insert(chats).values({ userId, workspace: target, scope }).returning();
  return row!.id;
}

async function addServer(target: string, name = "Search") {
  return call(target === foreign ? "outsider" : "owner").tools.createMcpServer({
    workspace: target,
    name,
    url: "https://mcp.example.test/mcp",
    auth: { type: "none" },
  });
}

const bearerLocation = (target: string, server: string) => ({
  namespace: `workspace:${target}:mcp:${server}`,
  name: "bearer",
});

beforeAll(async () => {
  test = await createTestRuntime();
  for (const role of ["owner", "member", "other", "outsider"] as const) {
    users[role] = await classicUser(test.runtime, `tools-${role}@example.test`);
  }
  workspace = await addWorkspace(users.owner.id);
  archived = await addWorkspace(users.owner.id, { archivedAt: new Date() });
  foreign = await addWorkspace(users.outsider.id);
  for (const target of [workspace, archived]) {
    for (const role of ["member", "other"] as const) {
      await db()
        .insert(workspaceMembers)
        .values({ workspace: target, userId: users[role].id, role: "member" });
    }
  }
});

afterAll(async () => {
  await test?.close();
});

describe("authorization boundaries", () => {
  type Caller = ReturnType<typeof call>;
  const serverId = "00000000-0000-0000-0000-000000000000";
  const ownerOnly = (target: string) => [
    (c: Caller) =>
      c.tools.createMcpServer({
        workspace: target,
        name: "X",
        url: "https://x.example.test",
        auth: { type: "none" },
      }),
    (c: Caller) => c.tools.updateMcpServer({ workspace: target, server: serverId, name: "Y" }),
    (c: Caller) => c.tools.deleteMcpServer({ workspace: target, server: serverId }),
    (c: Caller) => c.tools.getExaApiKey({ workspace: target }),
    (c: Caller) => c.tools.setExaApiKey({ workspace: target, apiKey: "key" }),
    (c: Caller) => c.tools.deleteExaApiKey({ workspace: target }),
    (c: Caller) =>
      c.chatroom.setToolDefaults({
        workspace: target,
        selection: { builtinToolSets: [], mcpServers: [] },
      }),
    (c: Caller) => c.chatroom.setWorkerToolDefaults({ workspace: target, tools: ["read"] }),
    (c: Caller) => c.chatroom.setModelDefault({ workspace: target }),
    (c: Caller) => c.chatroom.setTitleModelDefault({ workspace: target }),
    (c: Caller) => c.chatroom.setChainOfThoughtEnabled({ workspace: target, enabled: false }),
    (c: Caller) =>
      c.chatroom.setSystemPromptSettings({ workspace: target, enabled: true, modelIdentity: true }),
  ];
  const memberReads = (target: string) => [
    (c: Caller) => c.tools.listMcpServers({ workspace: target }),
    (c: Caller) => c.chatroom.getToolDefaults({ workspace: target }),
    (c: Caller) => c.chatroom.getWorkerToolDefaults({ workspace: target }),
    (c: Caller) => c.chatroom.getModelDefault({ workspace: target }),
    (c: Caller) => c.chatroom.getTitleModelDefault({ workspace: target }),
    (c: Caller) => c.chatroom.getChainOfThoughtEnabled({ workspace: target }),
    (c: Caller) => c.chatroom.getSystemPromptSettings({ workspace: target }),
  ];

  it("refuses owner-only procedures to members, outsiders and archived workspaces alike", async () => {
    for (const run of ownerOnly(workspace)) {
      await expect(run(call("member"))).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(run(call("outsider"))).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    for (const run of ownerOnly(archived)) {
      await expect(run(call("owner"))).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
  });

  it("lets members read settings but not outsiders or archived workspaces", async () => {
    for (const run of memberReads(workspace)) {
      await expect(run(call("owner"))).resolves.not.toThrow();
      await expect(run(call("member"))).resolves.not.toThrow();
      await expect(run(call("outsider"))).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    for (const run of memberReads(archived)) {
      await expect(run(call("member"))).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
  });

  it("requires a session", async () => {
    const anonymous = appRouter.createCaller({ runtime: test.runtime, headers: new Headers() });
    await expect(anonymous.chatroom.getToolDefaults({ workspace })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(anonymous.chatroom.getChatTools({ chatId: "x" })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });
});

describe("MCP servers", () => {
  it("creates, lists without secrets and keeps the bearer token in the Secret Store", async () => {
    const server = await call("owner").tools.createMcpServer({
      workspace,
      name: "  Docs  ",
      url: " https://mcp.example.test/docs ",
      auth: { type: "bearer" },
      secret: "  super-secret-token  ",
      codeMode: false,
    });

    const listed = await call("member").tools.listMcpServers({ workspace });
    const row = listed.find((entry) => entry.id === server)!;
    expect(row).toMatchObject({
      name: "Docs",
      url: "https://mcp.example.test/docs",
      transport: "http",
      auth: { type: "bearer" },
      preview: { token: "****oken" },
      hasSecret: true,
      codeMode: false,
    });
    expect(JSON.stringify(listed)).not.toContain("super-secret-token");

    const stored = await getSecret(db(), test.runtime.secrets, bearerLocation(workspace, server));
    expect(stored).toMatchObject({ ok: true, value: "super-secret-token" });
    expect(await mcpBearerToken(test.runtime, workspace, server)).toBe("super-secret-token");
  });

  it("defaults to Code Mode and validates input", async () => {
    const server = await addServer(workspace, "Defaults");
    const listed = await call("owner").tools.listMcpServers({ workspace });
    expect(listed.find((entry) => entry.id === server)).toMatchObject({
      codeMode: true,
      preview: null,
      hasSecret: false,
    });
    const create = (input: { url: string; auth?: { type: "none" | "bearer" }; secret?: string; name?: string }) =>
      call("owner").tools.createMcpServer({
        workspace,
        name: input.name ?? "Bad",
        url: input.url,
        auth: input.auth ?? { type: "none" },
        secret: input.secret,
      });
    await expect(create({ url: "file:///etc/passwd" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(create({ url: "relative" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(create({ url: "https://x.example.test", name: "  " })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(
      create({ url: "https://x.example.test", auth: { type: "bearer" }, secret: "  " }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("bearer token") });
    await expect(
      create({ url: `https://x.example.test/${"a".repeat(3000)}` }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("updates: keeps, replaces and clears the token; refuses bearer without one", async () => {
    const owner = call("owner");
    const server = await owner.tools.createMcpServer({
      workspace,
      name: "Upd",
      url: "https://mcp.example.test/upd",
      auth: { type: "bearer" },
      secret: "first-token-1111",
    });
    const read = () => getSecret(db(), test.runtime.secrets, bearerLocation(workspace, server));

    await owner.tools.updateMcpServer({ workspace, server, name: "Renamed", codeMode: false });
    expect(await read()).toMatchObject({ ok: true, value: "first-token-1111" });

    await owner.tools.updateMcpServer({ workspace, server, secret: "second-token-2222" });
    expect(await read()).toMatchObject({ ok: true, value: "second-token-2222" });
    const [replaced] = (await owner.tools.listMcpServers({ workspace })).filter((s) => s.id === server);
    expect(replaced).toMatchObject({ name: "Renamed", codeMode: false, preview: { token: "****2222" } });

    await owner.tools.updateMcpServer({ workspace, server, auth: { type: "none" } });
    expect(await read()).toMatchObject({ ok: false, reason: "not_found" });
    const [cleared] = (await owner.tools.listMcpServers({ workspace })).filter((s) => s.id === server);
    expect(cleared).toMatchObject({ auth: { type: "none" }, preview: null, hasSecret: false });

    await expect(
      owner.tools.updateMcpServer({ workspace, server, auth: { type: "bearer" } }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await owner.tools.updateMcpServer({ workspace, server, auth: { type: "bearer" }, secret: "third-3333" });
    expect(await read()).toMatchObject({ ok: true, value: "third-3333" });
  });

  it("never touches a server of another workspace", async () => {
    const other = await addServer(foreign, "Foreign");
    await expect(
      call("owner").tools.updateMcpServer({ workspace, server: other, name: "Mine" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(call("owner").tools.deleteMcpServer({ workspace, server: other })).resolves.toBe(true);
    const [row] = await db().select().from(mcpServers).where(eq(mcpServers.id, other));
    expect(row).toMatchObject({ name: "Foreign", workspace: foreign });
  });

  it("deletes the server with its secret; unknown servers are a no-op", async () => {
    const owner = call("owner");
    const server = await owner.tools.createMcpServer({
      workspace,
      name: "Gone",
      url: "https://mcp.example.test/gone",
      auth: { type: "bearer" },
      secret: "delete-me-9999",
    });
    await expect(owner.tools.deleteMcpServer({ workspace, server })).resolves.toBe(true);
    await expect(owner.tools.deleteMcpServer({ workspace, server })).resolves.toBe(true);
    expect(await db().select().from(mcpServers).where(eq(mcpServers.id, server))).toHaveLength(0);
    expect(
      await getSecret(db(), test.runtime.secrets, bearerLocation(workspace, server)),
    ).toMatchObject({ ok: false, reason: "not_found" });
  });
});

describe("Exa key", () => {
  it("stores a masked preview and serves the key to the runtime only", async () => {
    const owner = call("owner");
    expect(await owner.tools.getExaApiKey({ workspace })).toBeNull();
    expect(await builtinToolCredential(test.runtime, workspace, "exa")).toBeNull();

    await expect(owner.tools.setExaApiKey({ workspace, apiKey: "  " })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await owner.tools.setExaApiKey({ workspace, apiKey: "  exa-secret-1234  " });
    const preview = await owner.tools.getExaApiKey({ workspace });
    expect(preview).toEqual({ preview: "****1234" });
    expect(JSON.stringify(preview)).not.toContain("exa-secret");
    expect(await builtinToolCredential(test.runtime, workspace, "exa")).toBe("exa-secret-1234");
    expect(
      await getSecret(db(), test.runtime.secrets, { namespace: `workspace:${workspace}:tools`, name: "exa" }),
    ).toMatchObject({ ok: true, value: "exa-secret-1234" });

    await owner.tools.setExaApiKey({ workspace, apiKey: "exa-other-5678" });
    expect(await owner.tools.getExaApiKey({ workspace })).toEqual({ preview: "****5678" });

    await expect(owner.tools.deleteExaApiKey({ workspace })).resolves.toBe(true);
    expect(await owner.tools.getExaApiKey({ workspace })).toBeNull();
    expect(await builtinToolCredential(test.runtime, workspace, "exa")).toBeNull();
  });
});

describe("tool selections", () => {
  it("reads default-on sets when nothing is stored, then round-trips a selection", async () => {
    const fresh = await addWorkspace(users.owner.id);
    const owner = call("owner");
    const initial = await owner.chatroom.getToolDefaults({ workspace: fresh });
    expect(initial).toEqual({
      builtinToolSets: ["question", "todo_write", "code_interpreter"],
      mcpServers: [],
    });

    const server = await addServer(fresh);
    await owner.chatroom.setToolDefaults({
      workspace: fresh,
      selection: { builtinToolSets: ["web_search", "todo_write", "bogus"], mcpServers: [server, server] },
    });
    expect(await owner.chatroom.getToolDefaults({ workspace: fresh })).toEqual({
      builtinToolSets: ["todo_write", "web_search"],
      mcpServers: [server],
    });
    const [settings] = await db().select().from(workspaceSettings).where(eq(workspaceSettings.workspace, fresh));
    expect(settings).toMatchObject({
      builtinToolSets: ["web_search"],
      disabledBuiltinToolSets: ["question", "code_interpreter"],
    });
    // Members read the same defaults.
    await db().insert(workspaceMembers).values({ workspace: fresh, userId: users.member.id, role: "member" });
    expect(await call("member").chatroom.getToolDefaults({ workspace: fresh })).toEqual({
      builtinToolSets: ["todo_write", "web_search"],
      mcpServers: [server],
    });
  });

  it("drops servers of other workspaces and unknown ids from a selection", async () => {
    const own = await addServer(workspace, "Own");
    const other = await addServer(foreign, "Other");
    const owner = call("owner");
    await owner.chatroom.setToolDefaults({
      workspace,
      selection: { builtinToolSets: [], mcpServers: [other, "missing", own] },
    });
    expect((await owner.chatroom.getToolDefaults({ workspace })).mcpServers).toEqual([own]);
    expect(
      await db().select().from(workspaceMcpServers).where(eq(workspaceMcpServers.mcpServer, other)),
    ).toHaveLength(0);

    const chat = await addChat(users.owner.id, "personal");
    await owner.chatroom.setChatTools({
      chatId: chat,
      selection: { builtinToolSets: [], mcpServers: [other, own] },
    });
    expect((await owner.chatroom.getChatTools({ chatId: chat })).mcpServers).toEqual([own]);
  });

  it("deleting a server drops it from defaults and chat overrides", async () => {
    const target = await addWorkspace(users.owner.id);
    const owner = call("owner");
    const keep = await addServer(target, "Keep");
    const drop = await addServer(target, "Drop");
    const selection = { builtinToolSets: ["web_search"], mcpServers: [keep, drop] };
    await owner.chatroom.setToolDefaults({ workspace: target, selection });
    const chat = await addChat(users.owner.id, "personal", target);
    await owner.chatroom.setChatTools({ chatId: chat, selection });

    await owner.tools.deleteMcpServer({ workspace: target, server: drop });

    expect((await owner.chatroom.getToolDefaults({ workspace: target })).mcpServers).toEqual([keep]);
    expect((await owner.chatroom.getChatTools({ chatId: chat })).mcpServers).toEqual([keep]);
    expect(
      await db().select().from(chatMcpServers).where(eq(chatMcpServers.mcpServer, drop)),
    ).toHaveLength(0);
  });

  it("stores worker tool defaults uniquely", async () => {
    const owner = call("owner");
    await expect(owner.chatroom.getWorkerToolDefaults({ workspace })).resolves.toEqual([]);
    await expect(
      owner.chatroom.setWorkerToolDefaults({ workspace, tools: ["read", "read"] }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await owner.chatroom.setWorkerToolDefaults({ workspace, tools: ["read", "bash"] });
    expect(await call("member").chatroom.getWorkerToolDefaults({ workspace })).toEqual(["read", "bash"]);
    await owner.chatroom.setWorkerToolDefaults({ workspace, tools: [] });
    expect(await owner.chatroom.getWorkerToolDefaults({ workspace })).toEqual([]);
  });
});

describe("chat tools", () => {
  const selection = { builtinToolSets: ["web_search"], mcpServers: [] as string[] };

  it("inherits the workspace defaults until a chat override is written", async () => {
    const chat = await addChat(users.member.id, "personal");
    const defaults = await call("member").chatroom.getChatTools({ chatId: chat });
    expect(defaults.source).toBe("defaults");

    await call("member").chatroom.setChatTools({ chatId: chat, selection });
    expect(await call("member").chatroom.getChatTools({ chatId: chat })).toEqual({
      builtinToolSets: ["web_search"],
      mcpServers: [],
      source: "chat",
    });
    // An empty override is still an override.
    await call("member").chatroom.setChatTools({
      chatId: chat,
      selection: { builtinToolSets: [], mcpServers: [] },
    });
    expect(await call("member").chatroom.getChatTools({ chatId: chat })).toEqual({
      builtinToolSets: [],
      mcpServers: [],
      source: "chat",
    });
  });

  it("keeps a member's personal chat private from the workspace owner", async () => {
    const chat = await addChat(users.member.id, "personal");
    await call("member").chatroom.setChatTools({ chatId: chat, selection });
    for (const role of ["owner", "other", "outsider"] as const) {
      await expect(call(role).chatroom.getChatTools({ chatId: chat })).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      await expect(
        call(role).chatroom.setChatTools({ chatId: chat, selection: { builtinToolSets: [], mcpServers: [] } }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    expect((await call("member").chatroom.getChatTools({ chatId: chat })).builtinToolSets).toEqual([
      "web_search",
    ]);
  });

  it("lets a shared-chat member read but not set", async () => {
    const chat = await addChat(users.member.id, "shared");
    await db()
      .insert(chatMembers)
      .values({ chat, workspace, userId: users.other.id, lastInteractionAt: new Date() });
    await call("member").chatroom.setChatTools({ chatId: chat, selection });
    expect(await call("other").chatroom.getChatTools({ chatId: chat })).toMatchObject({
      source: "chat",
      builtinToolSets: ["web_search"],
    });
    await expect(
      call("other").chatroom.setChatTools({ chatId: chat, selection: { builtinToolSets: [], mcpServers: [] } }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(call("owner").chatroom.getChatTools({ chatId: chat })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect((await call("member").chatroom.getChatTools({ chatId: chat })).builtinToolSets).toEqual([
      "web_search",
    ]);
  });

  it("lets the workspace owner manage workspace chats, members only read", async () => {
    const chat = await addChat(users.member.id, "workspace");
    await call("owner").chatroom.setChatTools({ chatId: chat, selection });
    expect(await call("other").chatroom.getChatTools({ chatId: chat })).toMatchObject({
      source: "chat",
    });
    await expect(
      call("other").chatroom.setChatTools({ chatId: chat, selection: { builtinToolSets: [], mcpServers: [] } }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(call("outsider").chatroom.getChatTools({ chatId: chat })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("refuses chats of archived workspaces and unknown chats", async () => {
    const chat = await addChat(users.owner.id, "workspace", archived);
    await expect(call("owner").chatroom.getChatTools({ chatId: chat })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      call("owner").chatroom.setChatTools({ chatId: chat, selection }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(call("owner").chatroom.getChatTools({ chatId: "nope" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("resolves a run's tools: built-in ids and server records without secrets", async () => {
    const target = await addWorkspace(users.owner.id);
    const owner = call("owner");
    const first = await owner.tools.createMcpServer({
      workspace: target,
      name: "First",
      url: "https://mcp.example.test/1",
      auth: { type: "bearer" },
      secret: "resolve-token-0000",
    });
    const second = await addServer(target, "Second");
    const chat = await addChat(users.owner.id, "personal", target);
    const row = async () => (await db().select().from(chats).where(eq(chats.id, chat)))[0]!;

    await owner.chatroom.setToolDefaults({
      workspace: target,
      selection: { builtinToolSets: ["web_search"], mcpServers: [first] },
    });
    const inherited = await resolveChatTools(db(), await row(), target);
    expect(inherited.builtinToolSets).toEqual(["web_search"]);
    expect(inherited.mcpServers).toEqual([
      {
        id: first,
        workspace: target,
        name: "First",
        url: "https://mcp.example.test/1",
        transport: "http",
        auth: { type: "bearer" },
        codeMode: true,
      },
    ]);
    expect(JSON.stringify(inherited)).not.toContain("resolve-token");
    expect((await resolveWebSearch(db(), await row(), target))).toEqual({ enabled: true, workspace: target });

    await owner.chatroom.setChatTools({
      chatId: chat,
      selection: { builtinToolSets: ["question"], mcpServers: [second, first] },
    });
    const own = await resolveChatTools(db(), await row(), target);
    expect(own.builtinToolSets).toEqual(["question"]);
    expect(own.mcpServers.map((server) => server.id).sort()).toEqual([first, second].sort());
    expect(await resolveWebSearch(db(), await row(), target)).toEqual({ enabled: false, workspace: null });
  });
});

describe("models and prompt settings", () => {
  let target = "";
  let chatModel = "";
  let embedding = "";

  beforeAll(async () => {
    target = await addWorkspace(users.owner.id);
    await db()
      .insert(workspaceMembers)
      .values({ workspace: target, userId: users.member.id, role: "member" });
    chatModel = await addModel(test.runtime, "tools/chat-model");
    await addModel(test.runtime, "tools/not-offered");
    embedding = "tools/embedding-model";
    const [author] = await db().select().from(authors).where(eq(authors.slug, "test"));
    await db()
      .insert(models)
      .values({
        name: embedding,
        slug: embedding,
        launchDate: new Date(0),
        author: author!.id,
        type: "embedding",
        description: "embedding",
        reasoning: false,
        architecture: { input_modalities: ["text"], output_modalities: ["embedding"], tokenizer: "GPT" },
      })
      .onConflictDoNothing();
    await addProvider(test.runtime, target, {
      slug: "tools-provider",
      models: [offer(chatModel), offer(embedding)],
    });
  });

  it("sets and clears the default model, validating the catalogue and workspace", async () => {
    const owner = call("owner");
    expect(await owner.chatroom.getModelDefault({ workspace: target })).toBeNull();
    await expect(
      owner.chatroom.setModelDefault({ workspace: target, model: "tools/unknown" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "Unknown model." });
    await expect(
      owner.chatroom.setModelDefault({ workspace: target, model: "tools/not-offered" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "Model is not configured for this workspace." });

    await owner.chatroom.setModelDefault({ workspace: target, model: chatModel });
    expect(await call("member").chatroom.getModelDefault({ workspace: target })).toBe(chatModel);

    await owner.chatroom.setModelDefault({ workspace: target });
    expect(await owner.chatroom.getModelDefault({ workspace: target })).toBeNull();
  });

  it("reads a default model whose provider offer was removed as unset", async () => {
    const stale = await addWorkspace(users.owner.id);
    const [credential] = await addProvider(test.runtime, stale, { slug: "stale", models: [offer(chatModel)] });
    expect(credential).toBeDefined();
    await call("owner").chatroom.setModelDefault({ workspace: stale, model: chatModel });
    expect(await call("owner").chatroom.getModelDefault({ workspace: stale })).toBe(chatModel);
    await call("owner").providers.setEnabled({ workspace: stale, slug: "stale", enabled: false });
    expect(await call("owner").chatroom.getModelDefault({ workspace: stale })).toBeNull();
  });

  it("only accepts text-to-text chat models as title models", async () => {
    const owner = call("owner");
    await expect(
      owner.chatroom.setTitleModelDefault({ workspace: target, model: embedding }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "Unknown title model." });
    await expect(
      owner.chatroom.setTitleModelDefault({ workspace: target, model: "tools/not-offered" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await owner.chatroom.setTitleModelDefault({ workspace: target, model: chatModel });
    expect(await owner.chatroom.getTitleModelDefault({ workspace: target })).toBe(chatModel);
    await owner.chatroom.setTitleModelDefault({ workspace: target, model: null });
    expect(await owner.chatroom.getTitleModelDefault({ workspace: target })).toBeNull();
  });

  it("chooses the title model: preferred, else default, else the first usable one", async () => {
    const fallback = await addWorkspace(users.owner.id);
    expect(await titleModelFor(db(), fallback)).toBeNull();
    await addProvider(test.runtime, fallback, { slug: "p", models: [offer(embedding), offer(chatModel)] });
    // The embedding model cannot title; the chat model is the first usable one.
    expect(await titleModelFor(db(), fallback)).toBe(chatModel);
    await call("owner").chatroom.setModelDefault({ workspace: fallback, model: chatModel });
    expect(await titleModelFor(db(), fallback)).toBe(chatModel);
    expect(await titleModelFor(db(), archived)).toBeNull();
  });

  it("keeps Chain of Thought on by default and stores the switch", async () => {
    const owner = call("owner");
    expect(await owner.chatroom.getChainOfThoughtEnabled({ workspace: target })).toBe(true);
    await owner.chatroom.setChainOfThoughtEnabled({ workspace: target, enabled: false });
    expect(await call("member").chatroom.getChainOfThoughtEnabled({ workspace: target })).toBe(false);
    await owner.chatroom.setChainOfThoughtEnabled({ workspace: target, enabled: true });
    expect(await owner.chatroom.getChainOfThoughtEnabled({ workspace: target })).toBe(true);
  });

  it("stores system prompt switches and resolves the prompt identity", async () => {
    const owner = call("owner");
    expect(await owner.chatroom.getSystemPromptSettings({ workspace: target })).toEqual({
      enabled: true,
      modelIdentity: true,
    });
    expect(await resolveSystemPrompt(db(), target, chatModel)).toEqual({
      model: { slug: chatModel, name: chatModel, author: "Test" },
    });
    expect(await resolveSystemPrompt(db(), target, "tools/provider-only")).toEqual({
      model: { slug: "tools/provider-only" },
    });

    await owner.chatroom.setSystemPromptSettings({ workspace: target, enabled: true, modelIdentity: false });
    expect(await resolveSystemPrompt(db(), target, chatModel)).toEqual({});

    await owner.chatroom.setSystemPromptSettings({ workspace: target, enabled: false, modelIdentity: false });
    expect(await resolveSystemPrompt(db(), target, chatModel)).toBeNull();

    // The identity choice survives switching the prompt off and on.
    await owner.chatroom.setSystemPromptSettings({ workspace: target, enabled: false, modelIdentity: true });
    await owner.chatroom.setSystemPromptSettings({ workspace: target, enabled: true, modelIdentity: true });
    expect(await call("member").chatroom.getSystemPromptSettings({ workspace: target })).toEqual({
      enabled: true,
      modelIdentity: true,
    });
  });

  it("settings writes of different columns do not overwrite each other", async () => {
    const owner = call("owner");
    await Promise.all([
      owner.chatroom.setChainOfThoughtEnabled({ workspace: target, enabled: false }),
      owner.chatroom.setSystemPromptSettings({ workspace: target, enabled: false, modelIdentity: false }),
      owner.chatroom.setWorkerToolDefaults({ workspace: target, tools: ["edit"] }),
      owner.chatroom.setModelDefault({ workspace: target, model: chatModel }),
    ]);
    expect(await owner.chatroom.getChainOfThoughtEnabled({ workspace: target })).toBe(false);
    expect(await owner.chatroom.getSystemPromptSettings({ workspace: target })).toEqual({
      enabled: false,
      modelIdentity: false,
    });
    expect(await owner.chatroom.getWorkerToolDefaults({ workspace: target })).toEqual(["edit"]);
    expect(await owner.chatroom.getModelDefault({ workspace: target })).toBe(chatModel);
  });
});

describe("invariants under concurrency", () => {
  it("concurrent default replacements apply whole, one after another", async () => {
    const target = await addWorkspace(users.owner.id);
    const owner = call("owner");
    const [a, b, c] = [await addServer(target, "A"), await addServer(target, "B"), await addServer(target, "C")];
    const choices = [[a], [b, c], [a, b, c], [c]];
    await Promise.all(
      Array.from({ length: 24 }, (_, index) =>
        owner.chatroom.setToolDefaults({
          workspace: target,
          selection: { builtinToolSets: [], mcpServers: choices[index % choices.length]! },
        }),
      ),
    );
    const { mcpServers: selected } = await owner.chatroom.getToolDefaults({ workspace: target });
    expect(choices.some((choice) => choice.length === selected.length && choice.every((id) => selected.includes(id)))).toBe(true);
    expect(await db().select().from(workspaceMcpServers).where(eq(workspaceMcpServers.workspace, target))).toHaveLength(selected.length);
  });

  it("concurrent chat override replacements apply whole", async () => {
    const owner = call("owner");
    const chat = await addChat(users.owner.id, "personal");
    const [a, b] = [await addServer(workspace, "CA"), await addServer(workspace, "CB")];
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        owner.chatroom.setChatTools({
          chatId: chat,
          selection: { builtinToolSets: [], mcpServers: index % 2 === 0 ? [a] : [a, b] },
        }),
      ),
    );
    const rows = await db().select().from(chatMcpServers).where(eq(chatMcpServers.chat, chat));
    expect(rows.length === 1 || rows.length === 2).toBe(true);
    expect(new Set(rows.map((row) => row.mcpServer)).size).toBe(rows.length);
  });

  it("deleting a server while it is being selected never leaves a dangling reference", async () => {
    const owner = call("owner");
    for (let round = 0; round < 8; round++) {
      const target = await addWorkspace(users.owner.id);
      const server = await addServer(target, "Race");
      const chat = await addChat(users.owner.id, "personal", target);
      const selection = { builtinToolSets: [], mcpServers: [server] };
      const results = await Promise.allSettled([
        owner.chatroom.setToolDefaults({ workspace: target, selection }),
        owner.chatroom.setChatTools({ chatId: chat, selection }),
        owner.tools.deleteMcpServer({ workspace: target, server }),
      ]);
      expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled", "fulfilled"]);
      expect(await db().select().from(workspaceMcpServers).where(eq(workspaceMcpServers.workspace, target))).toHaveLength(0);
      expect(await db().select().from(chatMcpServers).where(and(eq(chatMcpServers.chat, chat)))).toHaveLength(0);
    }
  });
});
