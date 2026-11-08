/**
 * Holds the unlocked account keys of this browser tab (`docs/E2EE/Keys.md` "On the device").
 *
 * The AMK and identity seeds live only in this module's memory while unlocked. Between page
 * loads they are stored solely as a *blob* encrypted under a per-user, non-extractable AES-GCM
 * device wrapping key kept in IndexedDB: the blob sits next to that key in IndexedDB by default
 * ("remember"), or only in this tab's `sessionStorage` when the device policy requires the
 * password. Tabs coordinate over the `radium-keys` BroadcastChannel; only blobs (ciphertext) and
 * lock/heartbeat signals are posted, never key bytes.
 *
 * Framework-free: React reads it through `use-key-status.ts`. {@link createKeyManager} takes its
 * storage and channel as dependencies so the logic is testable without a browser; the exported
 * {@link keyManager} wires the real browser APIs lazily (nothing touches `window` on import, so
 * server rendering sees `signed-out`).
 */
import {
  LABELS,
  buildAad,
  encryptionPublicKeyFromSeed,
  fingerprint,
  fromBase64Url,
  signingPublicKeyFromSeed,
  toBase64Url,
  type IdentityKeys,
} from "radium-crypto";

import { wipeAccount, type UnlockedAccount } from "./account-keys";

/** What the UI may know about this tab's keys. Never carries key material. */
export type KeyStatus =
  | { state: "signed-out" }
  | { state: "no-keys" }
  | { state: "locked"; userId: string }
  | { state: "unlocked"; userId: string; keyId: string; fingerprint: string };

/** Per-device, per-user choice offered at sign-in and in Settings → Security. */
export type DevicePolicy = { requirePassword: boolean; autoLockMinutes: number | null };

/** Thrown by {@link KeyManager.useAmk} when this tab holds no unlocked keys. */
export class KeysLockedError extends Error {
  constructor() {
    super("Encryption keys are locked on this device");
    this.name = "KeysLockedError";
  }
}

/** IndexedDB row: the device wrapping key, plus the blob in "remember" mode. */
export type DeviceRecord = { userId: string; wrappingKey: CryptoKey; blob?: string };

/** Persistent per-user device key storage (IndexedDB in the browser). */
export interface DeviceKeyStore {
  get(userId: string): Promise<DeviceRecord | undefined>;
  put(record: DeviceRecord): Promise<void>;
  delete(userId: string): Promise<void>;
  /** Removes every other user's record. */
  deleteOthers(userId: string): Promise<void>;
}

/** Per-tab blob storage (`sessionStorage` in the browser). */
export interface TabBlobStore {
  get(userId: string): string | null;
  set(userId: string, blob: string): void;
  delete(userId: string): void;
}

/** Non-secret device policy storage (`localStorage` in the browser). */
export interface PolicyStore {
  get(userId: string): DevicePolicy | null;
  set(userId: string, policy: DevicePolicy): void;
  delete(userId: string): void;
}

/** Messages on the `radium-keys` channel. `blob` is always device-wrapped ciphertext. */
export type KeyChannelMessage =
  | { type: "request"; userId: string }
  | { type: "blob"; userId: string; blob: string }
  | { type: "heartbeat"; userId: string; at: number }
  | { type: "lock"; userId: string };

export interface KeyChannel {
  post(message: KeyChannelMessage): void;
  subscribe(handler: (message: KeyChannelMessage) => void): () => void;
}

export type KeyManagerDeps = {
  devices: DeviceKeyStore;
  tabBlobs: TabBlobStore;
  policies: PolicyStore;
  channel: KeyChannel | null;
  now: () => number;
  /** How long a tab without a usable blob waits for another tab to hand one over. */
  handOffTimeoutMs: number;
};

