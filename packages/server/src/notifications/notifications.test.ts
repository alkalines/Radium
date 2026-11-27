import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { importJWK, jwtVerify } from "jose";
import { fromBase64Url, generateEncryptionKeyPair, openBox, toBase64Url } from "radium-crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { notificationAad } from "contracts/notifications/contract";
import { createTestRuntime, type TestRuntime } from "../../test/runtime";
import { classicUser } from "../../test/users";
import { chats } from "../chatroom/schema";
import { e2eeIdentities } from "../e2ee/schema";
import { recordLimitEvent } from "../gateway/limits/events";
import { resolveLimitSettings } from "../gateway/limits/meters";
import { workspaceCredentials } from "../gateway/schema";
import { jobs } from "../jobs/schema";
import { appRouter } from "../trpc/router";
import { workspaceMembers, workspaces } from "../workspaces/schema";
import { pruneNotifications } from "./inbox";
import { FALLBACK_JOB, notify, SEAL_JOB } from "./notify";
import { isAllowedPushEndpoint, runFallbackJob } from "./push";
import { notifications, pushSubscriptions } from "./schema";
import { runSealJob } from "./sealing";

// Notifications against real Postgres and Valkey: every procedure is the caller's own (recipient
// isolation), the behavior of the Convex `notifications.test.ts`, sealing to the recipient's
// identity, Web Push delivered to a local HTTPS push service and decrypted there, and the
// invariants Convex got from serialized mutations (one claim, claim vs push fallback, endpoint
// dedupe, the per-user device cap, preference merges).

type Role = "owner" | "member" | "outsider";

let test: TestRuntime;
const users = {} as Record<Role, { id: string; headers: Headers }>;
let workspace = "";
let chat = "";
let vapid: { publicKey: string; privateKey: string };

const db = () => test.runtime.drivers.db;
const call = (role: Role) => appRouter.createCaller({ runtime: test.runtime, headers: users[role].headers });
const anonymous = () => appRouter.createCaller({ runtime: test.runtime, headers: new Headers() });

/** A local push service over HTTPS: every request is recorded, the path picks the status. */
type PushRequest = { path: string; headers: Headers; body: Uint8Array };
const pushed: PushRequest[] = [];
let pushServer: ReturnType<typeof Bun.serve>;
let pushOrigin = "";
let certDir = "";

async function generateVapid() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  return { publicKey: toBase64Url(publicKey), privateKey: jwk.d! };
}

/** A browser's push subscription: its ECDH key pair and auth secret. */
async function browserKeys() {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ]);
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return { pair, p256dh: toBase64Url(publicKey), auth: toBase64Url(auth), publicKey, authBytes: auth };
}

async function hmac(key: Uint8Array, data: Uint8Array) {
  const imported = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", imported, Uint8Array.from(data)));
}

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
};
const text = (value: string) => new TextEncoder().encode(value);

/** RFC 8291 decryption, as the browser does it: proves the payload reaches the device intact. */
async function decryptPush(keys: Awaited<ReturnType<typeof browserKeys>>, body: Uint8Array) {
  const salt = body.slice(0, 16);
  const idLength = body[20]!;
  const serverPublic = body.slice(21, 21 + idLength);
  const ciphertext = body.slice(21 + idLength);
  const serverKey = await crypto.subtle.importKey(
    "raw",
    serverPublic,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: serverKey }, keys.pair.privateKey, 256),
  );
  const prkKey = await hmac(keys.authBytes, shared);
  const ikm = await hmac(
    prkKey,
    concat(text("WebPush: info\0"), keys.publicKey, serverPublic, new Uint8Array([1])),
  );
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, concat(text("Content-Encoding: aes128gcm\0"), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, concat(text("Content-Encoding: nonce\0"), new Uint8Array([1])))).slice(0, 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const padded = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, ciphertext));
  let end = padded.length - 1;
  while (padded[end] === 0) end -= 1;
  expect(padded[end]).toBe(2);
  return JSON.parse(new TextDecoder().decode(padded.slice(0, end)));
}

