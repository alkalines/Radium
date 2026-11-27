import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestRuntime, type TestRuntime } from "../../test/runtime";
import { readNext, readOnce, readToEnd } from "../../test/streams";
import { classicUser } from "../../test/users";
import { answerInteraction, awaitInteractionResponse, openInteraction } from "../chatroom/code-mode";
import { chats } from "../chatroom/schema";
import { appRouter } from "../trpc/router";
import { workspaceMembers, workspaces } from "../workspaces/schema";
import { ROTATE_EVENT, rotateStreams, STREAM_GENERATION_MS } from "./rotating";

// The live layer's boundaries against the real stream server: who may read which stream through
// the proxy, where invalidation events go (personal chats never on the workspace stream,
// owner-only topics to the owner only), generation rotation, and chat signal waits.

type Role = "owner" | "member" | "outsider";

let test: TestRuntime;
const users = {} as Record<Role, { id: string; headers: Headers }>;
let workspace = "";

const call = (role: Role) => appRouter.createCaller({ runtime: test.runtime, headers: users[role].headers });

beforeAll(async () => {
  test = await createTestRuntime();
  for (const role of ["owner", "member", "outsider"] as const) {
    users[role] = await classicUser(test.runtime, `streams-${role}@example.test`);
  }
  const [row] = await test.runtime.drivers.db
    .insert(workspaces)
    .values({ ownerId: users.owner.id, name: "Streams" })
    .returning();
  workspace = row!.id;
  await test.runtime.drivers.db
    .insert(workspaceMembers)
    .values({ workspace, userId: users.member.id, role: "member" });
});

afterAll(async () => {
  await test?.close();
});

/** The current offset of `path` (so a test reads only what follows). */
async function tailOf(path: string) {
  return (await test.runtime.streams.tail(path))!;
}

