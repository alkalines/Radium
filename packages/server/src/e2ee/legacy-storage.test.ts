import { utimes } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestRuntime, type TestRuntime } from "../../test/runtime";
import {
  account,
  insertBlob,
  insertNode,
  insertRequest,
  insertSession,
  setArchived,
  telemetryWorkspace,
  type TelemetryWorkspace,
} from "../../test/telemetry";
import { insertWorker } from "../../test/workers";
import { acpAgentSessions, acpInteractions, acpSessions } from "../acp/schema";
import { queueChatFileRelease, deleteUnreferencedObjects } from "../chatroom/files";
import { chatFiles, chatMessages, chats } from "../chatroom/schema";
import { sweepJobs } from "../jobs/outbox";
import { runFileOrphans } from "../jobs/tasks/files-orphans";
import { notifications } from "../notifications/schema";
import { telemetryNodes } from "../telemetry/schema";
import { appRouter } from "../trpc/router";
import { workerAgents, workerChatCalls } from "../worker/schema";
import type { WorkerIdentity } from "../worker/signing";
import { workspaceMembers, projects, workspaces } from "../workspaces/schema";
import { legacyStorageUrl } from "./legacy-storage";

// `e2ee.legacyStorageUrl` and `GET /api/files/legacy`: a historical box's out-of-row envelope is
// served only to a user who may read the source row (ported from Convex `e2ee_legacy.storageUrl`),
// and no object sweep deletes an envelope a `legacy_content.storageId` still names.

type Actor = "owner" | "member" | "other" | "outsider";
const ACTORS: readonly Actor[] = ["owner", "member", "other", "outsider"];

let test: TestRuntime;
let world: TelemetryWorkspace;
let users: Record<Actor, { id: string; headers: Headers }>;
let worker: WorkerIdentity;
let ws = "";

const db = () => test.runtime.drivers.db;
const objects = () => test.runtime.drivers.objects;
const call = (actor: Actor) =>
  appRouter.createCaller({ runtime: test.runtime, headers: users[actor].headers });
const unique = () => crypto.randomUUID();

/** A stored box; `storageId` set means its envelope lives in the object store under that id. */
const stored = (storageId?: string) =>
  ({ kind: "chat", keyId: "k", epoch: 1, box: "", ...(storageId ? { storageId } : {}) }) as never;

type Made = { table: string; record: string; storageId: string };
const made: Made[] = [];

/** An object in the store as the importer leaves it, and the box that points to it. */
async function envelope() {
  const storageId = `S${unique().replaceAll("-", "")}`;
  await objects().put(`files/${storageId}`, new TextEncoder().encode(`env:${storageId}`), {
    maxBytes: 1024,
  });
  return { storageId, legacyContent: stored(storageId) };
}

function track(table: string, record: string, storageId: string) {
  made.push({ table, record, storageId });
  return record;
}

type Scope = "personal" | "shared" | "workspace";
const creatorOf = (scope: Scope) => (scope === "workspace" ? users.owner.id : users.member.id);

async function freshChat(scope: Scope, legacyContent: unknown = null) {
  const [row] = await db()
    .insert(chats)
    .values({ workspace: ws, userId: creatorOf(scope), scope, legacyContent: legacyContent as never })
    .returning();
  return row!.id;
}

/**
 * Makers of one source row each: a fresh chat of `scope` for chat-bound tables, carrying `box`.
 * Returns the record id.
 */