beforeAll(async () => {
  vapid = await generateVapid();
  test = await createTestRuntime({
    env: {
      WEB_PUSH_VAPID_PUBLIC_KEY: vapid.publicKey,
      WEB_PUSH_VAPID_PRIVATE_KEY: vapid.privateKey,
      WEB_PUSH_SUBJECT: "mailto:ops@example.test",
    },
  });
  for (const role of ["owner", "member", "outsider"] as const) {
    users[role] = await classicUser(test.runtime, `${role}@notifications.test`);
  }
  const [row] = await db()
    .insert(workspaces)
    .values({ ownerId: users.owner.id, name: "Team" })
    .returning();
  workspace = row!.id;
  await db().insert(workspaceMembers).values({ workspace, userId: users.member.id, role: "member" });
  const [created] = await db()
    .insert(chats)
    .values({ workspace, userId: users.member.id, scope: "workspace", title: "Refactor routing" })
    .returning({ id: chats.id });
  chat = created!.id;

  certDir = await mkdtemp(join(tmpdir(), "radium-push-"));
  const made = Bun.spawnSync([
    "openssl",
    "req",
    "-x509",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:prime256v1",
    "-nodes",
    "-keyout",
    join(certDir, "key.pem"),
    "-out",
    join(certDir, "cert.pem"),
    "-days",
    "1",
    "-subj",
    "/CN=127.0.0.1",
    "-addext",
    "subjectAltName=IP:127.0.0.1",
  ]);
  expect(made.exitCode).toBe(0);
  const cert = await readFile(join(certDir, "cert.pem"), "utf8");
  const key = await readFile(join(certDir, "key.pem"), "utf8");
  pushServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls: { cert, key },
    async fetch(request) {
      const path = new URL(request.url).pathname;
      pushed.push({ path, headers: request.headers, body: new Uint8Array(await request.arrayBuffer()) });
      const status = path.startsWith("/gone") ? 410 : path.startsWith("/fail") ? 500 : 201;
      return new Response(null, { status });
    },
  });
  pushOrigin = `https://127.0.0.1:${pushServer.port}`;
  // The real `fetch`, trusting the local service's certificate; nothing is stubbed.
  test.runtime.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) =>
    fetch(input, { ...init, tls: { ca: cert } } as RequestInit)) as typeof fetch;
});

afterAll(async () => {
  await pushServer?.stop(true);
  if (certDir) await rm(certDir, { recursive: true, force: true });
  await test?.close();
});

beforeEach(async () => {
  pushed.length = 0;
  await db().delete(notifications);
  await db().delete(pushSubscriptions);
  await db().delete(jobs);
  await db().delete(e2eeIdentities);
});

/** A session notification for the member's chat, with the ids of the jobs it queued. */
async function notifySession(kind: "session_finished" | "session_failed" = "session_finished") {
  const queued: (string | null)[] = [];
  const id = await db().transaction((tx) =>
    notify(tx, { userId: users.member.id, workspace, chat, kind }, queued),
  );
  return { id: id!, queued };
}

/** A push subscription stored for `role`, on the local push service (the allowlist is bypassed). */
async function localDevice(role: Role, path: string) {
  const keys = await browserKeys();
  const [row] = await db()
    .insert(pushSubscriptions)
    .values({
      userId: users[role].id,
      endpoint: `${pushOrigin}${path}`,
      p256dh: keys.p256dh,
      auth: keys.auth,
      label: path,
    })
    .returning({ id: pushSubscriptions.id });
  return { id: row!.id, keys };
}

const subscription = async (endpoint: string) => {
  const keys = await browserKeys();
  return { endpoint, p256dh: keys.p256dh, auth: keys.auth, label: "Firefox on Linux" };
};

async function activeIdentity(role: Role, keyId = toBase64Url(new Uint8Array(16).fill(7))) {
  const pair = await generateEncryptionKeyPair();
  await db().insert(e2eeIdentities).values({
    userId: users[role].id,
    keyId,
    suite: 1,
    encryptionPublicKey: pair.publicKey,
    signingPublicKey: new Uint8Array(32),
    secrets: new Uint8Array(1),
    selfSignature: new Uint8Array(1),
    recoveryWrapper: new Uint8Array(1),
    status: "active",
  });
  return { ...pair, keyId };
}