/** The key manager contract (shared E2EE contract, "Web"). */
export interface KeyManager {
  getSnapshot(): KeyStatus;
  subscribe(listener: () => void): () => void;
  /**
   * Binds the tab to the signed-in user (or none) and restores keys from this device. Called
   * whenever the session or its key state changes; idempotent for the same input. A different
   * or absent user forgets the previous user's keys on this device (sign-out, account switch).
   */
  attachSession(user: { id: string } | null, hasKeys: boolean): Promise<void>;
  /**
   * Takes freshly opened keys (sign-in, sign-up, reset), stores them per the device policy
   * under a new device wrapping key and hands them to the other tabs. Call only after the
   * plugin call that produced them succeeded. The manager keeps its own copies.
   */
  unlock(input: { userId: string; amk: Uint8Array; identity: IdentityKeys }): Promise<void>;
  /** Locks every tab: drops keys, deletes the device key and posts `lock`. */
  lock(): Promise<void>;
  /** Sign-out: {@link KeyManager.lock} plus removal of the user's device policy. */
  forget(userId: string): Promise<void>;
  /**
   * Runs `fn` with the unlocked AMK and identity. The bytes are the manager's own: use them
   * within `fn` and never store or serialize them. Throws {@link KeysLockedError} when locked.
   */
  useAmk<T>(fn: (amk: Uint8Array, identity: IdentityKeys) => Promise<T>): Promise<T>;
  getDevicePolicy(userId: string): DevicePolicy;
  /** Saves the policy and, when unlocked, moves the blob to where the policy wants it. */
  setDevicePolicy(userId: string, policy: DevicePolicy): Promise<void>;
  /**
   * Records user activity. Throttled: shares a heartbeat with other tabs and refreshes the
   * stored blob's activity stamp so a blob restored after the auto-lock time is discarded.
   */
  noteActivity(): Promise<void>;
  /** Locks when the auto-lock time passed since the last activity in any tab. */
  checkIdle(): Promise<void>;
  /** Stops listening to the channel and drops keys from memory (tests). */
  dispose(): void;
}

const DEFAULT_POLICY: DevicePolicy = { requirePassword: false, autoLockMinutes: null };

/** Heartbeats and blob activity stamps are throttled to this interval. */
const ACTIVITY_THROTTLE_MS = 20_000;

/** Bytes inside a device blob: AMK ‖ encryption seed ‖ signing seed. */
const SECRET_PART_BYTES = 32;

type Unlocked = UnlockedAccount & {
  userId: string;
  keyId: string;
  fingerprint: string;
  /** Current device-wrapped blob, handed to other tabs on request. */
  blob: string;
};

/** Parsed device blob. `lastActivity` is outside the AEAD: it only decides when to discard. */
type DeviceBlob = {
  v: 1;
  userId: string;
  keyId: string;
  suite: number;
  nonce: string;
  ciphertext: string;
  lastActivity: number;
};

/** AAD binding a blob to its user and identity, so blobs cannot be swapped between users. */
function deviceAad(userId: string, keyId: string): Uint8Array<ArrayBuffer> {
  const aad = buildAad({
    table: LABELS.deviceWrap,
    workspace: "",
    parent: userId,
    record: keyId,
    field: "keys",
  });
  return new Uint8Array(aad);
}

function parseBlob(text: string): DeviceBlob | null {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null) return null;
    const blob = value as Record<string, unknown>;
    if (
      blob.v !== 1 ||
      typeof blob.userId !== "string" ||
      typeof blob.keyId !== "string" ||
      typeof blob.suite !== "number" ||
      typeof blob.nonce !== "string" ||
      typeof blob.ciphertext !== "string" ||
      typeof blob.lastActivity !== "number"
    ) {
      return null;
    }
    return blob as DeviceBlob;
  } catch {
    return null;
  }
}

/** Restamps a blob's activity time; the ciphertext is unchanged. */
function withActivity(text: string, lastActivity: number): string {
  const blob = parseBlob(text);
  if (!blob) return text;
  return JSON.stringify({ ...blob, lastActivity });
}

