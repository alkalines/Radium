import { beforeEach, describe, expect, test } from "bun:test";
import { createAccountKeys, equalBytes, toBase64Url } from "radium-crypto";

import {
  createKeyManager,
  KeysLockedError,
  type DeviceKeyStore,
  type DevicePolicy,
  type DeviceRecord,
  type KeyChannel,
  type KeyChannelMessage,
  type KeyManager,
  type PolicyStore,
  type TabBlobStore,
} from "./key-manager";

/** One browser profile: shared IndexedDB, localStorage and BroadcastChannel; tabs on top. */
function createProfile() {
  const devices = new Map<string, DeviceRecord>();
  const policies = new Map<string, DevicePolicy>();
  const channelHandlers = new Set<{ owner: object; handler: (m: KeyChannelMessage) => void }>();
  const clock = { now: 1_000_000 };

  const deviceStore: DeviceKeyStore = {
    get: async (userId) => devices.get(userId),
    put: async (record) => void devices.set(record.userId, { ...record }),
    delete: async (userId) => void devices.delete(userId),
    deleteOthers: async (userId) => {
      for (const key of [...devices.keys()]) if (key !== userId) devices.delete(key);
    },
  };
  const policyStore: PolicyStore = {
    get: (userId) => policies.get(userId) ?? null,
    set: (userId, policy) => void policies.set(userId, policy),
    delete: (userId) => void policies.delete(userId),
  };

  function openTab(sessionStorage = new Map<string, string>()) {
    const owner = {};
    const tabBlobs: TabBlobStore = {
      get: (userId) => sessionStorage.get(userId) ?? null,
      set: (userId, blob) => void sessionStorage.set(userId, blob),
      delete: (userId) => void sessionStorage.delete(userId),
    };
    // BroadcastChannel never delivers to the posting instance.
    const channel: KeyChannel = {
      post(message) {
        for (const entry of channelHandlers) {
          if (entry.owner !== owner) queueMicrotask(() => entry.handler(message));
        }
      },
      subscribe(handler) {
        const entry = { owner, handler };
        channelHandlers.add(entry);
        return () => channelHandlers.delete(entry);
      },
    };
    const manager = createKeyManager({
      devices: deviceStore,
      tabBlobs,
      policies: policyStore,
      channel,
      now: () => clock.now,
      handOffTimeoutMs: 50,
    });
    return { manager, sessionStorage };
  }

  return { devices, clock, openTab };
}

/** Resolves once the manager reaches `state` (cross-tab messages are handled asynchronously). */
function reachState(manager: KeyManager, state: string): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const check = () => {
    if (manager.getSnapshot().state !== state) return;
    unsubscribe();
    resolve();
  };
  const unsubscribe = manager.subscribe(check);
  check();
  return promise;
}

async function newKeys() {
  const { amk, identity } = await createAccountKeys();
  return { amk, identity };
}

async function readAmk(manager: KeyManager): Promise<Uint8Array> {
  return manager.useAmk(async (amk) => amk.slice());
}

const USER = "user-1";