const CHAT_BOUND: Record<string, (scope: Scope, box: unknown) => Promise<string>> = {
  aisdk_chats: (scope, box) => freshChat(scope, box),
  chat_messages: async (scope, box) => {
    const chat = await freshChat(scope);
    const [row] = await db()
      .insert(chatMessages)
      .values({ chat, position: 0, legacyContent: box as never })
      .returning();
    return row!.id;
  },
  chat_files: async (scope, box) => {
    const chat = await freshChat(scope);
    const [row] = await db()
      .insert(chatFiles)
      .values({
        workspace: ws,
        userId: creatorOf(scope),
        chat,
        mediaType: "text/plain",
        size: 1,
        legacyContent: box as never,
      })
      .returning();
    return row!.id;
  },
  acp_sessions: async (scope, box) => {
    const chat = await freshChat(scope);
    const [row] = await db()
      .insert(acpSessions)
      .values({
        chat,
        workspace: ws,
        worker: worker.workerId,
        agentId: "agent",
        agentVersion: "1",
        cwd: "/work",
        status: "idle",
        updatedAt: new Date(),
        legacyContent: box as never,
      })
      .returning();
    return row!.id;
  },
  acp_interactions: async (scope, box) => {
    const chat = await freshChat(scope);
    const [row] = await db()
      .insert(acpInteractions)
      .values({
        workspace: ws,
        chat,
        worker: worker.workerId,
        requestKey: unique(),
        kind: "permission",
        legacyContent: box as never,
      })
      .returning();
    return row!.id;
  },
  worker_chat_calls: async (scope, box) => {
    const chat = await freshChat(scope);
    const [row] = await db()
      .insert(workerChatCalls)
      .values({
        chat,
        userId: creatorOf(scope),
        worker: worker.workerId,
        directory: "/work",
        tool: "read",
        toolCallId: unique(),
        stage: "read",
        requestKey: unique(),
        legacyContent: box as never,
      })
      .returning();
    return row!.id;
  },
};

const urlOf = (table: string, record: string) =>
  `/api/files/legacy?${new URLSearchParams({ table, record })}`;

/** Every actor outside `allowed` gets `NOT_FOUND`; the others the download URL. */
async function expectAccess(table: string, record: string, allowed: readonly Actor[]) {
  for (const actor of ACTORS) {
    const result = call(actor).e2ee.legacyStorageUrl({ table, record });
    if (allowed.includes(actor)) expect(await result, `${table}: ${actor}`).toBe(urlOf(table, record));
    else await expect(result, `${table}: ${actor}`).rejects.toMatchObject({ code: "NOT_FOUND" });
  }
}

/** The matrix of one source row: the actors allowed, the link tracked for later checks. */
async function check(table: string, make: (box: unknown) => Promise<string>, allowed: readonly Actor[]) {
  const { storageId, legacyContent } = await envelope();
  const record = track(table, await make(legacyContent), storageId);
  await expectAccess(table, record, allowed);
  return record;
}

beforeAll(async () => {
  test = await createTestRuntime();
  world = await telemetryWorkspace(test.runtime);
  const other = await account(test.runtime, "other");
  ws = world.workspace;
  await db().insert(workspaceMembers).values({ workspace: ws, userId: other.id, role: "member" });
  users = { owner: world.owner, member: world.member, other, outsider: world.outsider };
  worker = await insertWorker(test.runtime, ws);
}, 60_000);

afterAll(async () => {
  await test?.close();
});