const readRow = async (id: string) =>
  (await db().select().from(notifications).where(eq(notifications.id, id)))[0]!;

describe("authorization", () => {
  it("every procedure but pushConfig needs a session", async () => {
    const caller = anonymous();
    const refused = { code: "UNAUTHORIZED" };
    await expect(caller.notifications.recent()).rejects.toMatchObject(refused);
    await expect(caller.notifications.claim({ notification: "x" })).rejects.toMatchObject(refused);
    await expect(caller.notifications.getPreferences()).rejects.toMatchObject(refused);
    await expect(
      caller.notifications.setPreference({ category: "finished", enabled: false, sound: false }),
    ).rejects.toMatchObject(refused);
    await expect(caller.notifications.listDevices({})).rejects.toMatchObject(refused);
    await expect(
      caller.notifications.subscribe(await subscription("https://fcm.googleapis.com/fcm/send/a")),
    ).rejects.toMatchObject(refused);
    await expect(caller.notifications.unsubscribe({ endpoint: "x" })).rejects.toMatchObject(refused);
    await expect(caller.notifications.pushConfig()).resolves.toEqual({ publicKey: vapid.publicKey });
  });

  it("only the recipient sees a notification, and exactly one of its tabs claims it", async () => {
    const { id } = await notifySession("session_failed");
    const [view] = await call("member").notifications.recent();
    expect(view).toMatchObject({
      id,
      kind: "session_failed",
      category: "failed",
      userId: users.member.id,
      title: "Session failed",
      body: "Session",
      path: `/chat/${chat}`,
      workspace,
      chat,
      sealed: null,
      legacyContent: null,
      claimed: false,
      pushed: false,
    });
    // The workspace owner and an outsider see nothing and cannot claim it.
    expect(await call("owner").notifications.recent()).toEqual([]);
    expect(await call("outsider").notifications.recent()).toEqual([]);
    expect(await call("owner").notifications.claim({ notification: id })).toBe(false);
    expect(await call("outsider").notifications.claim({ notification: id })).toBe(false);
    expect(await call("member").notifications.claim({ notification: id })).toBe(true);
    expect(await call("member").notifications.claim({ notification: id })).toBe(false);
    expect(await call("member").notifications.claim({ notification: "unknown" })).toBe(false);
  });

  it("devices are the caller's own: listed, removed and moved per user", async () => {
    const endpoint = "https://fcm.googleapis.com/fcm/send/device-1";
    const id = await call("member").notifications.subscribe(await subscription(endpoint));
    expect(await call("owner").notifications.listDevices({})).toEqual([]);
    // Another user cannot remove it, by id or by endpoint.
    await call("owner").notifications.unsubscribe({ device: id });
    await call("outsider").notifications.unsubscribe({ endpoint });
    expect(await call("member").notifications.listDevices({ endpoint })).toEqual([
      expect.objectContaining({ id, label: "Firefox on Linux", current: true, lastDeliveredAt: null }),
    ]);
    expect(await call("member").notifications.listDevices({})).toEqual([
      expect.objectContaining({ id, current: false }),
    ]);
    // The endpoint follows whoever subscribed last (a browser profile has one subscription).
    await call("owner").notifications.subscribe(await subscription(endpoint));
    expect(await call("member").notifications.listDevices({})).toEqual([]);
    expect(await call("owner").notifications.listDevices({})).toEqual([
      expect.objectContaining({ id }),
    ]);
    await call("owner").notifications.unsubscribe({ endpoint });
    expect(await call("owner").notifications.listDevices({})).toEqual([]);
  });

  it("preferences are per user", async () => {
    await call("member").notifications.setPreference({
      category: "finished",
      enabled: false,
      sound: true,
    });
    expect((await call("member").notifications.getPreferences()).finished).toEqual({
      enabled: false,
      sound: true,
    });
    expect((await call("owner").notifications.getPreferences()).finished).toEqual({
      enabled: true,
      sound: true,
    });
    await call("member").notifications.setPreference({
      category: "finished",
      enabled: true,
      sound: true,
    });
  });
});

