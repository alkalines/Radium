/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { recordLimitEvent } from "../src/limits/events";
import { resolveLimitSettings, type Meter } from "../src/limits/meters";
import { sessionNotificationKind, type ChatRequestEnd } from "../src/notifications/session";

type AuthContext = {
  auth: { getUserIdentity: () => Promise<{ tokenIdentifier?: string } | null> };
};

const authMock = vi.hoisted(() => {
  const getAuthUser = vi.fn(async (ctx: AuthContext) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity?.tokenIdentifier) return null;
    return { _id: identity.tokenIdentifier };
  });
  return { getAuthUser, safeGetAuthUser: getAuthUser };
});

vi.mock("./auth", () => ({
  authComponent: {
    getAuthUser: authMock.getAuthUser,
    safeGetAuthUser: authMock.safeGetAuthUser,
  },
}));

const modules = import.meta.glob("./**/*.ts");
const PUSH_ENDPOINT = "https://fcm.googleapis.com/fcm/send/device-1";

const vapidEnv = {
  WEB_PUSH_VAPID_PUBLIC_KEY: "public-key",
  WEB_PUSH_VAPID_PRIVATE_KEY: "private-key",
  WEB_PUSH_SUBJECT: "mailto:owner@example.invalid",
};

beforeEach(() => {
  for (const name of Object.keys(vapidEnv)) delete process.env[name];
});

afterEach(() => {
  for (const name of Object.keys(vapidEnv)) delete process.env[name];
});

async function setup() {
  const t = convexTest({ schema, modules });
  const { workspace, chat } = await t.run(async (ctx) => {
    const workspace = await ctx.db.insert("workspaces", {
      ownerType: "user",
      ownerId: "owner",
      name: "Team",
    });
    await ctx.db.insert("workspace_members", { workspace, userId: "member", role: "member" });
    const chat = await ctx.db.insert("aisdk_chats", {
      userId: "member",
      workspace,
      scope: "workspace",
      messages: [],
      chat_completions: [],
      title: "Refactor routing",
    });
    return { workspace, chat };
  });
  return {
    t,
    workspace,
    chat,
    owner: t.withIdentity({ tokenIdentifier: "owner" }),
    member: t.withIdentity({ tokenIdentifier: "member" }),
  };
}

type Harness = Awaited<ReturnType<typeof setup>>;

async function notifySession(
  harness: Harness,
  kind: "session_finished" | "session_failed" = "session_finished",
) {
  await harness.t.mutation(internal.notifications.notifySession, {
    userId: "member",
    chat: harness.chat,
    kind,
    ...(kind === "session_failed" ? { detail: "429 rate limited" } : {}),
  });
  const [latest] = await harness.member.query(api.notifications.recent, {});
  return latest!;
}

async function scheduledNames(harness: Harness) {
  const scheduled = await harness.t.run((ctx) =>
    ctx.db.system.query("_scheduled_functions").collect(),
  );
  return scheduled.map((job) => job.name);
}

async function subscribeDevice(harness: Harness) {
  await harness.member.mutation(api.notifications.subscribe, {
    endpoint: PUSH_ENDPOINT,
    p256dh: "p256dh",
    auth: "auth",
    label: "Firefox on Linux",
  });
}

describe("session outcomes", () => {
  const assistant = (parts: ChatRequestEnd["responseMessage"]["parts"]) => ({
    role: "assistant",
    parts,
  });
  const end = (overrides: Partial<ChatRequestEnd>): ChatRequestEnd => ({
    isAborted: false,
    outcome: { status: "completed" },
    failed: false,
    responseMessage: assistant([{ type: "text" }]),
    ...overrides,
  });

  test("map the end of a request to the notification the user needs", () => {
    expect(sessionNotificationKind(end({}))).toBe("session_finished");
    expect(
      sessionNotificationKind(
        end({
          responseMessage: assistant([{ type: "tool-worker_bash", state: "approval-requested" }]),
        }),
      ),
    ).toBe("session_approval");
    expect(
      sessionNotificationKind(
        end({ responseMessage: assistant([{ type: "tool-question", state: "input-available" }]) }),
      ),
    ).toBe("session_question");
    // Other tools waiting for input are still running, not waiting on the user.
    expect(
      sessionNotificationKind(
        end({
          responseMessage: assistant([{ type: "tool-worker_read", state: "input-available" }]),
        }),
      ),
    ).toBe("session_finished");
  });

  test("an error wins over a completed outcome; a stopped request notifies nobody", () => {
    expect(sessionNotificationKind(end({ failed: true }))).toBe("session_failed");
    expect(sessionNotificationKind(end({ outcome: { status: "failed" } }))).toBe("session_failed");
    expect(sessionNotificationKind(end({ isAborted: true, failed: true }))).toBeUndefined();
    expect(sessionNotificationKind(end({ isCancelled: true }))).toBeUndefined();
    expect(sessionNotificationKind(end({ outcome: { status: "unknown" } }))).toBeUndefined();
  });
});