async function sealBlob(input: {
  wrappingKey: CryptoKey;
  userId: string;
  keys: UnlockedAccount;
  lastActivity: number;
}): Promise<string> {
  const { identity } = input.keys;
  const keyId = toBase64Url(identity.keyId);
  const plaintext = new Uint8Array(SECRET_PART_BYTES * 3);
  plaintext.set(input.keys.amk, 0);
  plaintext.set(identity.encryption.seed, SECRET_PART_BYTES);
  plaintext.set(identity.signing.seed, SECRET_PART_BYTES * 2);

  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: deviceAad(input.userId, keyId) },
    input.wrappingKey,
    plaintext,
  );
  plaintext.fill(0);

  const blob: DeviceBlob = {
    v: 1,
    userId: input.userId,
    keyId,
    suite: identity.suite,
    nonce: toBase64Url(nonce),
    ciphertext: toBase64Url(new Uint8Array(ciphertext)),
    lastActivity: input.lastActivity,
  };
  return JSON.stringify(blob);
}

/** Decrypts a blob and rebuilds the identity (public keys are re-derived from the seeds). */
async function openBlob(wrappingKey: CryptoKey, blob: DeviceBlob): Promise<UnlockedAccount> {
  const plaintext = new Uint8Array(
    await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: new Uint8Array(fromBase64Url(blob.nonce)),
        additionalData: deviceAad(blob.userId, blob.keyId),
      },
      wrappingKey,
      new Uint8Array(fromBase64Url(blob.ciphertext)),
    ),
  );
  if (plaintext.length !== SECRET_PART_BYTES * 3) throw new Error("Malformed device blob");

  const amk = plaintext.slice(0, SECRET_PART_BYTES);
  const encryptionSeed = plaintext.slice(SECRET_PART_BYTES, SECRET_PART_BYTES * 2);
  const signingSeed = plaintext.slice(SECRET_PART_BYTES * 2);
  plaintext.fill(0);

  const identity: IdentityKeys = {
    keyId: fromBase64Url(blob.keyId),
    suite: blob.suite,
    encryption: {
      suite: blob.suite,
      seed: encryptionSeed,
      publicKey: await encryptionPublicKeyFromSeed(encryptionSeed),
    },
    signing: {
      suite: blob.suite,
      seed: signingSeed,
      publicKey: await signingPublicKeyFromSeed(signingSeed),
    },
  };
  return { amk, identity };
}

/**
 * Creates a key manager over the given storage. The browser singleton is {@link keyManager};
 * tests create their own with in-memory dependencies.
 */