describe("browser claim and push fallback", () => {
  it("new notifications and pushes never disclose a chat title", async () => {
    await localDevice("member", "/ok/title");
    const { id } = await notifySession();
    expect(JSON.stringify(await readRow(id))).not.toContain("Refactor routing");
    await runFallbackJob(test.runtime, { notification: id });
    expect(pushed).toHaveLength(1);
    expect(new TextDecoder().decode(pushed[0]!.body)).not.toContain("Refactor routing");

    // Historical sidecars are passed through as stored, never decoded into text.
    expect(JSON.stringify(await call("member").notifications.recent())).not.toContain(
      "Refactor routing",
    );
  });

  it("a claimed notification is never pushed", async () => {
    await localDevice("member", "/ok/claimed");
    const { id } = await notifySession();
    expect(await call("member").notifications.claim({ notification: id })).toBe(true);
    await runFallbackJob(test.runtime, { notification: id });
    expect(pushed).toEqual([]);
    const [after] = await call("member").notifications.recent();
    expect(after).toMatchObject({ claimed: true, pushed: false });
  });

  it("an unclaimed notification goes to every device once, then cannot be claimed", async () => {
    const ok = await localDevice("member", "/ok/device");
    const gone = await localDevice("member", "/gone/device");
    const failing = await localDevice("member", "/fail/device");
    const other = await localDevice("owner", "/ok/owner");
    const { id, queued } = await notifySession("session_failed");
    const [fallback] = await db().select().from(jobs).where(eq(jobs.kind, FALLBACK_JOB));
    expect(queued).toContain(fallback!.id);
    expect(fallback!.runAt.getTime()).toBeGreaterThan(Date.now() + 8_000);

    await runFallbackJob(test.runtime, { notification: id });
    await runFallbackJob(test.runtime, { notification: id });
    expect(pushed.map((request) => request.path).sort()).toEqual([
      "/fail/device",
      "/gone/device",
      "/ok/device",
    ]);

    const request = pushed.find((entry) => entry.path === "/ok/device")!;
    expect(request.headers.get("content-encoding")).toBe("aes128gcm");
    expect(request.headers.get("ttl")).toBe("3600");
    expect(request.headers.get("urgency")).toBe("high");
    // RFC 8292: a JWT for the push service's origin, signed by the VAPID key it names.
    const [, token, key] = /^vapid t=([^,]+), k=(.+)$/.exec(request.headers.get("authorization")!)!;
    expect(key).toBe(vapid.publicKey);
    const point = fromBase64Url(vapid.publicKey);
    const verifier = await importJWK(
      { kty: "EC", crv: "P-256", x: toBase64Url(point.slice(1, 33)), y: toBase64Url(point.slice(33)) },
      "ES256",
    );
    const { payload } = await jwtVerify(token!, verifier, { audience: pushOrigin });
    expect(payload.sub).toBe("mailto:ops@example.test");
    // The device decrypts routing metadata and generic text, nothing else.
    expect(await decryptPush(ok.keys, request.body)).toEqual({
      id,
      kind: "session_failed",
      category: "failed",
      userId: users.member.id,
      title: "Session failed",
      body: "Session",
      path: `/chat/${chat}`,
      workspace,
    });

    // Delivered devices are stamped, gone ones removed, failing ones kept; another user's
    // device is untouched.
    const devices = await db().select().from(pushSubscriptions);
    expect(devices.map((device) => device.id).sort()).toEqual([ok.id, failing.id, other.id].sort());
    expect(devices.find((device) => device.id === ok.id)!.lastDeliveredAt).toBeInstanceOf(Date);
    expect(devices.find((device) => device.id === failing.id)!.lastDeliveredAt).toBeNull();
    expect(devices.some((device) => device.id === gone.id)).toBe(false);
    expect(await readRow(id)).toMatchObject({
      deliveryChannel: "web_push",
      deliveryDevices: 3,
      deliveryDelivered: 1,
      seenAt: null,
    });

    const [after] = await call("member").notifications.recent();
    expect(after).toMatchObject({ pushed: true, claimed: false });
    expect(await call("member").notifications.claim({ notification: id })).toBe(false);
  });

  it("without VAPID keys or devices nothing is pushed and a late tab can still claim", async () => {
    const { id } = await notifySession();
    // No device at creation: no fallback job is queued at all.
    expect(await db().select().from(jobs).where(eq(jobs.kind, FALLBACK_JOB))).toEqual([]);
    await runFallbackJob(test.runtime, { notification: id });

    await localDevice("member", "/ok/late");
    const config = test.runtime.config;
    test.runtime.config = { ...config, WEB_PUSH_VAPID_PUBLIC_KEY: undefined, WEB_PUSH_VAPID_PRIVATE_KEY: undefined };
    try {
      await runFallbackJob(test.runtime, { notification: id });
      expect(await anonymous().notifications.pushConfig()).toEqual({ publicKey: null });
    } finally {
      test.runtime.config = config;
    }
    expect(pushed).toEqual([]);
    expect((await readRow(id)).deliveryAt).toBeNull();
    expect(await call("member").notifications.claim({ notification: id })).toBe(true);
  });

  it("stale notifications cannot be claimed", async () => {
    const { id } = await notifySession();
    await db()
      .update(notifications)
      .set({ createdAt: sql`now() - interval '6 minutes'` })
      .where(eq(notifications.id, id));
    expect(await call("member").notifications.claim({ notification: id })).toBe(false);
  });

  it("a deleted notification's jobs do nothing", async () => {
    await localDevice("member", "/ok/deleted");
    await activeIdentity("member");
    const { id } = await notifySession();
    await db().delete(notifications).where(eq(notifications.id, id));
    await runSealJob(test.runtime, { notification: id });
    await runFallbackJob(test.runtime, { notification: id });
    expect(pushed).toEqual([]);
  });
});