describe("authorization per source table", () => {
  it("workspaces and projects: owner and members, nobody else", async () => {
    const { storageId, legacyContent } = await envelope();
    await db().update(workspaces).set({ legacyContent }).where(eq(workspaces.id, ws));
    track("workspaces", ws, storageId);
    await expectAccess("workspaces", ws, ["owner", "member", "other"]);

    await check(
      "projects",
      async (box) => {
        const [row] = await db()
          .insert(projects)
          .values({ workspace: ws, userId: users.owner.id, name: "P", legacyContent: box as never })
          .returning();
        return row!.id;
      },
      ["owner", "member", "other"],
    );
  });

  for (const [table, make] of Object.entries(CHAT_BOUND)) {
    it(`${table}: follows chat access, personal chats stay private even from the owner`, async () => {
      await check(table, (box) => make("workspace", box), ["owner", "member", "other"]);
      await check(table, (box) => make("personal", box), ["member"]);
    });
  }

  it("aisdk_chats: a shared chat reaches the creator and its members, not the owner", async () => {
    const chat = await freshChat("shared", (await envelope()).legacyContent);
    await expectAccess("aisdk_chats", chat, ["member"]);
  });

  it("chat_files without a chat: the uploader only", async () => {
    await check(
      "chat_files",
      async (box) => {
        const [row] = await db()
          .insert(chatFiles)
          .values({
            workspace: ws,
            userId: users.member.id,
            mediaType: "text/plain",
            size: 1,
            legacyContent: box as never,
          })
          .returning();
        return row!.id;
      },
      ["member"],
    );
  });

  it("acp_agent_sessions: the workspace owner, narrowed by the chat it belongs to", async () => {
    const insert = async (chat: string | null, box: unknown) => {
      const [row] = await db()
        .insert(acpAgentSessions)
        .values({
          workspace: ws,
          worker: worker.workerId,
          agentId: "agent",
          sessionId: unique(),
          cwd: "/work",
          updatedAt: new Date(),
          chat,
          legacyContent: box as never,
        })
        .returning();
      return row!.id;
    };
    await check("acp_agent_sessions", (box) => insert(null, box), ["owner"]);
    await check("acp_agent_sessions", async (box) => insert(await freshChat("workspace"), box), ["owner"]);
    // Bound to a member's personal chat, even the owner cannot read it.
    await check("acp_agent_sessions", async (box) => insert(await freshChat("personal"), box), []);
  });

  it("worker_agents, telemetry_blobs and telemetry_nodes: the workspace owner only", async () => {
    await check(
      "worker_agents",
      async (box) => {
        const [row] = await db()
          .insert(workerAgents)
          .values({
            worker: worker.workerId,
            agentId: unique(),
            name: "Agent",
            version: "1",
            source: "registry",
            status: "ready",
            capabilities: {} as never,
            authMethods: [],
            checkedAt: new Date(),
            legacyContent: box as never,
          })
          .returning();
        return row!.id;
      },
      ["owner"],
    );
    const blobOf = async (box: unknown) =>
      insertBlob(test.runtime, ws, "message", unique(), undefined, { legacyContent: box as never });
    await check("telemetry_blobs", blobOf, ["owner"]);
    await check(
      "telemetry_nodes",
      async (box) => {
        const blob = await insertBlob(test.runtime, ws, "message", unique());
        const id = await insertNode(test.runtime, ws, unique(), 1, undefined, blob);
        await db()
          .update(telemetryNodes)
          .set({ legacyContent: box as never })
          .where(eq(telemetryNodes.id, id));
        return id;
      },
      ["owner"],
    );
  });

  it("telemetry_requests: the owner, and only requests the owner could see in Chatroom", async () => {
    const request = (chat: string | null) => async (box: unknown) =>
      insertRequest(test.runtime, ws, {
        requestId: unique(),
        ...(chat ? { chat } : {}),
        legacyContent: box as never,
      });
    await check("telemetry_requests", request(null), ["owner"]);
    await check("telemetry_requests", request(world.sharedChat), ["owner"]);
    await check("telemetry_requests", request(world.memberPersonalChat), []);
    await check("telemetry_requests", request(world.memberSharedChat), []);
  });

  it("notifications: the recipient only, whatever the role", async () => {
    const insert = (userId: string) => async (box: unknown) => {
      const [row] = await db()
        .insert(notifications)
        .values({
          userId,
          workspace: ws,
          kind: "session_finished",
          chat: world.sharedChat,
          legacyContent: box as never,
        })
        .returning();
      return row!.id;
    };
    await check("notifications", insert(users.member.id), ["member"]);
    await check("notifications", insert(users.owner.id), ["owner"]);
  });
});