describe("browser claim and push fallback", () => {
  test("only the recipient sees a notification, and exactly one tab claims it", async () => {
    const harness = await setup();
    const notification = await notifySession(harness, "session_failed");
    expect(notification).toMatchObject({
      kind: "session_failed",
      category: "failed",
      title: "Session failed",
      body: "Refactor routing · 429 rate limited",
      path: `/chat/${harness.chat}`,
      claimed: false,
      pushed: false,
    });
    expect(await harness.owner.query(api.notifications.recent, {})).toEqual([]);

    await expect(
      harness.owner.mutation(api.notifications.claim, { notification: notification._id }),
    ).resolves.toBe(false);
    await expect(
      harness.member.mutation(api.notifications.claim, { notification: notification._id }),
    ).resolves.toBe(true);
    await expect(
      harness.member.mutation(api.notifications.claim, { notification: notification._id }),
    ).resolves.toBe(false);
  });

  test("a claimed notification is never pushed", async () => {
    const harness = await setup();
    process.env = { ...process.env, ...vapidEnv };
    await subscribeDevice(harness);
    const notification = await notifySession(harness);
    await harness.member.mutation(api.notifications.claim, { notification: notification._id });

    await harness.t.mutation(internal.notifications.deliverFallback, {
      notification: notification._id,
    });
    const [after] = await harness.member.query(api.notifications.recent, {});
    expect(after).toMatchObject({ claimed: true, pushed: false });
    expect(await scheduledNames(harness)).not.toContain("notifications_push:send");
  });

  test("an unclaimed notification goes to subscribed devices once, then cannot be claimed", async () => {
    const harness = await setup();
    process.env = { ...process.env, ...vapidEnv };
    await subscribeDevice(harness);
    const notification = await notifySession(harness);

    await harness.t.mutation(internal.notifications.deliverFallback, {
      notification: notification._id,
    });
    await harness.t.mutation(internal.notifications.deliverFallback, {
      notification: notification._id,
    });
    const names = await scheduledNames(harness);
    expect(names.filter((name) => name === "notifications_push:send")).toHaveLength(1);

    const [after] = await harness.member.query(api.notifications.recent, {});
    expect(after).toMatchObject({ pushed: true, claimed: false });
    await expect(
      harness.member.mutation(api.notifications.claim, { notification: notification._id }),
    ).resolves.toBe(false);
  });

  test("without VAPID keys or devices nothing is pushed and a late tab can still claim", async () => {
    const harness = await setup();
    await subscribeDevice(harness);
    const notification = await notifySession(harness);
    await harness.t.mutation(internal.notifications.deliverFallback, {
      notification: notification._id,
    });

    process.env = { ...process.env, ...vapidEnv };
    await harness.member.mutation(api.notifications.unsubscribe, { endpoint: PUSH_ENDPOINT });
    await harness.t.mutation(internal.notifications.deliverFallback, {
      notification: notification._id,
    });

    expect(await scheduledNames(harness)).not.toContain("notifications_push:send");
    await expect(
      harness.member.mutation(api.notifications.claim, { notification: notification._id }),
    ).resolves.toBe(true);
  });

  test("stale notifications cannot be claimed", async () => {
    vi.useFakeTimers();
    try {
      const harness = await setup();
      const notification = await notifySession(harness);
      vi.advanceTimersByTime(6 * 60 * 1000);
      await expect(
        harness.member.mutation(api.notifications.claim, { notification: notification._id }),
      ).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("preferences", () => {
  test("a disabled category creates nothing; others keep their defaults", async () => {
    const harness = await setup();
    expect(await harness.member.query(api.notifications.getPreferences, {})).toEqual({
      finished: { enabled: true, sound: true },
      attention: { enabled: true, sound: true },
      failed: { enabled: true, sound: true },
      limits: { enabled: true, sound: false },
    });

    await harness.member.mutation(api.notifications.setPreference, {
      category: "finished",
      enabled: false,
      sound: true,
    });
    await harness.t.mutation(internal.notifications.notifySession, {
      userId: "member",
      chat: harness.chat,
      kind: "session_finished",
    });
    expect(await harness.member.query(api.notifications.recent, {})).toEqual([]);

    await notifySession(harness, "session_failed");
    expect(await harness.member.query(api.notifications.recent, {})).toHaveLength(1);
    // Model preferences in the same row are untouched.
    expect(await harness.member.query(api.preferences.get, {})).toEqual({
      pinnedModels: [],
      hiddenModels: [],
    });
  });
});

describe("limit events", () => {
  function eventFor(workspace: Id<"workspaces">, credential: Id<"workspace_credentials">) {
    const meter: Meter = {
      id: "codex:secondary",
      label: "Weekly",
      scope: "credential",
      unit: "percent",
      used: 82,
      source: "header",
      observedAt: Date.now(),
    };
    return {
      workspace,
      kind: "limit_low" as const,
      provider: { slug: "chatgpt", name: "ChatGPT" },
      credential: { id: credential, name: "Work account" },
      meter,
      threshold: 80,
      snapshot: { meters: [meter] },
      settings: resolveLimitSettings(undefined),
      occurredAt: Date.now(),
    };
  }

  test("notify the workspace owner only, and not for archived workspaces", async () => {
    const harness = await setup();
    const credential = await harness.t.run((ctx) =>
      ctx.db.insert("workspace_credentials", {
        workspace: harness.workspace,
        provider: "chatgpt",
        preview: {},
      }),
    );

    await harness.t.run((ctx) => recordLimitEvent(ctx, eventFor(harness.workspace, credential)));
    expect(await harness.owner.query(api.notifications.recent, {})).toEqual([
      expect.objectContaining({
        kind: "limit_low",
        category: "limits",
        title: "Usage limit low",
        body: "Team · Work account: Weekly limit at 82%",
        path: "/gateway/limits",
        workspace: harness.workspace,
      }),
    ]);
    expect(await harness.member.query(api.notifications.recent, {})).toEqual([]);

    await harness.t.run((ctx) =>
      ctx.db.patch("workspaces", harness.workspace, { archivedAt: Date.now() }),
    );
    await harness.t.run((ctx) => recordLimitEvent(ctx, eventFor(harness.workspace, credential)));
    expect(await harness.owner.query(api.notifications.recent, {})).toHaveLength(1);
  });
});

describe("push subscriptions", () => {
  test("only known push services are accepted", async () => {
    const harness = await setup();
    for (const endpoint of [
      "http://fcm.googleapis.com/fcm/send/x",
      "https://127.0.0.1/push",
      "https://evil.example/fcm.googleapis.com",
      "https://fcm.googleapis.com.evil.example/x",
      "https://fcm.googleapis.com:8443/x",
    ]) {
      await expect(
        harness.member.mutation(api.notifications.subscribe, {
          endpoint,
          p256dh: "p",
          auth: "a",
          label: "Browser",
        }),
      ).rejects.toThrow("not supported");
    }
    await harness.member.mutation(api.notifications.subscribe, {
      endpoint: "https://updates.push.services.mozilla.com/wpush/v2/abc",
      p256dh: "p",
      auth: "a",
      label: "Firefox",
    });
    expect(await harness.member.query(api.notifications.listDevices, {})).toEqual([
      expect.objectContaining({ label: "Firefox" }),
    ]);
  });

  test("a browser's endpoint follows whoever subscribed last", async () => {
    const harness = await setup();
    await subscribeDevice(harness);
    await harness.owner.mutation(api.notifications.subscribe, {
      endpoint: PUSH_ENDPOINT,
      p256dh: "p256dh-2",
      auth: "auth-2",
      label: "Firefox on Linux",
    });
    expect(await harness.member.query(api.notifications.listDevices, {})).toEqual([]);
    const [device] = await harness.owner.query(api.notifications.listDevices, {});

    // Another user cannot remove it.
    await harness.member.mutation(api.notifications.unsubscribe, { device: device!._id });
    expect(await harness.owner.query(api.notifications.listDevices, {})).toHaveLength(1);
  });
});