describe("key manager", () => {
  let profile: ReturnType<typeof createProfile>;
  beforeEach(() => {
    profile = createProfile();
  });

  test("unlock stores only ciphertext and survives a reload by default", async () => {
    const keys = await newKeys();
    const tab = profile.openTab();
    await tab.manager.unlock({ userId: USER, ...keys });

    expect(tab.manager.getSnapshot()).toMatchObject({
      state: "unlocked",
      userId: USER,
      keyId: toBase64Url(keys.identity.keyId),
    });
    const record = profile.devices.get(USER);
    expect(record?.wrappingKey.extractable).toBe(false);
    expect(record?.blob).toBeDefined();
    expect(record?.blob).not.toContain(toBase64Url(keys.amk));

    const reloaded = profile.openTab();
    await reloaded.manager.attachSession({ id: USER }, true);
    expect(reloaded.manager.getSnapshot().state).toBe("unlocked");
    expect(equalBytes(await readAmk(reloaded.manager), keys.amk)).toBe(true);
  });

  test("require-password keeps the blob in the tab and hands it to a new tab", async () => {
    const keys = await newKeys();
    const first = profile.openTab();
    await first.manager.setDevicePolicy(USER, { requirePassword: true, autoLockMinutes: null });
    await first.manager.unlock({ userId: USER, ...keys });

    expect(profile.devices.get(USER)?.blob).toBeUndefined();
    expect(first.sessionStorage.get(USER)).toBeDefined();

    const second = profile.openTab();
    await second.manager.attachSession({ id: USER }, true);
    expect(second.manager.getSnapshot().state).toBe("unlocked");
    expect(second.sessionStorage.get(USER)).toBeDefined();
  });

  test("require-password with no other tab open comes back locked", async () => {
    const keys = await newKeys();
    const first = profile.openTab();
    await first.manager.setDevicePolicy(USER, { requirePassword: true, autoLockMinutes: null });
    await first.manager.unlock({ userId: USER, ...keys });
    first.manager.dispose();

    const later = profile.openTab();
    await later.manager.attachSession({ id: USER }, true);
    expect(later.manager.getSnapshot()).toEqual({ state: "locked", userId: USER });
    await expect(readAmk(later.manager)).rejects.toBeInstanceOf(KeysLockedError);
  });

  test("unlocking one tab unlocks the others; locking one locks all", async () => {
    const keys = await newKeys();
    const first = profile.openTab();
    const second = profile.openTab();
    await first.manager.attachSession({ id: USER }, true);
    await second.manager.attachSession({ id: USER }, true);
    expect(second.manager.getSnapshot().state).toBe("locked");

    const unlockedInSecond = reachState(second.manager, "unlocked");
    await first.manager.unlock({ userId: USER, ...keys });
    await unlockedInSecond;
    expect(equalBytes(await readAmk(second.manager), keys.amk)).toBe(true);

    const lockedInFirst = reachState(first.manager, "locked");
    await second.manager.lock();
    await lockedInFirst;
    expect(first.manager.getSnapshot()).toEqual({ state: "locked", userId: USER });
    expect(profile.devices.has(USER)).toBe(false);
  });

  test("a stale restored blob is discarded after the auto-lock time", async () => {
    const keys = await newKeys();
    const tab = profile.openTab();
    await tab.manager.setDevicePolicy(USER, { requirePassword: true, autoLockMinutes: 5 });
    await tab.manager.unlock({ userId: USER, ...keys });
    tab.manager.dispose();

    // Browser session restore brings back sessionStorage after the auto-lock time.
    profile.clock.now += 6 * 60_000;
    const restored = profile.openTab(new Map(tab.sessionStorage));
    await restored.manager.attachSession({ id: USER }, true);
    expect(restored.manager.getSnapshot().state).toBe("locked");
    expect(restored.sessionStorage.has(USER)).toBe(false);
  });

  test("auto-lock counts idle time across tabs", async () => {
    const keys = await newKeys();
    const tab = profile.openTab();
    await tab.manager.setDevicePolicy(USER, { requirePassword: false, autoLockMinutes: 1 });
    await tab.manager.unlock({ userId: USER, ...keys });

    profile.clock.now += 30_000;
    await tab.manager.noteActivity();
    profile.clock.now += 45_000;
    await tab.manager.checkIdle();
    expect(tab.manager.getSnapshot().state).toBe("unlocked");

    profile.clock.now += 61_000;
    await tab.manager.checkIdle();
    expect(tab.manager.getSnapshot().state).toBe("locked");
  });

  test("sign-out and account switches remove the previous user's device state", async () => {
    const keys = await newKeys();
    const tab = profile.openTab();
    await tab.manager.unlock({ userId: USER, ...keys });

    await tab.manager.attachSession({ id: "user-2" }, true);
    expect(profile.devices.has(USER)).toBe(false);
    expect(tab.manager.getSnapshot()).toEqual({ state: "locked", userId: "user-2" });

    await tab.manager.unlock({ userId: "user-2", ...(await newKeys()) });
    await tab.manager.attachSession(null, false);
    expect(tab.manager.getSnapshot()).toEqual({ state: "signed-out" });
    expect(profile.devices.size).toBe(0);
  });

  test("an account without keys reports no-keys", async () => {
    const tab = profile.openTab();
    await tab.manager.attachSession({ id: USER }, false);
    expect(tab.manager.getSnapshot()).toEqual({ state: "no-keys" });
  });
});