describe("no envelope", () => {
  it("answers null for an authorized row whose box is inline or absent", async () => {
    const inline = await freshChat("workspace", stored());
    const none = await freshChat("workspace");
    for (const record of [inline, none]) {
      expect(await call("owner").e2ee.legacyStorageUrl({ table: "aisdk_chats", record })).toBeNull();
    }
    // Still authorized first: an outsider learns nothing about the row.
    await expect(
      call("outsider").e2ee.legacyStorageUrl({ table: "aisdk_chats", record: inline }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("refuses a storage id that is not an object id", async () => {
    for (const storageId of ["a/b", "../x", "", " ", "x".repeat(200)]) {
      const chat = await freshChat("workspace", stored(storageId));
      expect(await call("owner").e2ee.legacyStorageUrl({ table: "aisdk_chats", record: chat })).toBeNull();
    }
  });
});

describe("table and record", () => {
  it("allows only the historical tables; everything else is refused before any lookup", async () => {
    const record = await freshChat("workspace", (await envelope()).legacyContent);
    for (const table of [
      "chat_frames",
      "acp_commands",
      "worker_tasks",
      "telemetry_traces",
      "telemetry_sessions",
      "chats",
      "user",
      "e2ee_chat_key_wraps",
      "__proto__",
      "constructor",
      "toString",
      "chats; drop table chats",
      "aisdk_chats ",
    ]) {
      await expect(call("owner").e2ee.legacyStorageUrl({ table, record }), table).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
    }
    expect(await db().select().from(chats).where(eq(chats.id, record))).toHaveLength(1);
  });

  it("an unknown record is NOT_FOUND like a hidden one", async () => {
    await expect(
      call("owner").e2ee.legacyStorageUrl({ table: "aisdk_chats", record: "nope" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      call("owner").e2ee.legacyStorageUrl({ table: "notifications", record: unique() }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("needs a session, bounds its input and ignores a caller's storage id", async () => {
    const anonymous = appRouter.createCaller({ runtime: test.runtime, headers: new Headers() });
    const { storageId, legacyContent } = await envelope();
    const record = await freshChat("workspace", legacyContent);
    await expect(
      anonymous.e2ee.legacyStorageUrl({ table: "aisdk_chats", record }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      call("owner").e2ee.legacyStorageUrl({ table: "aisdk_chats", record: "x".repeat(257) }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      call("owner").e2ee.legacyStorageUrl({ table: "", record }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    // A storage id in the input changes nothing: the row's own box decides.
    const url = await call("owner").e2ee.legacyStorageUrl({
      table: "aisdk_chats",
      record,
      storageId: "Sother",
    } as never);
    expect(url).toBe(urlOf("aisdk_chats", record));
    const response = await test.app.request(url!, { headers: users.owner.headers });
    expect(await response.text()).toBe(`env:${storageId}`);
  });
});

describe("download", () => {
  it("local disk: the authenticated route streams exactly what the procedure authorized", async () => {
    const { storageId, legacyContent } = await envelope();
    const personal = await freshChat("personal", legacyContent);
    const get = (actor: Actor | null, url: string) =>
      test.app.request(url, { headers: actor ? users[actor].headers : undefined });

    const url = await call("member").e2ee.legacyStorageUrl({ table: "aisdk_chats", record: personal });
    const ok = await get("member", url!);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe(`env:${storageId}`);
    expect(ok.headers.get("cache-control")).toBe("private, no-store");

    expect((await get(null, url!)).status).toBe(401);
    // The owner cannot read a member's personal chat, nor can anyone else.
    for (const actor of ["owner", "other", "outsider"] as const) {
      expect((await get(actor, url!)).status, actor).toBe(404);
    }
    for (const path of [
      urlOf("chats", personal),
      urlOf("aisdk_chats", "nope"),
      "/api/files/legacy",
      `/api/files/legacy?table=aisdk_chats&record=${"x".repeat(300)}`,
    ]) {
      expect((await get("member", path)).status, path).toBe(404);
    }
    const inline = await freshChat("personal", stored());
    expect((await get("member", urlOf("aisdk_chats", inline))).status).toBe(404);
  });

  it("a store that presigns gets a short-lived GET of the row's own object", async () => {
    const { storageId, legacyContent } = await envelope();
    const record = await freshChat("workspace", legacyContent);
    const drivers = test.runtime.drivers;
    const s3 = {
      drivers: {
        ...drivers,
        objects: {
          ...drivers.objects,
          presignGet: (key: string, options: { expiresInSeconds: number }) =>
            `https://s3.test/${key}?expires=${options.expiresInSeconds}`,
        },
      },
    };
    expect(await legacyStorageUrl(s3, users.owner.id, { table: "aisdk_chats", record })).toBe(
      `https://s3.test/files/${storageId}?expires=60`,
    );
    await expect(
      legacyStorageUrl(s3, users.outsider.id, { table: "aisdk_chats", record }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("object sweeps keep sidecar envelopes", () => {
  const stray = (key: string) => objects().put(key, new Uint8Array(4), { maxBytes: 10 });
  const age = async (key: string, at: number) => {
    const when = new Date(at - 3 * 86_400_000);
    await utimes(join(test.runtime.config.FILES_DIR!, key), when, when);
  };

  it("files.orphans never deletes an old envelope that a box still names", async () => {
    const { storageId, legacyContent } = await envelope();
    await freshChat("workspace", legacyContent);
    const unreferenced = `chat/${unique()}`;
    await stray(unreferenced);
    const later = Date.now() + 25 * 60 * 60 * 1000;
    await age(`files/${storageId}`, later);
    await age(unreferenced, later);

    await runFileOrphans(test.runtime, later);
    expect(await objects().stat(`files/${storageId}`)).not.toBeNull();
    expect(await objects().stat(unreferenced)).toBeNull();
  });

  it("a pending upload row that names an envelope's key loses the row but never the envelope", async () => {
    const { storageId, legacyContent } = await envelope();
    await freshChat("workspace", legacyContent);
    // An imported pending row with no sidecar of its own whose object key is an envelope's.
    const [row] = await db()
      .insert(chatFiles)
      .values({
        workspace: ws,
        userId: users.member.id,
        storageKey: `files/${storageId}`,
        mediaType: "text/plain",
        size: 1,
        createdAt: new Date(Date.now() - 3 * 86_400_000),
      })
      .returning();
    await runFileOrphans(test.runtime, Date.now() + 25 * 60 * 60 * 1000);
    expect(await db().select().from(chatFiles).where(eq(chatFiles.id, row!.id))).toEqual([]);
    expect(await objects().stat(`files/${storageId}`)).not.toBeNull();
  });

  it("files.release keeps an envelope that is also named by a box, and deletes a plain file object", async () => {
    const shared = await envelope();
    const plain = await envelope();
    await freshChat("workspace", shared.legacyContent);
    const chat = await freshChat("workspace");
    await db()
      .insert(chatFiles)
      .values(
        [shared, plain].map((file) => ({
          workspace: ws,
          userId: users.owner.id,
          chat,
          storageKey: `files/${file.storageId}`,
          mediaType: "text/plain",
          size: 1,
        })),
      );
    await db().transaction(async (tx) => {
      await queueChatFileRelease(tx, chat);
      await tx.delete(chats).where(eq(chats.id, chat));
    });
    await sweepJobs(test.runtime);
    expect(await objects().stat(`files/${shared.storageId}`)).not.toBeNull();
    expect(await objects().stat(`files/${plain.storageId}`)).toBeNull();
  });

  it("deleteUnreferencedObjects spares the envelope of every sidecar table", async () => {
    // `telemetry_sessions` is no readable source but its sidecar still names an object.
    const session = await envelope();
    await insertSession(test.runtime, ws, unique(), { legacyContent: session.legacyContent as never });
    const tables = new Set(made.map((item) => item.table));
    expect(tables.size).toBe(14);
    const keys = [...made.map((item) => item.storageId), session.storageId].map((id) => `files/${id}`);
    expect(await deleteUnreferencedObjects(test.runtime, keys)).toBe(0);
    for (const key of keys) expect(await objects().stat(key), key).not.toBeNull();
    // Control: the same call deletes an object nothing names.
    const free = await envelope();
    expect(await deleteUnreferencedObjects(test.runtime, [`files/${free.storageId}`])).toBe(1);
  });
});

describe("archived workspaces", () => {
  it("refuse every row of the workspace, a recipient's notification excepted", async () => {
    await setArchived(test.runtime, ws, true);
    try {
      for (const { table, record } of made) {
        if (table === "notifications") continue;
        for (const actor of ACTORS) {
          await expect(
            call(actor).e2ee.legacyStorageUrl({ table, record }),
            `${table}: ${actor}`,
          ).rejects.toMatchObject({ code: "NOT_FOUND" });
        }
      }
      const mine = made.find((item) => item.table === "notifications")!;
      expect(
        await call("member").e2ee.legacyStorageUrl({ table: mine.table, record: mine.record }),
      ).toBe(urlOf(mine.table, mine.record));
    } finally {
      await setArchived(test.runtime, ws, false);
    }
  });
});

const ACTOR_FREE_TABLES = ["a", "b", "c"] as const;