describe("preferences", () => {
  it("a disabled category creates nothing; others keep their defaults", async () => {
    expect(await call("member").notifications.getPreferences()).toEqual({
      finished: { enabled: true, sound: true },
      attention: { enabled: true, sound: true },
      failed: { enabled: true, sound: true },
      limits: { enabled: true, sound: false },
    });
    await call("member").preferences.setModelPinned({ model: "test/model", pinned: true });
    await call("member").notifications.setPreference({
      category: "finished",
      enabled: false,
      sound: true,
    });
    expect((await notifySession("session_finished")).id).toBeNull();
    expect(await call("member").notifications.recent()).toEqual([]);
    await notifySession("session_failed");
    expect(await call("member").notifications.recent()).toHaveLength(1);
    // Model preferences in the same row are untouched.
    expect((await call("member").preferences.get()).pinnedModels).toEqual(["test/model"]);
    await call("member").notifications.setPreference({
      category: "finished",
      enabled: true,
      sound: true,
    });
  });

  it("concurrent changes of different categories from several tabs all apply", async () => {
    const categories = ["finished", "attention", "failed", "limits"] as const;
    await Promise.all(
      categories.map((category) =>
        call("outsider").notifications.setPreference({ category, enabled: false, sound: true }),
      ),
    );
    const preferences = await call("outsider").notifications.getPreferences();
    for (const category of categories) {
      expect(preferences[category]).toEqual({ enabled: false, sound: true });
    }
  });
});