export function createKeyManager(deps: KeyManagerDeps): KeyManager {
  let status: KeyStatus = { state: "signed-out" };
  const listeners = new Set<() => void>();

  /** The user this tab's Better Auth session belongs to, as last attached. */
  let attachedUserId: string | null = null;
  let unlocked: Unlocked | null = null;
  let lastActivity = deps.now();
  let lastActivityShared = 0;

  // Every operation that changes the key state bumps this; async restores check it before they
  // commit, so a lock, sign-out or newer unlock that happened meanwhile wins.
  let generation = 0;

  /** Pending hand-off request of this tab, resolved by the first blob for that user. */
  let pendingHandOff: { userId: string; resolve: (blob: string | null) => void } | null = null;

  function setStatus(next: KeyStatus) {
    status = next;
    for (const listener of listeners) listener();
  }

  function lockedStatus(): KeyStatus {
    return attachedUserId ? { state: "locked", userId: attachedUserId } : { state: "signed-out" };
  }

  function getDevicePolicy(userId: string): DevicePolicy {
    return deps.policies.get(userId) ?? DEFAULT_POLICY;
  }

  /** Writes the blob where the policy says: IndexedDB next to the key, or this tab only. */
  async function persist(record: DeviceRecord, blob: string, policy: DevicePolicy) {
    if (policy.requirePassword) {
      await deps.devices.put({ userId: record.userId, wrappingKey: record.wrappingKey });
      deps.tabBlobs.set(record.userId, blob);
    } else {
      await deps.devices.put({ userId: record.userId, wrappingKey: record.wrappingKey, blob });
      deps.tabBlobs.delete(record.userId);
    }
  }

  /**
   * Makes `keys` this tab's unlocked keys unless the state changed meanwhile (`current` is the
   * generation the caller started from); dropped keys are wiped.
   */
  async function commitUnlocked(
    userId: string,
    keys: UnlockedAccount,
    blob: string,
    current: number,
  ) {
    const print = await fingerprint({
      encryptionPublicKey: keys.identity.encryption.publicKey,
      signingPublicKey: keys.identity.signing.publicKey,
    });
    if (current !== generation || attachedUserId !== userId) {
      wipeAccount(keys);
      return;
    }

    if (unlocked) wipeAccount(unlocked);
    const keyId = toBase64Url(keys.identity.keyId);
    unlocked = { ...keys, userId, keyId, fingerprint: print, blob };
    lastActivity = deps.now();
    setStatus({ state: "unlocked", userId, keyId, fingerprint: print });
  }

  /** Drops this tab's keys and stored blob without touching other tabs or the device key. */
  function dropLocal(userId: string) {
    if (unlocked?.userId === userId) {
      wipeAccount(unlocked);
      unlocked = null;
    }
    deps.tabBlobs.delete(userId);
  }

  /** Opens a blob with the user's device key; `null` when it is stale, foreign or does not open. */
  async function tryOpen(userId: string, blobText: string): Promise<UnlockedAccount | null> {
    const blob = parseBlob(blobText);
    if (!blob || blob.userId !== userId) return null;

    // A blob restored after the auto-lock time (browser session restore) must come back locked.
    const { autoLockMinutes } = getDevicePolicy(userId);
    if (autoLockMinutes !== null && deps.now() - blob.lastActivity > autoLockMinutes * 60_000) {
      return null;
    }

    const record = await deps.devices.get(userId);
    if (!record) return null;
    try {
      return await openBlob(record.wrappingKey, blob);
    } catch {
      // Replaced device key or tampered blob.
      return null;
    }
  }

  /** Asks the other tabs for a blob; resolves `null` when none answers in time. */
  function requestHandOff(userId: string): Promise<string | null> {
    const channel = deps.channel;
    if (!channel) return Promise.resolve(null);
    pendingHandOff?.resolve(null);

    const { promise, resolve } = Promise.withResolvers<string | null>();
    const finish = (blob: string | null) => {
      clearTimeout(timer);
      if (pendingHandOff?.resolve === finish) pendingHandOff = null;
      resolve(blob);
    };
    const timer = setTimeout(() => finish(null), deps.handOffTimeoutMs);
    pendingHandOff = { userId, resolve: finish };
    channel.post({ type: "request", userId });
    return promise;
  }

  /** Restores keys for the attached user from this device, or settles on `locked`. */
  async function restore(userId: string, current: number) {
    const policy = getDevicePolicy(userId);
    let blobText = policy.requirePassword
      ? deps.tabBlobs.get(userId)
      : ((await deps.devices.get(userId))?.blob ?? null);
    let opened = blobText ? await tryOpen(userId, blobText) : null;

    // Without a usable blob of its own, a require-password tab asks the other tabs.
    if (!opened && policy.requirePassword && current === generation) {
      deps.tabBlobs.delete(userId);
      blobText = await requestHandOff(userId);
      opened = blobText ? await tryOpen(userId, blobText) : null;
    }
    if (current !== generation) {
      if (opened) wipeAccount(opened);
      return;
    }

    if (!opened || !blobText) {
      // A remembered blob that is stale or no longer opens is useless; drop it so it cannot
      // unlock later either.
      if (!policy.requirePassword) {
        const record = await deps.devices.get(userId);
        if (record?.blob) await deps.devices.put({ userId, wrappingKey: record.wrappingKey });
      }
      if (current === generation) setStatus({ state: "locked", userId });
      return;
    }

    if (policy.requirePassword) deps.tabBlobs.set(userId, blobText);
    await commitUnlocked(userId, opened, blobText, current);
  }

  async function handleMessage(message: KeyChannelMessage) {
    if (message.type === "blob" && pendingHandOff?.userId === message.userId) {
      pendingHandOff.resolve(message.blob);
      return;
    }
    if (message.userId !== attachedUserId) return;

    switch (message.type) {
      case "request": {
        if (unlocked?.userId === message.userId) {
          deps.channel?.post({ type: "blob", userId: message.userId, blob: unlocked.blob });
        }
        return;
      }
      case "heartbeat": {
        lastActivity = Math.max(lastActivity, message.at);
        return;
      }
      case "lock": {
        generation += 1;
        dropLocal(message.userId);
        setStatus(lockedStatus());
        return;
      }
      case "blob": {
        // Another tab unlocked or re-wrapped: adopt its blob, which the shared device key opens.
        const current = ++generation;
        const opened = await tryOpen(message.userId, message.blob);
        if (!opened) return;
        if (getDevicePolicy(message.userId).requirePassword && current === generation) {
          deps.tabBlobs.set(message.userId, message.blob);
        }
        await commitUnlocked(message.userId, opened, message.blob, current);
        return;
      }
    }
  }

  const unsubscribeChannel = deps.channel?.subscribe((message) => {
    void handleMessage(message);
  });

  /** Drops keys in every tab and deletes the device key, so stored blobs open nothing. */
  async function lockUser(userId: string) {
    generation += 1;
    dropLocal(userId);
    await deps.devices.delete(userId);
    deps.channel?.post({ type: "lock", userId });
  }

  async function forget(userId: string) {
    await lockUser(userId);
    deps.policies.delete(userId);
    if (attachedUserId === userId) attachedUserId = null;
    setStatus(lockedStatus());
  }

  async function lock() {
    const userId = attachedUserId ?? unlocked?.userId;
    if (!userId) return;
    await lockUser(userId);
    setStatus(lockedStatus());
  }

  return {
    getSnapshot: () => status,

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async attachSession(user, hasKeys) {
      const userId = user?.id ?? null;
      const previous = attachedUserId;
      if (previous !== null && previous !== userId) await forget(previous);
      attachedUserId = userId;

      if (userId === null) {
        generation += 1;
        setStatus({ state: "signed-out" });
        return;
      }

      // Only the signed-in user's device state may stay on this browser profile.
      await deps.devices.deleteOthers(userId);

      if (!hasKeys) {
        generation += 1;
        dropLocal(userId);
        await deps.devices.delete(userId);
        setStatus({ state: "no-keys" });
        return;
      }

      if (unlocked?.userId === userId) {
        if (status.state !== "unlocked") {
          const { keyId, fingerprint: print } = unlocked;
          setStatus({ state: "unlocked", userId, keyId, fingerprint: print });
        }
        return;
      }

      const current = ++generation;
      await restore(userId, current);
    },

    async unlock(input) {
      if (attachedUserId !== null && attachedUserId !== input.userId) {
        await forget(attachedUserId);
      }
      attachedUserId = input.userId;
      const current = ++generation;

      const keys: UnlockedAccount = {
        amk: input.amk.slice(),
        identity: {
          ...input.identity,
          keyId: input.identity.keyId.slice(),
          encryption: {
            ...input.identity.encryption,
            seed: input.identity.encryption.seed.slice(),
          },
          signing: { ...input.identity.signing, seed: input.identity.signing.seed.slice() },
        },
      };

      // A fresh device key per unlock: blobs from before the last lock never open again.
      const wrappingKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
        "encrypt",
        "decrypt",
      ]);
      const blob = await sealBlob({
        wrappingKey,
        userId: input.userId,
        keys,
        lastActivity: deps.now(),
      });
      await persist({ userId: input.userId, wrappingKey }, blob, getDevicePolicy(input.userId));
      await commitUnlocked(input.userId, keys, blob, current);
      deps.channel?.post({ type: "blob", userId: input.userId, blob });
    },

    lock,
    forget,

    async useAmk(fn) {
      if (!unlocked) throw new KeysLockedError();
      return fn(unlocked.amk, unlocked.identity);
    },

    getDevicePolicy,

    async setDevicePolicy(userId, policy) {
      deps.policies.set(userId, policy);
      if (unlocked?.userId !== userId) return;
      const record = await deps.devices.get(userId);
      if (!record) return;
      unlocked.blob = withActivity(unlocked.blob, lastActivity);
      await persist(record, unlocked.blob, policy);
      deps.channel?.post({ type: "blob", userId, blob: unlocked.blob });
    },

    async noteActivity() {
      const now = deps.now();
      lastActivity = now;
      if (!unlocked || now - lastActivityShared < ACTIVITY_THROTTLE_MS) return;
      lastActivityShared = now;

      const { userId } = unlocked;
      deps.channel?.post({ type: "heartbeat", userId, at: now });
      unlocked.blob = withActivity(unlocked.blob, now);
      if (getDevicePolicy(userId).requirePassword) {
        deps.tabBlobs.set(userId, unlocked.blob);
        return;
      }
      const record = await deps.devices.get(userId);
      if (record) await deps.devices.put({ ...record, blob: unlocked.blob });
    },

    async checkIdle() {
      if (!unlocked) return;
      const { autoLockMinutes } = getDevicePolicy(unlocked.userId);
      if (autoLockMinutes === null) return;
      if (deps.now() - lastActivity > autoLockMinutes * 60_000) await lock();
    },

    dispose() {
      unsubscribeChannel?.();
      if (unlocked) wipeAccount(unlocked);
      unlocked = null;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Browser wiring

const DB_NAME = "radium-keys";
const DB_STORE = "devices";
const TAB_BLOB_PREFIX = "radium.keys.blob.v1:";
const POLICY_PREFIX = "radium.keys.policy.v1:";

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
  return promise;
}

