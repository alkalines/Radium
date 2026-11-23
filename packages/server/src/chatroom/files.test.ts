import { mkdtemp, readdir, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import { CAPSULE_BYTES, toBase64Url } from "radium-crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLocalObjects } from "../drivers/local-objects";
import { ObjectTooLargeError } from "../drivers/types";
import { sweepJobs } from "../jobs/outbox";
import { runFileOrphans } from "../jobs/tasks/files-orphans";
import { createTestRuntime, TEST_SITE_URL, type TestRuntime } from "../../test/runtime";
import { classicUser } from "../../test/users";
import { appRouter } from "../trpc/router";
import { workspaceMembers, workspaces } from "../workspaces/schema";
import {
  authorizeFileDownload,
  fileUrl,
  linkChatFiles,
  MAX_ENCRYPTED_CHAT_FILE_BYTES,
  queueChatFileRelease,
  registerFile,
  type RegisterFileInput,
  resolveStoredFiles,
  storageKeyForUrl,
  storedFileUrls,
} from "./files";
import { chatFiles, chatMembers, chats } from "./schema";

// Chat attachments on the local-disk object store: upload intents, registration, linking,
// downloads under chat access (personal-chat privacy), release and orphan cleanup.

type Role = "owner" | "member" | "other" | "outsider" | "removed";
type User = { id: string; headers: Headers };

let test: TestRuntime;
const users = {} as Record<Role, User>;
let workspace = "";
let otherWorkspace = "";

const db = () => test.runtime.drivers.db;
const objects = () => test.runtime.drivers.objects;
const call = (role: Role) =>
  appRouter.createCaller({ runtime: test.runtime, headers: users[role].headers });

const e2eeParent = toBase64Url(new Uint8Array(16).fill(2));
const fileId = toBase64Url(new Uint8Array(16).fill(1));
function capsuleBytes() {
  const bytes = new Uint8Array(CAPSULE_BYTES).fill(5);
  bytes[0] = 1; // suite 1
  return bytes;
}
const e2ee = () => ({ fileId, capsule: capsuleBytes(), chatEpoch: 1, e2eeParent });
const wireE2ee = () => ({ ...e2ee(), capsule: toBase64Url(capsuleBytes()) });

const bytesOf = (size: number, fill = 9) => new Uint8Array(size).fill(fill);

async function addWorkspace(ownerId: string) {
  const [row] = await db().insert(workspaces).values({ ownerId, name: "Workspace" }).returning();
  return row!.id;
}

async function addChat(
  creator: Role,
  scope: "personal" | "shared" | "workspace",
  inWorkspace = workspace,
) {
  const [row] = await db()
    .insert(chats)
    .values({ userId: users[creator].id, workspace: inWorkspace, scope })
    .returning();
  return row!.id;
}

/** Uploads through the real route and registers; returns the file part and its id. */
async function uploaded(role: Role, inWorkspace = workspace, size = 64) {
  const slot = await call(role).chatFiles.createUpload({ workspace: inWorkspace });
  expect(slot.method).toBe("PUT");
  const put = await test.app.request(slot.uploadUrl, {
    method: "PUT",
    headers: users[role].headers,
    body: bytesOf(size),
  });
  expect(put.status).toBe(200);
  const part = await call(role).chatFiles.register({
    workspace: inWorkspace,
    id: slot.id,
    e2ee: wireE2ee(),
  });
  expect(part).not.toBeNull();
  return { id: slot.id, key: `chat/${slot.id}`, url: part!.url };
}

/** Puts an object directly and records an intent for `role`, for registration tests. */
async function slot(role: Role, inWorkspace = workspace) {
  return await call(role).chatFiles.createUpload({ workspace: inWorkspace });
}

const download = (role: Role | null, id: string) =>
  test.app.request(`/api/files/${id}`, { headers: role ? users[role].headers : undefined });

async function attach(url: string, chatId: string, inWorkspace = workspace) {
  await db().transaction((tx) =>
    linkChatFiles(tx, test.runtime.config, inWorkspace, chatId, [url], { sealed: true }),
  );
}

const rowsOf = (key: string) => db().select().from(chatFiles).where(eq(chatFiles.storageKey, key));

beforeAll(async () => {
  test = await createTestRuntime();
  for (const role of ["owner", "member", "other", "outsider", "removed"] as const) {
    users[role] = await classicUser(test.runtime, `${role}@files.test`);
  }
  workspace = await addWorkspace(users.owner.id);
  otherWorkspace = await addWorkspace(users.owner.id);
  await db()
    .insert(workspaceMembers)
    .values(
      (["member", "other", "removed"] as const).map((role) => ({
        workspace,
        userId: users[role].id,
        role: "member" as const,
      })),
    );
}, 60_000);

afterAll(async () => {
  await test?.close();
});

describe("local object store", () => {
  it("refuses keys that could leave the root and stores nothing past maxBytes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "radium-objects-"));
    try {
      const store = createLocalObjects(dir);
      for (const key of ["../x", "/etc/passwd", "chat/../x", "chat/a/b", "Chat/x", "chat", "chat/"]) {
        await expect(store.get(key)).rejects.toThrow("Invalid object key");
        await expect(store.put(key, bytesOf(1), { maxBytes: 10 })).rejects.toThrow();
      }
      await expect(store.put("chat/big", bytesOf(11), { maxBytes: 10 })).rejects.toBeInstanceOf(
        ObjectTooLargeError,
      );
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytesOf(6));
          controller.enqueue(bytesOf(6));
          controller.close();
        },
      });
      await expect(store.put("chat/stream", stream, { maxBytes: 10 })).rejects.toBeInstanceOf(
        ObjectTooLargeError,
      );
      expect(await store.stat("chat/big")).toBeNull();
      expect(await store.stat("chat/stream")).toBeNull();
      expect(await readdir(join(dir, ".tmp"))).toEqual([]);

      await store.put("chat/a", bytesOf(3), { maxBytes: 10 });
      expect(await store.stat("chat/a")).toEqual({ size: 3 });
      expect(await store.get("chat/a")).toEqual(bytesOf(3));
      await store.delete("chat/a");
      await store.delete("chat/a");
      expect(await store.get("chat/a")).toBeNull();
      expect(store.presignGet("chat/a", { expiresInSeconds: 1 })).toBeNull();
      expect(store.presignPut("chat/a", { expiresInSeconds: 1 })).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("lists a prefix in key order, page by page", async () => {
    const dir = await mkdtemp(join(tmpdir(), "radium-objects-"));
    try {
      const store = createLocalObjects(dir);
      for (const name of ["c", "a", "b"]) await store.put(`chat/${name}`, bytesOf(1), { maxBytes: 5 });
      await store.put("files/z", bytesOf(1), { maxBytes: 5 });
      const first = await store.list({ prefix: "chat/", cursor: null, limit: 2 });
      expect(first.keys.map((item) => item.key)).toEqual(["chat/a", "chat/b"]);
      const second = await store.list({ prefix: "chat/", cursor: first.cursor, limit: 2 });
      expect(second.keys.map((item) => item.key)).toEqual(["chat/c"]);
      expect(second.cursor).toBeNull();
      expect((await store.list({ prefix: "none/", cursor: null, limit: 2 })).keys).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("file urls", () => {
  it("maps only exact site file urls to keys, ignoring the fragment", () => {
    const id = crypto.randomUUID();
    const config = test.runtime.config;
    expect(fileUrl(config, id)).toBe(`${TEST_SITE_URL}/api/files/${id}`);
    expect(storageKeyForUrl(config, `${fileUrl(config, id)}#k=1`)).toBe(`chat/${id}`);
    expect(storageKeyForUrl(config, `https://evil.test/api/files/${id}`)).toBeNull();
    expect(storageKeyForUrl(config, `${fileUrl(config, id)}/x`)).toBeNull();
    expect(storageKeyForUrl(config, `${fileUrl(config, id)}?a=1`)).toBeNull();
    expect(storageKeyForUrl(config, `${TEST_SITE_URL}/api/files/not-a-uuid`)).toBeNull();
    expect(
      [...storedFileUrls([{ parts: [{ type: "file", url: `${fileUrl(config, id)}#x` }, { type: "file", url: "data:x" }] }])],
    ).toEqual([fileUrl(config, id)]);
  });
});

describe("upload and register", () => {
  it("uploads through the route and registers a pending file part", async () => {
    const file = await uploaded("member", workspace, 100);
    expect(file.url).toBe(`${TEST_SITE_URL}/api/files/${file.id}`);
    const [row] = await rowsOf(file.key);
    expect(row).toMatchObject({
      workspace,
      userId: users.member.id,
      chat: null,
      size: 100,
      mediaType: "application/octet-stream",
      fileId,
      chatEpoch: 1,
      e2eeParent,
    });
    expect(new Uint8Array(row!.capsule!)).toEqual(capsuleBytes());
    expect((await call("member").chatFiles.createUpload({ workspace })).uploadUrl).toMatch(
      /^\/api\/files\/upload\//,
    );
  });

  it("keeps a declared media type and refuses unrelated users and workspaces", async () => {
    const mine = await slot("member");
    await objects().put(`chat/${mine.id}`, bytesOf(10), { maxBytes: 100 });
    // Another user, another workspace, an unknown id: all null, and the intent survives.
    const input = (id: string) => ({ id, e2ee: wireE2ee() });
    expect(await call("other").chatFiles.register({ workspace, ...input(mine.id) })).toBeNull();
    expect(await call("owner").chatFiles.register({ workspace: otherWorkspace, ...input(mine.id) })).toBeNull();
    expect(await call("member").chatFiles.register({ workspace, ...input(crypto.randomUUID()) })).toBeNull();
    const part = await call("member").chatFiles.register({
      workspace,
      ...input(mine.id),
      mediaType: "image/png",
    });
    expect(part).toEqual({ type: "file", mediaType: "image/png", url: fileUrl(test.runtime.config, mine.id) });
  });

  it("refuses an outsider's upload slot", async () => {
    await expect(call("outsider").chatFiles.createUpload({ workspace })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("returns null without an object, and deletes an oversized one", async () => {
    const missing = await slot("member");
    expect(
      await call("member").chatFiles.register({ workspace, id: missing.id, e2ee: wireE2ee() }),
    ).toBeNull();

    const large = await slot("member");
    await objects().put(`chat/${large.id}`, bytesOf(MAX_ENCRYPTED_CHAT_FILE_BYTES + 1), {
      maxBytes: MAX_ENCRYPTED_CHAT_FILE_BYTES + 1,
    });
    expect(
      await call("member").chatFiles.register({ workspace, id: large.id, e2ee: wireE2ee() }),
    ).toBeNull();
    expect(await objects().stat(`chat/${large.id}`)).toBeNull();
    expect(await rowsOf(`chat/${large.id}`)).toEqual([]);
  });

  it("refuses malformed encryption metadata", async () => {
    const run = (e2eeOverride: Partial<RegisterFileInput["e2ee"]>, mediaType?: string) =>
      registerFile(test.runtime, { workspace: { id: workspace } as never }, users.member.id, {
        id: crypto.randomUUID(),
        mediaType,
        e2ee: { ...e2ee(), ...e2eeOverride },
      });
    const invalid = { code: "BAD_REQUEST", message: "E2EE_CONTENT_INVALID" };
    await expect(run({ fileId: "AAAA" })).rejects.toMatchObject(invalid);
    await expect(run({ e2eeParent: "AAAA" })).rejects.toMatchObject(invalid);
    await expect(run({ chatEpoch: 0 })).rejects.toMatchObject(invalid);
    await expect(run({ chatEpoch: 1.5 })).rejects.toMatchObject(invalid);
    await expect(run({ chatEpoch: Number.MAX_SAFE_INTEGER + 2 })).rejects.toMatchObject(invalid);
    await expect(run({ capsule: new Uint8Array(CAPSULE_BYTES - 1) })).rejects.toMatchObject(invalid);
    await expect(run({ capsule: new Uint8Array(CAPSULE_BYTES) })).rejects.toMatchObject(invalid); // suite 0
    await expect(run({}, "not a media type")).rejects.toMatchObject(invalid);
    await expect(run({}, "a/b/c")).rejects.toMatchObject(invalid);
    // Through the router, wrong-size capsules and file names never reach the service.
    await expect(
      call("member").chatFiles.register({
        workspace,
        id: crypto.randomUUID(),
        e2ee: { ...wireE2ee(), capsule: toBase64Url(new Uint8Array(3)) },
      }),
    ).rejects.toThrow();
  });

  it("registers a file once", async () => {
    const file = await uploaded("member");
    expect(
      await call("member").chatFiles.register({ workspace, id: file.id, e2ee: wireE2ee() }),
    ).toBeNull();
    expect(await rowsOf(file.key)).toHaveLength(1);
  });

  it("rate-limits upload slots per user", async () => {
    const user = await classicUser(test.runtime, "limited@files.test");
    const ws = await addWorkspace(user.id);
    const caller = appRouter.createCaller({ runtime: test.runtime, headers: user.headers });
    for (let i = 0; i < 60; i += 1) await caller.chatFiles.createUpload({ workspace: ws });
    await expect(caller.chatFiles.createUpload({ workspace: ws })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  // Fails when both the single-use intent take and the unique index are removed: two registrations
  // of one id would each insert a row.
  it("registers one upload exactly once under parallel calls", async () => {
    const racing = await slot("member");
    await objects().put(`chat/${racing.id}`, bytesOf(10), { maxBytes: 100 });
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        call("member").chatFiles.register({ workspace, id: racing.id, e2ee: wireE2ee() }),
      ),
    );
    expect(results.filter((part) => part !== null)).toHaveLength(1);
    expect(await rowsOf(`chat/${racing.id}`)).toHaveLength(1);
  });
});

describe("upload route", () => {
  const put = (role: Role | null, id: string, body: Uint8Array, headers: Record<string, string> = {}) =>
    test.app.request(`/api/files/upload/${id}`, {
      method: "PUT",
      headers: role ? { ...Object.fromEntries(users[role].headers), ...headers } : headers,
      body,
    });

  it("needs a session, a live intent of the caller, and a bounded body", async () => {
    const mine = await slot("member");
    expect((await put(null, mine.id, bytesOf(5))).status).toBe(401);
    expect((await put("other", mine.id, bytesOf(5))).status).toBe(404);
    expect((await put("member", crypto.randomUUID(), bytesOf(5))).status).toBe(404);
    expect((await put("member", "not-a-uuid", bytesOf(5))).status).toBe(404);
    expect(await objects().stat(`chat/${mine.id}`)).toBeNull();

    // Declared length past the bound, and an undeclared body that grows past it.
    expect(
      (await put("member", mine.id, bytesOf(5), { "content-length": String(MAX_ENCRYPTED_CHAT_FILE_BYTES + 1) }))
        .status,
    ).toBe(413);
    expect((await put("member", mine.id, bytesOf(MAX_ENCRYPTED_CHAT_FILE_BYTES + 1))).status).toBe(413);
    expect(await objects().stat(`chat/${mine.id}`)).toBeNull();

    // The intent was not consumed: a right-sized upload still works and registers.
    expect((await put("member", mine.id, bytesOf(MAX_ENCRYPTED_CHAT_FILE_BYTES))).status).toBe(200);
    expect(await objects().stat(`chat/${mine.id}`)).toEqual({ size: MAX_ENCRYPTED_CHAT_FILE_BYTES });
    expect(
      await call("member").chatFiles.register({ workspace, id: mine.id, e2ee: wireE2ee() }),
    ).not.toBeNull();
    // Registration consumed the intent.
    expect((await put("member", mine.id, bytesOf(5))).status).toBe(404);
  });

  it("is off when the adapter presigns, and downloads then redirect", async () => {
    const file = await uploaded("member");
    const original = objects();
    test.runtime.drivers.objects = {
      ...original,
      presignPut: (key) => `https://s3.test/put/${key}`,
      presignGet: (key) => `https://s3.test/get/${key}`,
    };
    try {
      const mine = await slot("member");
      expect(mine.uploadUrl).toBe(`https://s3.test/put/chat/${mine.id}`);
      expect((await put("member", mine.id, bytesOf(5))).status).toBe(404);
      const response = await download("member", file.id);
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(`https://s3.test/get/${file.key}`);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect((await download("outsider", file.id)).status).toBe(404);
    } finally {
      test.runtime.drivers.objects = original;
    }
  });
});

describe("downloads", () => {
  it("serves opaque bytes with hardened headers", async () => {
    const file = await uploaded("member", workspace, 33);
    const response = await download("member", file.id);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytesOf(33));
  });

  it("answers unauthenticated 401 and unknown or malformed ids 404", async () => {
    const file = await uploaded("member");
    expect((await download(null, file.id)).status).toBe(401);
    expect((await download("member", crypto.randomUUID())).status).toBe(404);
    expect((await download("member", "not-a-uuid")).status).toBe(404);
    expect((await download("member", "..%2Fetc")).status).toBe(404);
  });

  it("lets only the uploader fetch a pending upload", async () => {
    const file = await uploaded("member");
    expect((await download("member", file.id)).status).toBe(200);
    for (const role of ["owner", "other", "outsider"] as const) {
      expect((await download(role, file.id)).status).toBe(404);
    }
  });

  it("follows chat access: shared, workspace and personal chats", async () => {
    const shared = await uploaded("member");
    const sharedChat = await addChat("member", "shared");
    await db()
      .insert(chatMembers)
      .values({ chat: sharedChat, workspace, userId: users.other.id, lastInteractionAt: new Date() });
    await attach(shared.url, sharedChat);
    expect(await rowsOf(shared.key)).toMatchObject([{ chat: sharedChat }]);
    const allowed = { member: 200, other: 200, owner: 404, outsider: 404, removed: 404 } as const;
    for (const [role, status] of Object.entries(allowed)) {
      expect((await download(role as Role, shared.id)).status, `shared ${role}`).toBe(status);
    }

    const open = await uploaded("member");
    await attach(open.url, await addChat("member", "workspace"));
    for (const [role, status] of Object.entries({ member: 200, other: 200, owner: 200, removed: 200, outsider: 404 })) {
      expect((await download(role as Role, open.id)).status, `workspace ${role}`).toBe(status);
    }

    // The workspace owner is not "everyone": a member's personal chat stays private.
    const personal = await uploaded("member");
    await attach(personal.url, await addChat("member", "personal"));
    expect((await download("member", personal.id)).status).toBe(200);
    for (const role of ["owner", "other", "outsider"] as const) {
      expect((await download(role, personal.id)).status, `personal ${role}`).toBe(404);
    }

    // A removed member loses every chat in the workspace at once.
    await db()
      .delete(workspaceMembers)
      .where(and(eq(workspaceMembers.workspace, workspace), eq(workspaceMembers.userId, users.removed.id)));
    expect((await download("removed", open.id)).status).toBe(404);
    await db().insert(workspaceMembers).values({ workspace, userId: users.removed.id, role: "member" });
  });

  it("refuses downloads of an archived workspace's files", async () => {
    const ws = await addWorkspace(users.owner.id);
    const file = await uploaded("owner", ws);
    await attach(file.url, await addChat("owner", "workspace", ws), ws);
    expect((await download("owner", file.id)).status).toBe(200);
    await db().update(workspaces).set({ archivedAt: new Date() }).where(eq(workspaces.id, ws));
    expect((await download("owner", file.id)).status).toBe(404);
  });

  it("bounds the rows it checks without allowing the unauthorized", async () => {
    expect(await authorizeFileDownload(db(), users.owner.id, "chat/00000000-0000-4000-8000-000000000000")).toBe(false);
  });
});

describe("imported (legacy) files", () => {
  const legacyUrl = "https://example.convex.cloud/api/storage/legacy1";
  const legacyBox = { kind: "chat", keyId: "k", epoch: 1, box: new Uint8Array([1, 2, 3]) } as never;
  let legacyChat = "";

  beforeAll(async () => {
    legacyChat = await addChat("member", "personal");
    await objects().put("files/legacy1", bytesOf(7), { maxBytes: 100 });
    await db().insert(chatFiles).values({
      workspace,
      userId: users.member.id,
      storageKey: "files/legacy1",
      legacyUrl,
      legacyContent: legacyBox,
      mediaType: "image/png",
      size: 7,
      chat: legacyChat,
    });
  });

  const resolve = (role: Role | null, url: string) =>
    test.app.request(`/api/files/resolve?url=${encodeURIComponent(url)}`, {
      headers: role ? users[role].headers : undefined,
    });

  it("resolves a Convex url for the chat's reader only", async () => {
    const response = await resolve("member", `${legacyUrl}#fragment`);
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytesOf(7));
    expect((await resolve(null, legacyUrl)).status).toBe(401);
    for (const role of ["owner", "other", "outsider"] as const) {
      expect((await resolve(role, legacyUrl)).status, role).toBe(404);
    }
    expect((await resolve("member", "https://example.convex.cloud/api/storage/none")).status).toBe(404);
  });

  it("locates the sealed sidecar through chat access", async () => {
    const found = await call("member").chatFiles.historicalFile({ chatId: legacyChat, url: `${legacyUrl}#x` });
    expect(found).toMatchObject({ legacyContent: { kind: "chat", keyId: "k", epoch: 1 } });
    expect(found?.recordId).toEqual(expect.any(String));
    expect(
      await call("member").chatFiles.historicalFile({ chatId: legacyChat, url: `${legacyUrl}-other` }),
    ).toBeNull();
    await expect(
      call("owner").chatFiles.historicalFile({ chatId: legacyChat, url: legacyUrl }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("reports historical files and storage keys for model input", async () => {
    const file = await uploaded("member");
    const resolved = await resolveStoredFiles(db(), test.runtime.config, workspace, [
      `${legacyUrl}#a`,
      file.url,
      `${TEST_SITE_URL}/api/files/${crypto.randomUUID()}`,
    ]);
    expect(resolved).toEqual([
      { url: legacyUrl, historical: true },
      { url: file.url, storageKey: file.key },
    ]);
  });
});

describe("linkChatFiles", () => {
  it("attaches a pending upload once, copies it for a fork, and keeps it past one chat's deletion", async () => {
    const file = await uploaded("member");
    const first = await addChat("member", "workspace");
    const second = await addChat("member", "workspace");
    await attach(file.url, first);
    await attach(file.url, first);
    expect(await rowsOf(file.key)).toMatchObject([{ chat: first }]);
    await attach(file.url, second);
    expect((await rowsOf(file.key)).map((row) => row.chat).sort()).toEqual([first, second].sort());
    await db().delete(chats).where(eq(chats.id, first));
    expect(await rowsOf(file.key)).toMatchObject([{ chat: second }]);
  });

  it("ignores unknown urls and other workspaces' files", async () => {
    const foreign = await uploaded("owner", otherWorkspace);
    const chat = await addChat("member", "workspace");
    await db().transaction((tx) =>
      linkChatFiles(tx, test.runtime.config, workspace, chat, [
        foreign.url,
        `${TEST_SITE_URL}/api/files/${crypto.randomUUID()}`,
        "https://elsewhere.test/x.png",
      ]),
    );
    expect(await db().select().from(chatFiles).where(eq(chatFiles.chat, chat))).toEqual([]);
    // The foreign upload stays pending in its own workspace.
    expect(await rowsOf(foreign.key)).toMatchObject([{ chat: null, workspace: otherWorkspace }]);
  });

  it("refuses historical rows, and plaintext rows where sealing is required", async () => {
    const chat = await addChat("member", "workspace");
    const base = { workspace, userId: users.member.id, mediaType: "image/png", size: 1 };
    const refused = { message: "E2EE_CONTENT_INVALID" };

    // Pending historical row.
    await db().insert(chatFiles).values({
      ...base,
      storageKey: "files/pendinglegacy",
      legacyUrl: "https://x.test/pl",
      legacyContent: { kind: "chat", keyId: "k", epoch: 1, box: new Uint8Array(1) } as never,
    });
    await expect(attachAny(chat, "https://x.test/pl", true)).rejects.toMatchObject(refused);

    // Historical row of another chat cannot be copied.
    const sourceChat = await addChat("member", "workspace");
    await db().insert(chatFiles).values({
      ...base,
      storageKey: "files/copylegacy",
      legacyUrl: "https://x.test/cl",
      legacyContent: { kind: "chat", keyId: "k", epoch: 1, box: new Uint8Array(1) } as never,
      chat: sourceChat,
    });
    await expect(attachAny(chat, "https://x.test/cl", false)).rejects.toMatchObject(refused);

    // Plaintext pending row: refused when sealing is required, attached otherwise (Convex).
    const plain = crypto.randomUUID();
    await db().insert(chatFiles).values({ ...base, storageKey: `chat/${plain}` });
    await expect(attachAny(chat, fileUrl(test.runtime.config, plain), true)).rejects.toMatchObject(refused);
    await attachAny(chat, fileUrl(test.runtime.config, plain), false);
    expect(await rowsOf(`chat/${plain}`)).toMatchObject([{ chat }]);

    // A plaintext row another chat references is not copied (plaintext writes are gone).
    const copyTarget = await addChat("member", "workspace");
    await expect(attachAny(copyTarget, fileUrl(test.runtime.config, plain), false)).rejects.toMatchObject(refused);
    expect(await db().select().from(chatFiles).where(eq(chatFiles.chat, copyTarget))).toEqual([]);
  });

  it("attaches a pending upload to one chat when two race", async () => {
    const file = await uploaded("member");
    const chats2 = await Promise.all([addChat("member", "workspace"), addChat("member", "workspace")]);
    await Promise.all(chats2.map((chat) => attach(file.url, chat)));
    expect((await rowsOf(file.key)).map((row) => row.chat).sort()).toEqual([...chats2].sort());
    expect(await db().select().from(chatFiles).where(and(eq(chatFiles.storageKey, file.key), isNull(chatFiles.chat)))).toEqual([]);
  });
});

async function attachAny(chat: string, url: string, sealed: boolean) {
  await db().transaction((tx) =>
    linkChatFiles(tx, test.runtime.config, workspace, chat, [url], { sealed }),
  );
}

describe("release and orphans", () => {
  it("releases a deleted chat's objects once nothing references them", async () => {
    const file = await uploaded("member");
    const kept = await uploaded("member");
    const first = await addChat("member", "workspace");
    const second = await addChat("member", "workspace");
    await attach(file.url, first);
    await attach(kept.url, first);
    await attach(kept.url, second);

    const ids = await db().transaction(async (tx) => {
      const queued = await queueChatFileRelease(tx, first);
      await tx.delete(chats).where(eq(chats.id, first));
      return queued;
    });
    expect(ids).toHaveLength(1);
    expect(await objects().stat(file.key)).not.toBeNull();
    await sweepJobs(test.runtime);
    expect(await objects().stat(file.key)).toBeNull();
    expect(await objects().stat(kept.key)).not.toBeNull();
  });

  it("queues nothing for a chat without files", async () => {
    const chat = await addChat("member", "workspace");
    expect(await db().transaction((tx) => queueChatFileRelease(tx, chat))).toEqual([]);
  });

  it("deletes abandoned uploads, unregistered objects and failed releases, nothing else", async () => {
    const abandoned = await uploaded("member");
    const attached = await uploaded("member");
    await attach(attached.url, await addChat("member", "workspace"));

    const stray = crypto.randomUUID();
    await objects().put(`chat/${stray}`, bytesOf(4), { maxBytes: 10 });
    await objects().put("files/keepme", bytesOf(4), { maxBytes: 10 });

    // Nothing is old yet.
    await runFileOrphans(test.runtime);
    expect(await objects().stat(abandoned.key)).not.toBeNull();
    expect(await objects().stat(`chat/${stray}`)).not.toBeNull();

    // A day and an hour later: files get old through the clock the task reads.
    const later = Date.now() + 25 * 60 * 60 * 1000;
    const dir = test.runtime.config.FILES_DIR!;
    for (const old of ["files/keepme", `chat/${stray}`]) {
      const when = new Date(later - 3 * 86_400_000);
      await utimes(join(dir, old), when, when);
    }
    const result = await runFileOrphans(test.runtime, later);
    expect(result.pendingRows).toBeGreaterThanOrEqual(1);
    expect(await rowsOf(abandoned.key)).toEqual([]);
    expect(await objects().stat(abandoned.key)).toBeNull();
    expect(await objects().stat(`chat/${stray}`)).toBeNull();
    expect(await objects().stat(attached.key)).not.toBeNull();
    expect(await rowsOf(attached.key)).toHaveLength(1);
    expect(await objects().stat("files/keepme")).not.toBeNull();
    expect(await test.runtime.drivers.kv.send("GET", ["files-orphans:cursor"])).toBeNull();
  });
});