describe("limit events", () => {
  it("notify the workspace owner only, and not for archived workspaces", async () => {
    const [credential] = await db()
      .insert(workspaceCredentials)
      .values({ workspace, provider: "chatgpt", preview: {}, label: "Work account" })
      .returning();
    const meter = {
      id: "codex:secondary",
      label: "Weekly",
      scope: "credential" as const,
      unit: "percent" as const,
      used: 82,
      source: "header" as const,
      observedAt: Date.now(),
    };
    const event = {
      workspace,
      kind: "limit_low" as const,
      provider: { slug: "chatgpt", name: "ChatGPT" },
      credential: { id: credential!.id, name: "Work account" },
      meter,
      threshold: 80,
      snapshot: { meters: [meter] },
      settings: resolveLimitSettings(undefined),
      occurredAt: Date.now(),
    };
    const identity = await activeIdentity("owner");
    await db().transaction((tx) => recordLimitEvent(tx, event));
    const views = await call("owner").notifications.recent();
    expect(views).toEqual([
      expect.objectContaining({
        kind: "limit_low",
        category: "limits",
        title: "Usage limit low",
        body: "Workspace",
        path: "/gateway/limits",
        workspace,
        chat: null,
      }),
    ]);
    expect(await call("member").notifications.recent()).toEqual([]);

    // The sealed body names the credential, provider and meter, read from the limit event.
    await runSealJob(test.runtime, { notification: views[0]!.id });
    const [sealed] = await call("owner").notifications.recent();
    const plaintext = await openBox({
      seed: identity.seed,
      box: fromBase64Url(sealed!.sealed!.box),
      aad: notificationAad(users.owner.id, workspace, sealed!.id),
      pad: "short",
    });
    expect(JSON.parse(new TextDecoder().decode(plaintext))).toEqual({
      title: "Usage limit low",
      body: "Work account · ChatGPT · Weekly",
    });

    await db().update(workspaces).set({ archivedAt: new Date() }).where(eq(workspaces.id, workspace));
    try {
      await db().transaction((tx) => recordLimitEvent(tx, event));
      expect(await call("owner").notifications.recent()).toHaveLength(1);
    } finally {
      await db().update(workspaces).set({ archivedAt: null }).where(eq(workspaces.id, workspace));
    }
  });
});