function indexedDbDeviceStore(): DeviceKeyStore {
  let database: Promise<IDBDatabase> | null = null;

  async function objectStore(mode: IDBTransactionMode) {
    if (!database) {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore(DB_STORE, { keyPath: "userId" });
      };
      database = requestResult(request);
    }
    return (await database).transaction(DB_STORE, mode).objectStore(DB_STORE);
  }

  return {
    async get(userId) {
      const store = await objectStore("readonly");
      return (await requestResult(store.get(userId))) as DeviceRecord | undefined;
    },
    async put(record) {
      await requestResult((await objectStore("readwrite")).put(record));
    },
    async delete(userId) {
      await requestResult((await objectStore("readwrite")).delete(userId));
    },
    async deleteOthers(userId) {
      const store = await objectStore("readwrite");
      const keys = await requestResult(store.getAllKeys());
      for (const key of keys) {
        if (key !== userId) await requestResult(store.delete(key));
      }
    },
  };
}

/** Prefixed JSON values in Web Storage; failures (disabled, full) behave as "not stored". */
function webStorage(storage: () => Storage, prefix: string) {
  return {
    get(userId: string): unknown {
      try {
        const value = storage().getItem(prefix + userId);
        return value === null ? null : JSON.parse(value);
      } catch {
        return null;
      }
    },
    set(userId: string, value: unknown) {
      try {
        storage().setItem(prefix + userId, JSON.stringify(value));
      } catch {
        // Not stored: the keys or policy are simply not remembered.
      }
    },
    delete(userId: string) {
      try {
        storage().removeItem(prefix + userId);
      } catch {
        // Nothing stored.
      }
    },
  };
}

