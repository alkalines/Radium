/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { generateEncryptionKeyPair, openBox, toBase64Url } from "radium-crypto";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { recordLimitEvent } from "../src/limits/events";
import { resolveLimitSettings, type Meter } from "../src/limits/meters";
import { sessionNotificationKind, type ChatRequestEnd } from "../src/notifications/session";
import { chatInterruption } from "../src/chatroom/interruption";
import { notificationAad } from "../src/notifications/contract";

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
  vi.useRealTimers();
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

  test("a stopped or failed request leaves an interruption the Session can continue", () => {
    expect(chatInterruption(end({}))).toBeUndefined();
    expect(
      chatInterruption(
        end({ responseMessage: assistant([{ type: "tool-question", state: "input-available" }]) }),
      ),
    ).toBeUndefined();
    expect(chatInterruption(end({ isCancelled: true, outcome: { status: "unknown" } }))).toEqual({
      kind: "interrupted",
    });
    expect(chatInterruption(end({ isAborted: true, failed: true }))).toEqual({
      kind: "interrupted",
    });
    // A failure records only its kind; provider error text is never persisted.
    expect(chatInterruption(end({ failed: true }))).toEqual({ kind: "failed" });
    // Hitting the step cap mid-work is continuable, but a stop or failure still wins.
    expect(chatInterruption(end({}), true)).toEqual({ kind: "step_limit" });
    expect(chatInterruption(end({ isAborted: true }), true)).toEqual({
      kind: "interrupted",
    });
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
      body: "Session",
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

  test("new notifications and push do not disclose a legacy chat title", async () => {
    const harness = await setup();
    await subscribeDevice(harness);
    const notification = await notifySession(harness);
    const stored = await harness.t.run((ctx) => ctx.db.get("notifications", notification._id));
    expect(stored).toMatchObject({ title: "Session finished", body: "Session" });
    expect(JSON.stringify(stored)).not.toContain("Refactor routing");
    const target = await harness.t.query(internal.notifications.pushTargets, {
      notification: notification._id,
    });
    expect(target?.payload).not.toContain("Refactor routing");

    await harness.t.run((ctx) =>
      ctx.db.patch("notifications", notification._id, {
        title: "Private legacy title",
        body: "Private legacy body",
      }),
    );
    const [view] = await harness.member.query(api.notifications.recent, {});
    expect(JSON.stringify(view)).not.toContain("Private legacy");
    const legacyTarget = await harness.t.query(internal.notifications.pushTargets, {
      notification: notification._id,
    });
    expect(legacyTarget?.payload).not.toContain("Private legacy");
  });

  test("identity-backed content is sealed and bound to the recipient and row", async () => {
    const harness = await setup();
    const identity = await generateEncryptionKeyPair();
    const other = await generateEncryptionKeyPair();
    const keyId = toBase64Url(new Uint8Array(16).fill(7));
    await harness.t.run((ctx) => ctx.db.insert("e2ee_identities", {
      userId: "member", keyId, suite: 1,
      encryptionPublicKey: identity.publicKey.slice().buffer,
      signingPublicKey: new ArrayBuffer(32),
      secrets: new ArrayBuffer(1), selfSignature: new ArrayBuffer(1),
      recoveryWrapper: new ArrayBuffer(1), status: "active", createdAt: Date.now(),
    }));
    await harness.t.mutation(internal.notifications.notifySession, {
      userId: "member", chat: harness.chat, kind: "session_finished",
    });
    const row = await harness.t.run(async (ctx) => (await ctx.db.query("notifications").collect())[0]!);
    expect(row.sealingPending).toBe(true);
    expect(JSON.stringify(row)).not.toContain("Refactor routing");
    await harness.t.action(internal.notifications.sealNotification, { notification: row._id });
    const [view] = await harness.member.query(api.notifications.recent, {});
    expect(view?.sealed?.keyId).toBe(keyId);
    const aad = notificationAad("member", harness.workspace, row._id);
    const box = new Uint8Array(view!.sealed!.box);
    const plaintext = await openBox({ seed: identity.seed, box, aad, pad: "short" });
    expect(JSON.parse(new TextDecoder().decode(plaintext))).toEqual({
      title: "Session finished", body: "Refactor routing",
    });
    await expect(openBox({ seed: other.seed, box, aad, pad: "short" })).rejects.toThrow();
    await expect(openBox({ seed: identity.seed, box, aad: { ...aad, parent: "owner" }, pad: "short" })).rejects.toThrow();
    const target = await harness.t.query(internal.notifications.pushTargets, { notification: row._id });
    expect(target?.payload).not.toContain("Refactor routing");
    expect(new TextEncoder().encode(target!.payload).byteLength).toBeLessThan(4096);
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
        body: "Workspace",
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

describe("sealing and the encryption cutover freeze", () => {
  const ROTATION_KEY_ID = toBase64Url(new Uint8Array(16).fill(9));
  const KEY_ID = toBase64Url(new Uint8Array(16).fill(7));

  async function activeIdentity(harness: Harness, keyId = KEY_ID) {
    const pair = await generateEncryptionKeyPair();
    await harness.t.run((ctx) => ctx.db.insert("e2ee_identities", {
      userId: "member", keyId, suite: 1,
      encryptionPublicKey: pair.publicKey.slice().buffer,
      signingPublicKey: new ArrayBuffer(32),
      secrets: new ArrayBuffer(1), selfSignature: new ArrayBuffer(1),
      recoveryWrapper: new ArrayBuffer(1), status: "active", createdAt: Date.now(),
    }));
    return pair;
  }

  async function setFrozenState(harness: Harness, frozen: boolean) {
    await harness.t.run(async (ctx) => {
      const state = await ctx.db.query("e2ee_migration_state").first();
      if (state) await ctx.db.patch("e2ee_migration_state", state._id, { frozen, generation: state.generation + 1 });
      else await ctx.db.insert("e2ee_migration_state", {
        key: "global", frozen, generation: 1, custodyState: "none", custodyWrites: 0, cutoverComplete: false,
      });
    });
  }

  async function pendingRow(harness: Harness) {
    await harness.t.mutation(internal.notifications.notifySession, {
      userId: "member", chat: harness.chat, kind: "session_finished",
    });
    return await harness.t.run(async (ctx) => (await ctx.db.query("notifications").order("desc").first())!);
  }

  const readRow = (harness: Harness, id: Id<"notifications">) =>
    harness.t.run((ctx) => ctx.db.get("notifications", id));

  async function scheduledCount(harness: Harness, name: string) {
    return (await scheduledNames(harness)).filter((scheduled) => scheduled === name).length;
  }

  test("sealing held by a freeze resumes after unfreeze with the original body and no second push", async () => {
    vi.useFakeTimers();
    const harness = await setup();
    process.env = { ...process.env, ...vapidEnv };
    await subscribeDevice(harness);
    const identity = await activeIdentity(harness);
    const row = await pendingRow(harness);
    expect(row.sealingPending).toBe(true);

    await setFrozenState(harness, true);
    await harness.t.action(internal.notifications.sealNotification, { notification: row._id });
    // Frozen: nothing is sealed, and the marker survives instead of being dropped.
    expect(await readRow(harness, row._id)).toMatchObject({ sealingPending: true });
    expect((await readRow(harness, row._id))?.sealed).toBeUndefined();

    // The push fallback may run during the freeze; it must not clear the marker.
    await harness.t.mutation(internal.notifications.deliverFallback, { notification: row._id });
    vi.advanceTimersByTime(0);
    await harness.t.finishInProgressScheduledFunctions();
    const delivered = await readRow(harness, row._id);
    expect(delivered).toMatchObject({ sealingPending: true, delivery: { channel: "web_push" } });
    expect(await scheduledCount(harness, "notifications_push:send")).toBe(1);

    // Resuming while still frozen schedules nothing.
    const sealingJobs = await scheduledCount(harness, "notifications:sealNotification");
    await harness.t.mutation(internal.notifications.resumeSealing, {});
    expect(await scheduledCount(harness, "notifications:sealNotification")).toBe(sealingJobs);

    await setFrozenState(harness, false);
    await harness.t.mutation(internal.notifications.resumeSealing, {});
    expect(await scheduledCount(harness, "notifications:sealNotification")).toBe(sealingJobs + 1);
    await harness.t.action(internal.notifications.sealNotification, { notification: row._id });

    const sealed = await readRow(harness, row._id);
    expect(sealed?.sealingPending).toBe(false);
    expect(sealed?.delivery).toEqual(delivered?.delivery);
    expect(await scheduledCount(harness, "notifications_push:send")).toBe(1);
    const plaintext = await openBox({
      seed: identity.seed,
      box: new Uint8Array(sealed!.sealed!.box),
      aad: notificationAad("member", harness.workspace, row._id),
      pad: "short",
    });
    expect(JSON.parse(new TextDecoder().decode(plaintext))).toEqual({
      title: "Session finished", body: "Refactor routing",
    });
    expect(JSON.stringify(sealed)).not.toContain("Refactor routing");

    // A duplicate resume (cutover hook plus safety net) leaves the envelope byte-identical.
    const before = new Uint8Array(sealed!.sealed!.box);
    await harness.t.mutation(internal.notifications.resumeSealing, {});
    await harness.t.action(internal.notifications.sealNotification, { notification: row._id });
    const after = (await readRow(harness, row._id))!;
    expect(new Uint8Array(after.sealed!.box)).toEqual(before);
    expect(after.sealed!.keyId).toBe(KEY_ID);
  });

  test("resume pages by opaque cursor, only over pending rows", async () => {
    const harness = await setup();
    await activeIdentity(harness);
    await harness.t.run(async (ctx) => {
      const member = await ctx.db.query("aisdk_chats").first();
      for (let index = 0; index < 51; index += 1) {
        await ctx.db.insert("notifications", {
          userId: "member", kind: "session_finished", title: "Session finished", body: "Session",
          chat: member!._id, createdAt: index, sealingPending: true,
        });
      }
      await ctx.db.insert("notifications", {
        userId: "member", kind: "session_finished", title: "Session finished", body: "Session",
        createdAt: 99, sealingPending: false,
      });
    });
    await harness.t.mutation(internal.notifications.resumeSealing, {});
    expect(await scheduledCount(harness, "notifications:sealNotification")).toBe(50);
    expect(await scheduledCount(harness, "notifications:resumeSealing")).toBe(1);
    const jobs = await harness.t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    const continuation = jobs.find((job) => job.name === "notifications:resumeSealing");
    const [first] = continuation?.args ?? [];
    const cursor = first && typeof first === "object" && "cursor" in first ? first.cursor : undefined;
    expect(typeof cursor).toBe("string");
    if (typeof cursor !== "string") return;
    await harness.t.mutation(internal.notifications.resumeSealing, { cursor });
    expect(await scheduledCount(harness, "notifications:sealNotification")).toBe(51);
  });

  test("an existing native envelope or historical content is never wrapped, replaced or shadowed", async () => {
    const harness = await setup();
    await activeIdentity(harness);
    const native = await pendingRow(harness);
    const existing = { keyId: KEY_ID, box: new Uint8Array([1, 2, 3, 4]).buffer };
    await harness.t.run((ctx) => ctx.db.patch("notifications", native._id, { sealed: existing }));
    await harness.t.action(internal.notifications.sealNotification, { notification: native._id });
    const kept = (await readRow(harness, native._id))!;
    expect(new Uint8Array(kept.sealed!.box)).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(kept.sealingPending).toBe(false);

    // Historical content (here a custody sidecar) would be shadowed by a generic native box.
    const historic = await pendingRow(harness);
    const legacyContent = { kind: "custody" as const, keyId: "custody", epoch: 1, box: new Uint8Array([9, 8, 7]).buffer };
    await harness.t.run((ctx) => ctx.db.patch("notifications", historic._id, { legacyContent }));
    await harness.t.action(internal.notifications.sealNotification, { notification: historic._id });
    const custody = (await readRow(harness, historic._id))!;
    expect(custody.sealed).toBeUndefined();
    expect(custody.legacyContent).toEqual(legacyContent);
    expect(custody.sealingPending).toBe(false);
  });

  test("a chat title moved into a migration sidecar is never invented or read back", async () => {
    const harness = await setup();
    const identity = await activeIdentity(harness);
    const row = await pendingRow(harness);
    await harness.t.run((ctx) => ctx.db.patch("aisdk_chats", harness.chat, {
      title: undefined,
      legacyContent: { kind: "custody", keyId: "custody", epoch: 1, box: new Uint8Array([1]).buffer },
    }));
    await harness.t.action(internal.notifications.sealNotification, { notification: row._id });
    const sealed = (await readRow(harness, row._id))!;
    const plaintext = await openBox({
      seed: identity.seed,
      box: new Uint8Array(sealed.sealed!.box),
      aad: notificationAad("member", harness.workspace, row._id),
      pad: "short",
    });
    expect(JSON.parse(new TextDecoder().decode(plaintext))).toEqual({ title: "Session finished", body: "Session" });
  });

  test("an identity rotation between sealing and commit stores no box and no plaintext", async () => {
    const harness = await setup();
    await activeIdentity(harness);
    const row = await pendingRow(harness);
    const input = await harness.t.query(internal.notifications.sealingInput, { notification: row._id });
    expect(input?.keyId).toBe(KEY_ID);

    await harness.t.run(async (ctx) => {
      const old = await ctx.db.query("e2ee_identities").first();
      await ctx.db.patch("e2ee_identities", old!._id, { status: "retired", retiredAt: Date.now() });
    });
    await activeIdentity(harness, ROTATION_KEY_ID);
    await harness.t.mutation(internal.notifications.finishSealing, {
      notification: row._id,
      sealed: { keyId: input!.keyId, box: new Uint8Array([5, 5, 5]).buffer },
    });
    const after = (await readRow(harness, row._id))!;
    expect(after.sealed).toBeUndefined();
    expect(after.sealingPending).toBe(false);
    expect(JSON.stringify(after)).not.toContain("Refactor routing");
    expect(after).toMatchObject({ title: "Session finished", body: "Session" });
  });

  test("no recipient key keeps the generic notification and ends the marker", async () => {
    const harness = await setup();
    await activeIdentity(harness);
    const row = await pendingRow(harness);
    await harness.t.run(async (ctx) => {
      const identity = await ctx.db.query("e2ee_identities").first();
      await ctx.db.patch("e2ee_identities", identity!._id, { status: "retired", retiredAt: Date.now() });
    });
    await harness.t.action(internal.notifications.sealNotification, { notification: row._id });
    const after = (await readRow(harness, row._id))!;
    expect(after.sealed).toBeUndefined();
    expect(after.sealingPending).toBe(false);
    expect(JSON.stringify(after)).not.toContain("Refactor routing");
  });

  test("hourly prune restarts sealing only for stalled pending rows and never while frozen", async () => {
    const harness = await setup();
    await activeIdentity(harness);
    const fresh = await pendingRow(harness);
    await harness.t.mutation(internal.notifications.prune, {});
    expect(await scheduledCount(harness, "notifications:resumeSealing")).toBe(0);

    // An in-flight row is never restarted; a row stalled past the browser grace is.
    await harness.t.run((ctx) => ctx.db.patch("notifications", fresh._id, { createdAt: Date.now() - 60_000 }));
    await setFrozenState(harness, true);
    await harness.t.mutation(internal.notifications.prune, {});
    expect(await scheduledCount(harness, "notifications:resumeSealing")).toBe(0);

    await setFrozenState(harness, false);
    await harness.t.mutation(internal.notifications.prune, {});
    expect(await scheduledCount(harness, "notifications:resumeSealing")).toBe(1);
  });
});