describe("sealing", () => {
  it("identity-backed content is sealed to the recipient and bound to the recipient and row", async () => {
    const identity = await activeIdentity("member");
    const other = await generateEncryptionKeyPair();
    await localDevice("member", "/ok/sealed");
    const { id, queued } = await notifySession();
    const [seal] = await db().select().from(jobs).where(eq(jobs.kind, SEAL_JOB));
    expect(queued).toContain(seal!.id);
    expect(seal!.payload).toEqual({ notification: id });
    expect(JSON.stringify(await readRow(id))).not.toContain("Refactor routing");

    await runSealJob(test.runtime, { notification: id });
    const [view] = await call("member").notifications.recent();
    expect(view!.sealed!.keyId).toBe(identity.keyId);
    const box = fromBase64Url(view!.sealed!.box);
    const aad = notificationAad(users.member.id, workspace, id);
    const plaintext = await openBox({ seed: identity.seed, box, aad, pad: "short" });
    expect(JSON.parse(new TextDecoder().decode(plaintext))).toEqual({
      title: "Session finished",
      body: "Refactor routing",
    });
    await expect(openBox({ seed: other.seed, box, aad, pad: "short" })).rejects.toThrow();
    await expect(
      openBox({ seed: identity.seed, box, aad: { ...aad, parent: users.owner.id }, pad: "short" }),
    ).rejects.toThrow();
    await expect(
      openBox({ seed: identity.seed, box, aad: { ...aad, record: "another" }, pad: "short" }),
    ).rejects.toThrow();

    // Running it again (at-least-once delivery) keeps the box byte-identical.
    await runSealJob(test.runtime, { notification: id });
    expect(new Uint8Array((await readRow(id)).sealedBox!)).toEqual(box);

    // The push carries the box, not the title, within the 4 KiB push limit.
    await runFallbackJob(test.runtime, { notification: id });
    const [request] = pushed;
    expect(request!.body.byteLength).toBeLessThanOrEqual(4096);
    const device = await db().select().from(pushSubscriptions);
    expect(device).toHaveLength(1);
  });

  it("an existing native box or historical content is never replaced or shadowed", async () => {
    await activeIdentity("member");
    const native = await notifySession();
    await db()
      .update(notifications)
      .set({ sealedKeyId: "existing", sealedBox: new Uint8Array([1, 2, 3, 4]) })
      .where(eq(notifications.id, native.id));
    await runSealJob(test.runtime, { notification: native.id });
    expect(new Uint8Array((await readRow(native.id)).sealedBox!)).toEqual(new Uint8Array([1, 2, 3, 4]));

    const historic = await notifySession();
    const legacyContent = { kind: "custody" as const, keyId: "custody", epoch: 1, box: "CQgH" };
    await db()
      .update(notifications)
      .set({ legacyContent })
      .where(eq(notifications.id, historic.id));
    await runSealJob(test.runtime, { notification: historic.id });
    const kept = await readRow(historic.id);
    expect(kept.sealedBox).toBeNull();
    expect(kept.legacyContent).toEqual(legacyContent);
    // The sidecar is passed through as stored; its box is never opened here.
    const views = await call("member").notifications.recent();
    expect(views.find((view) => view.id === historic.id)).toMatchObject({
      sealed: null,
      legacyContent,
      body: "Session",
    });
  });

  it("a keyed chat or a title in a migration sidecar seals the generic body", async () => {
    const identity = await activeIdentity("member");
    const { id } = await notifySession();
    await db()
      .update(chats)
      .set({ legacyContent: { kind: "custody", keyId: "custody", epoch: 1, box: "AQ" } })
      .where(eq(chats.id, chat));
    try {
      await runSealJob(test.runtime, { notification: id });
    } finally {
      await db().update(chats).set({ legacyContent: null }).where(eq(chats.id, chat));
    }
    const row = await readRow(id);
    const plaintext = await openBox({
      seed: identity.seed,
      box: row.sealedBox!,
      aad: notificationAad(users.member.id, workspace, id),
      pad: "short",
    });
    expect(JSON.parse(new TextDecoder().decode(plaintext))).toEqual({
      title: "Session finished",
      body: "Session",
    });
  });

  it("no active recipient key keeps the generic notification", async () => {
    await activeIdentity("member");
    const { id } = await notifySession();
    await db()
      .update(e2eeIdentities)
      .set({ status: "retired", retiredAt: new Date() })
      .where(eq(e2eeIdentities.userId, users.member.id));
    await runSealJob(test.runtime, { notification: id });
    const row = await readRow(id);
    expect(row.sealedBox).toBeNull();
    expect(JSON.stringify(row)).not.toContain("Refactor routing");
    // Without an identity at creation, the job still runs (it rings the tabs) and seals nothing.
    const plain = await notifySession();
    const [job] = await db()
      .select()
      .from(jobs)
      .where(and(eq(jobs.kind, SEAL_JOB), sql`${jobs.payload}->>'notification' = ${plain.id}`));
    await runSealJob(test.runtime, job!.payload);
    expect((await readRow(plain.id)).sealedBox).toBeNull();
  });

  it("a rotated identity gets the box sealed to its new key", async () => {
    await activeIdentity("member");
    const { id } = await notifySession();
    await db()
      .update(e2eeIdentities)
      .set({ status: "retired", retiredAt: new Date() })
      .where(eq(e2eeIdentities.userId, users.member.id));
    const rotated = await activeIdentity("member", toBase64Url(new Uint8Array(16).fill(9)));
    await runSealJob(test.runtime, { notification: id });
    const row = await readRow(id);
    expect(row.sealedKeyId).toBe(rotated.keyId);
    await expect(
      openBox({
        seed: rotated.seed,
        box: row.sealedBox!,
        aad: notificationAad(users.member.id, workspace, id),
        pad: "short",
      }),
    ).resolves.toBeInstanceOf(Uint8Array);
  });
});