function parsePolicy(value: unknown): DevicePolicy | null {
  if (typeof value !== "object" || value === null) return null;
  const policy = value as Record<string, unknown>;
  const minutes = policy.autoLockMinutes;
  if (typeof policy.requirePassword !== "boolean") return null;
  if (minutes !== null && (typeof minutes !== "number" || !(minutes > 0))) return null;
  return { requirePassword: policy.requirePassword, autoLockMinutes: minutes };
}

function isChannelMessage(value: unknown): value is KeyChannelMessage {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Record<string, unknown>;
  if (typeof message.userId !== "string") return false;
  switch (message.type) {
    case "request":
    case "lock":
      return true;
    case "blob":
      return typeof message.blob === "string";
    case "heartbeat":
      return typeof message.at === "number";
    default:
      return false;
  }
}

function browserChannel(): KeyChannel | null {
  if (typeof BroadcastChannel === "undefined") return null;
  const channel = new BroadcastChannel("radium-keys");
  return {
    post(message) {
      channel.postMessage(message);
    },
    subscribe(handler) {
      const listener = (event: MessageEvent) => {
        if (isChannelMessage(event.data)) handler(event.data);
      };
      channel.addEventListener("message", listener);
      return () => channel.removeEventListener("message", listener);
    },
  };
}

