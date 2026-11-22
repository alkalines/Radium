import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestRuntime, type TestRuntime } from "../../test/runtime";
import { classicUser } from "../../test/users";
import { chats } from "../chatroom/schema";
import { notificationPreferences } from "../workspaces/preferences";
import { userPreferences, workspaces } from "../workspaces/schema";
import { notify } from "./notify";
import { notifications } from "./schema";

// The notification write path: the recipient's category preferences, and the row it leaves for
// the delivery channels.

let test: TestRuntime;
let userId = "";
let workspace = "";
let chat = "";

const db = () => test.runtime.drivers.db;

beforeAll(async () => {
  test = await createTestRuntime();
  userId = (await classicUser(test.runtime, "notify@example.test")).id;
  const [row] = await db()
    .insert(workspaces)
    .values({ ownerId: userId, name: "Notify" })
    .returning();
  workspace = row!.id;
  const [created] = await db()
    .insert(chats)
    .values({ workspace, userId })
    .returning({ id: chats.id });
  chat = created!.id;
});

afterAll(async () => {
  await test.close();
});

describe("notificationPreferences", () => {
  it("defaults every category until the user sets one", async () => {
    expect(await notificationPreferences(db(), userId)).toEqual({
      finished: { enabled: true, sound: true },
      attention: { enabled: true, sound: true },
      failed: { enabled: true, sound: true },
      limits: { enabled: true, sound: false },
    });
  });
});

describe("notify", () => {
  it("writes a plain row without text or sealed content", async () => {
    const id = await notify(db(), { userId, workspace, kind: "session_finished", chat });
    const [row] = await db().select().from(notifications).where(eq(notifications.id, id!));
    expect(row).toMatchObject({
      userId,
      workspace,
      kind: "session_finished",
      chat,
      limitEvent: null,
      sealedKeyId: null,
      sealedBox: null,
      seenAt: null,
      deliveryChannel: null,
    });
  });

  it("writes nothing for a category the user switched off, and only that category", async () => {
    await db()
      .insert(userPreferences)
      .values({ userId, notifications: { failed: { enabled: false, sound: false } } });

    expect(await notify(db(), { userId, workspace, kind: "session_failed", chat })).toBeNull();
    expect(
      await notify(db(), { userId, workspace, kind: "session_finished", chat }),
    ).not.toBeNull();
    expect((await notificationPreferences(db(), userId)).failed.enabled).toBe(false);
  });
});