describe("push subscriptions", () => {
  it("only known push services and well-formed keys are accepted", async () => {
    for (const endpoint of [
      "http://fcm.googleapis.com/fcm/send/x",
      "https://127.0.0.1/push",
      "https://evil.example/fcm.googleapis.com",
      "https://fcm.googleapis.com.evil.example/x",
      "https://fcm.googleapis.com:8443/x",
      "https://user:pass@fcm.googleapis.com/x",
    ]) {
      expect(isAllowedPushEndpoint(endpoint)).toBe(false);
      await expect(
        call("member").notifications.subscribe(await subscription(endpoint)),
      ).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("not supported") });
    }
    const endpoint = "https://updates.push.services.mozilla.com/wpush/v2/abc";
    const valid = await subscription(endpoint);
    for (const keys of [
      { p256dh: "p", auth: valid.auth },
      { p256dh: valid.p256dh, auth: "a" },
      { p256dh: toBase64Url(new Uint8Array(65)), auth: valid.auth },
    ]) {
      await expect(
        call("member").notifications.subscribe({ ...valid, ...keys }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "Invalid push subscription." });
    }
    await call("member").notifications.subscribe({ ...valid, label: "   " });
    expect(await call("member").notifications.listDevices({})).toEqual([
      expect.objectContaining({ label: "Browser" }),
    ]);
  });

  it("parallel registrations of one endpoint keep one row", async () => {
    const endpoint = "https://fcm.googleapis.com/fcm/send/dedupe";
    const input = await subscription(endpoint);
    const ids = await Promise.all(
      Array.from({ length: 8 }, () => call("member").notifications.subscribe(input)),
    );
    expect(new Set(ids).size).toBe(1);
    expect(
      await db().select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint)),
    ).toHaveLength(1);
  });

  it("parallel registrations cannot pass the 20-device cap", async () => {
    const inputs = await Promise.all(
      Array.from({ length: 26 }, (_, index) =>
        subscription(`https://fcm.googleapis.com/fcm/send/cap-${index}`),
      ),
    );
    const results = await Promise.allSettled(
      inputs.map((input) => call("member").notifications.subscribe(input)),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(20);
    expect(
      await db().select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, users.member.id)),
    ).toHaveLength(20);
    await expect(
      call("member").notifications.subscribe(await subscription("https://fcm.googleapis.com/x")),
    ).rejects.toMatchObject({ message: expect.stringContaining("Too many devices") });
  });
});

describe("claim vs push fallback", () => {
  it("parallel claims from several tabs: exactly one wins", async () => {
    const { id } = await notifySession();
    const results = await Promise.all(
      Array.from({ length: 10 }, () => call("member").notifications.claim({ notification: id })),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("a claim racing the fallback: exactly one of them wins", async () => {
    await localDevice("member", "/ok/race");
    for (let round = 0; round < 8; round++) {
      pushed.length = 0;
      const { id } = await notifySession();
      const claims = Array.from({ length: 3 }, () =>
        call("member").notifications.claim({ notification: id }),
      );
      // Alternate who starts first so both orders are exercised.
      const fallback = runFallbackJob(test.runtime, { notification: id });
      const results = round % 2 === 0
        ? await Promise.all([fallback, ...claims])
        : await Promise.all([...claims, fallback]);
      const claimed = results.filter((result) => result === true).length;
      const row = await readRow(id);
      expect(claimed + (row.deliveryAt === null ? 0 : 1)).toBe(1);
      expect(pushed.length).toBe(row.deliveryAt === null ? 0 : 1);
    }
  });
});

describe("retention", () => {
  it("deletes notifications older than 7 days in bounded batches", async () => {
    const old = await notifySession();
    const older = await notifySession();
    const fresh = await notifySession();
    await db()
      .update(notifications)
      .set({ createdAt: sql`now() - interval '8 days'` })
      .where(sql`${notifications.id} in (${old.id}, ${older.id})`);
    expect(await pruneNotifications(db(), Date.now(), 1)).toBe(1);
    expect(await pruneNotifications(db(), Date.now(), 10)).toBe(1);
    expect(await pruneNotifications(db(), Date.now(), 10)).toBe(0);
    expect((await db().select().from(notifications)).map((row) => row.id)).toEqual([fresh.id]);
  });
});