function createBrowserKeyManager(): KeyManager {
  const tabBlobs = webStorage(() => sessionStorage, TAB_BLOB_PREFIX);
  const policies = webStorage(() => localStorage, POLICY_PREFIX);
  const manager = createKeyManager({
    devices: indexedDbDeviceStore(),
    tabBlobs: {
      get: (userId) => {
        const blob = tabBlobs.get(userId);
        return typeof blob === "string" ? blob : null;
      },
      set: tabBlobs.set,
      delete: tabBlobs.delete,
    },
    policies: {
      get: (userId) => parsePolicy(policies.get(userId)),
      set: policies.set,
      delete: policies.delete,
    },
    channel: browserChannel(),
    now: () => Date.now(),
    handOffTimeoutMs: 400,
  });

  // Any input counts as activity for auto-lock; the idle check runs every 15 seconds.
  const onActivity = () => void manager.noteActivity();
  for (const event of ["pointerdown", "keydown", "wheel", "touchstart"]) {
    window.addEventListener(event, onActivity, { passive: true });
  }
  setInterval(() => void manager.checkIdle(), 15_000);
  return manager;
}

let browserManager: KeyManager | null = null;

const SIGNED_OUT: KeyStatus = { state: "signed-out" };

function browser(): KeyManager | null {
  if (typeof window === "undefined" || typeof indexedDB === "undefined") return null;
  browserManager ??= createBrowserKeyManager();
  return browserManager;
}

/**
 * The browser's key manager singleton. On the server (SSR) it reports `signed-out`, and every
 * operation that needs keys fails with {@link KeysLockedError}.
 */
export const keyManager: KeyManager = {
  getSnapshot: () => browser()?.getSnapshot() ?? SIGNED_OUT,
  subscribe: (listener) => browser()?.subscribe(listener) ?? (() => {}),
  attachSession: async (user, hasKeys) => browser()?.attachSession(user, hasKeys),
  unlock: async (input) => {
    const manager = browser();
    if (!manager) throw new KeysLockedError();
    return manager.unlock(input);
  },
  lock: async () => browser()?.lock(),
  forget: async (userId) => browser()?.forget(userId),
  useAmk: async (fn) => {
    const manager = browser();
    if (!manager) throw new KeysLockedError();
    return manager.useAmk(fn);
  },
  getDevicePolicy: (userId) => browser()?.getDevicePolicy(userId) ?? DEFAULT_POLICY,
  setDevicePolicy: async (userId, policy) => browser()?.setDevicePolicy(userId, policy),
  noteActivity: async () => browser()?.noteActivity(),
  checkIdle: async () => browser()?.checkIdle(),
  dispose: () => browser()?.dispose(),
};

/** Device-level default for the sign-in checkbox (no user id, not secret). */
const REQUIRE_PASSWORD_DEFAULT_KEY = "radium.keys.require-password.v1";

/** The last "Require my password to read past chats" choice made on this device. */
export function getRequirePasswordDefault(): boolean {
  try {
    return localStorage.getItem(REQUIRE_PASSWORD_DEFAULT_KEY) === "true";
  } catch {
    return false;
  }
}

export function setRequirePasswordDefault(requirePassword: boolean) {
  try {
    localStorage.setItem(REQUIRE_PASSWORD_DEFAULT_KEY, String(requirePassword));
  } catch {
    // Not remembered.
  }
}