describe("stream proxy", () => {
  it("lets each stream be read only by its audience", async () => {
    const owner = await call("owner").events.streams({ workspace });
    const member = await call("member").events.streams({ workspace });
    expect(member.workspace).toBe(owner.workspace);
    expect(owner.user).toMatch(new RegExp(`^u/${users.owner.id}/events/`));

    expect((await readOnce(test.app, users.owner.headers, owner.user, "-1", false)).status).toBe(200);
    expect((await readOnce(test.app, users.member.headers, owner.user, "-1", false)).status).toBe(404);
    expect((await readOnce(test.app, users.member.headers, owner.workspace!, "-1", false)).status).toBe(200);
    expect((await readOnce(test.app, users.outsider.headers, owner.workspace!, "-1", false)).status).toBe(404);
    expect((await readOnce(test.app, new Headers(), owner.user, "-1", false)).status).toBe(401);
    await expect(call("outsider").events.streams({ workspace })).rejects.toThrow(/Workspace not found/);

    // Backend-only and malformed paths look missing.
    const chat = `c/${crypto.randomUUID()}/signals/x`;
    expect((await readOnce(test.app, users.owner.headers, chat, "-1", false)).status).toBe(404);
    expect((await test.app.request("/api/streams/u/..%2F..%2Fx/events/y", { headers: users.owner.headers })).status).toBe(404);
  });

  it("forwards only protocol parameters and marks responses uncacheable", async () => {
    const { user } = await call("owner").events.streams({});
    const response = await test.app.request(`/api/streams/${user}?offset=-1&token=x`, { headers: users.owner.headers });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("invalidation events", () => {
  it("announces workspace changes to members, owner-only ones to the owner, personal chats to their creator", async () => {
    const owner = await call("owner").events.streams({ workspace });
    const member = await call("member").events.streams({ workspace });
    const workspaceStart = await tailOf(owner.workspace!);
    const ownerStart = await tailOf(owner.user);
    const memberStart = await tailOf(member.user);

    // A member-visible change goes to the workspace stream.
    await call("owner").workspaces.setColor({ workspace, color: "teal" });
    const visible = await readNext(test.app, users.member.headers, owner.workspace!, workspaceStart);
    expect(visible.messages).toEqual([{ topic: "workspaces" }]);

    // An owner-only change reaches the owner's own stream, not the workspace.
    await call("owner").keys.create({ workspace, name: "ci" });
    const ownerOnly = await readNext(test.app, users.owner.headers, owner.user, ownerStart);
    expect(ownerOnly.messages).toEqual([{ topic: "keys" }]);

    // A member's personal chat is announced to the member only, never on the workspace stream.
    const [personal] = await test.runtime.drivers.db
      .insert(chats)
      .values({ workspace, userId: users.member.id, scope: "personal" })
      .returning();
    await call("member").chats.setPinned({ chatId: personal!.id, pinned: true });
    const mine = await readNext(test.app, users.member.headers, member.user, memberStart);
    expect(mine.messages).toEqual([{ topic: "chats", ids: [personal!.id] }]);
    // A later workspace event marks where an earlier leak would have landed.
    await call("owner").workspaces.setColor({ workspace, color: "green" });
    const shared = await readNext(test.app, users.member.headers, owner.workspace!, visible.nextOffset);
    expect(shared.messages).toEqual([{ topic: "workspaces" }]);
    const ownersOwn = await readOnce(test.app, users.owner.headers, owner.user, ownerOnly.nextOffset, false);
    expect(JSON.stringify(ownersOwn.messages)).not.toContain(personal!.id);
  });

  it("never lets extra input keys address streams the caller cannot see", async () => {
    const owner = await call("owner").events.streams({ workspace });
    const member = await call("member").events.streams({ workspace });
    const workspaceStart = await tailOf(owner.workspace!);
    const memberStart = await tailOf(member.user);
    const [personal] = await test.runtime.drivers.db
      .insert(chats)
      .values({ workspace, userId: users.member.id, scope: "personal" })
      .returning();

    // The outsider's own mutation succeeds; the foreign ids it smuggles in are ignored.
    const smuggled = { model: "some/model", pinned: true, workspace, chatId: personal!.id } as {
      model: string;
      pinned: boolean;
    };
    await call("outsider").preferences.setModelPinned(smuggled);

    // Later markers on both streams show nothing arrived before them.
    await call("owner").workspaces.setColor({ workspace, color: "teal" });
    expect((await readNext(test.app, users.member.headers, owner.workspace!, workspaceStart)).messages).toEqual([
      { topic: "workspaces" },
    ]);
    await call("member").chats.setPinned({ chatId: personal!.id, pinned: true });
    expect((await readNext(test.app, users.member.headers, member.user, memberStart)).messages).toEqual([
      { topic: "chats", ids: [personal!.id] },
    ]);
  });
});

describe("rotation", () => {
  it("closes a day-old generation with a rotate message, starts a new one on demand, and deletes the old a day later", async () => {
    const { user: first } = await call("member").events.streams({});
    const now = Date.now();
    await rotateStreams(test.runtime.drivers.kv, test.runtime.streams, now + STREAM_GENERATION_MS + 60_000);
    const old = await readToEnd(test.app, users.member.headers, first);
    expect(old.at(-1)).toEqual(ROTATE_EVENT);

    const { user: second } = await call("member").events.streams({});
    expect(second).not.toBe(first);
    expect((await readOnce(test.app, users.member.headers, second, "-1", false)).status).toBe(200);

    await rotateStreams(test.runtime.drivers.kv, test.runtime.streams, now + 2 * STREAM_GENERATION_MS + 120_000);
    expect(await test.runtime.streams.tail(first)).toBeNull();
  });
});

describe("chat signals", () => {
  it("wakes a Code Mode wait as soon as the prompt is answered", async () => {
    const [chat] = await test.runtime.drivers.db
      .insert(chats)
      .values({ workspace, userId: users.member.id, scope: "personal" })
      .returning();
    const id = await openInteraction(test.runtime.drivers.kv, { chatId: chat!.id, userId: users.member.id, kind: "question" });
    const started = Date.now();
    const waiting = awaitInteractionResponse(test.runtime, { chat: chat!.id, id });
    // Real delay on purpose: the answer must land while the wait is inside its stream long-poll.
    await Bun.sleep(200);
    await answerInteraction(test.runtime, users.member.id, {
      interaction: id,
      response: { kind: "question", dismissed: true },
    });
    expect(await waiting).toEqual({ kind: "question", dismissed: true });
    expect(Date.now() - started).toBeLessThan(5_000);

    // An answer that landed before the wait is found without waiting.
    expect(await awaitInteractionResponse(test.runtime, { chat: chat!.id, id })).toEqual({ kind: "question", dismissed: true });
  });
});
