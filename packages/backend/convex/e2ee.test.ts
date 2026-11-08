/// <reference types="vite/client" />

import type { OpaqueHookContext } from "@alkalines/better-auth-opaque";
import type { GenericCtx } from "@convex-dev/better-auth";
import rateLimiterTest from "@convex-dev/rate-limiter/test";
import { convexTest } from "convex-test";
import { toBase64Url } from "radium-crypto";
import { expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { DataModel } from "./_generated/dataModel";
import schema from "./schema";
import {
  CLIENT_IP_HEADER,
  MAX_AUTH_REQUEST_BYTES,
  prepareAuthRequest,
  PROXY_CLIENT_IP_HEADER,
  PROXY_SECRET_HEADER,
} from "../src/e2ee/auth-ingress";
import { createOpaqueHooks } from "../src/e2ee/hooks";

type TestIdentity = { tokenIdentifier?: string; subject?: string };
type AuthContext = { auth: { getUserIdentity: () => Promise<TestIdentity | null> } };

const authMock = vi.hoisted(() => {
  const getAuthUser = vi.fn(async (ctx: AuthContext) => {
    const identity = await ctx.auth.getUserIdentity();
    const userId = identity?.tokenIdentifier ?? identity?.subject;
    if (!userId) return null;
    return { _id: userId, email: `${userId}@example.invalid`, name: userId };
  });
  return { getAuthUser, getAnyUserById: vi.fn(), safeGetAuthUser: getAuthUser };
});

vi.mock("./auth", () => ({ authComponent: authMock, createAuth: vi.fn() }));

const modules = import.meta.glob("./**/*.ts");

function makeTest() {
  const t = convexTest({ schema, modules });
  rateLimiterTest.register(t);
  return t;
}

type TestConvex = ReturnType<typeof makeTest>;

function asUser(t: TestConvex, userId: string) {
  return t.withIdentity({ tokenIdentifier: userId, subject: userId });
}

let fill = 0;

/** Distinct, well-formed base64url bytes; contents are irrelevant to the server. */
function b64(length: number) {
  fill += 1;
  return toBase64Url(new Uint8Array(length).fill(fill % 256));
}

function newKeys() {
  return {
    v: 1,
    kind: "new-keys",
    passwordWrapper: b64(79),
    recoveryWrapper: b64(79),
    identity: {
      keyId: b64(16),
      suite: 1,
      encryptionPublicKey: b64(1216),
      signingPublicKey: b64(32),
      secrets: b64(111),
      selfSignature: b64(64),
    },
  };
}

function rewrap(keyId: string) {
  return { v: 1, kind: "rewrap", passwordWrapper: b64(79), keyId };
}

/**
 * Drives the real hooks the way the plugin does, against a fake account record whose credential
 * version the test controls (the Better Auth component is not mounted in convex-test).
 */
function opaqueAccount(t: TestConvex, userId: string) {
  let version: string | null = null;
  // convex-test's accessors close over the test instance, so they work detached.
  const ctx = { runMutation: t.mutation, runQuery: t.query } as unknown as GenericCtx<DataModel>;
  const endpoint = {
    context: {
      internalAdapter: {
        findAccounts: async () => [
          { providerId: "opaque", userId, opaqueCredentialVersion: version },
        ],
      },
    },
  } as unknown as OpaqueHookContext;
  const hooks = createOpaqueHooks(ctx);

  /** validate → commit → switch → activate, as `replaceCredential`/sign-up run them. */
  async function register(
    flow: "sign-up" | "change-password" | "reset-password",
    next: string,
    payload: unknown,
    options: { activate?: boolean } = {},
  ) {
    await hooks.validatePayload!({ payload, flow, userId }, endpoint);
    await hooks.commitPayload!({ userId, credentialVersion: next, payload, flow }, endpoint);
    const previous = version;
    version = next;
    if (options.activate ?? true) {
      await hooks.activatePayload!(
        { userId, credentialVersion: next, previousCredentialVersion: previous, flow },
        endpoint,
      );
    }
  }

  return {
    hooks,
    endpoint,
    register,
    get version() {
      return version;
    },
    load: (flow: "sign-in" | "reset-password") =>
      hooks.loadPayload!({ userId, credentialVersion: version!, flow }, endpoint),
  };
}

async function identities(t: TestConvex, userId: string) {
  return await t.run(async (ctx) =>
    (await ctx.db.query("e2ee_identities").collect()).filter((row) => row.userId === userId),
  );
}

async function bundleVersions(t: TestConvex, userId: string) {
  return await t.run(async (ctx) =>
    (await ctx.db.query("e2ee_key_bundles").collect())
      .filter((row) => row.userId === userId)
      .map((row) => row.credentialVersion)
      .sort(),
  );
}

test("commit is idempotent per credential version and refuses a different bundle for it", async () => {
  const t = makeTest();
  const payload = newKeys();
  const commit = (body: unknown) =>
    t.mutation(internal.e2ee.commitBundle, {
      userId: "alice",
      credentialVersion: "v1",
      currentCredentialVersion: null,
      flow: "sign-up",
      payload: body,
    });

  await commit(payload);
  await commit(structuredClone(payload));
  expect(await bundleVersions(t, "alice")).toEqual(["v1"]);
  expect(await identities(t, "alice")).toHaveLength(1);

  await expect(commit({ ...payload, passwordWrapper: b64(79) })).rejects.toThrow();
  await expect(commit(newKeys())).rejects.toThrow();
  expect(await identities(t, "alice")).toHaveLength(1);
});

test("a new-keys commit cannot adopt another user's key id", async () => {
  const t = makeTest();
  const payload = newKeys();
  await opaqueAccount(t, "alice").register("sign-up", "a1", payload);

  await expect(opaqueAccount(t, "mallory").register("sign-up", "m1", payload)).rejects.toThrow();
  expect(await identities(t, "mallory")).toEqual([]);
});

test("rewrap keeps only the current identity: foreign and retired key ids are refused", async () => {
  const t = makeTest();
  const alice = opaqueAccount(t, "alice");
  const first = newKeys();
  await alice.register("sign-up", "v1", first);

  const bob = opaqueAccount(t, "bob");
  const bobKeys = newKeys();
  await bob.register("sign-up", "b1", bobKeys);
  await expect(
    alice.register("change-password", "v2", rewrap(bobKeys.identity.keyId)),
  ).rejects.toThrow();
  await expect(alice.register("change-password", "v2", rewrap(b64(16)))).rejects.toThrow();

  // Reset with new keys retires the first identity; it can no longer be kept by a rewrap.
  await alice.register("reset-password", "v2", newKeys());
  await expect(
    alice.register("change-password", "v3", rewrap(first.identity.keyId)),
  ).rejects.toThrow();
  expect(alice.version).toBe("v2");
});

test("activation deletes only the previous bundle and retires a replaced identity", async () => {
  const t = makeTest();
  const alice = opaqueAccount(t, "alice");
  const first = newKeys();
  await alice.register("sign-up", "v1", first);

  const kept = rewrap(first.identity.keyId);
  await alice.register("change-password", "v2", kept);
  expect(await bundleVersions(t, "alice")).toEqual(["v2"]);
  expect((await identities(t, "alice")).map((row) => row.status)).toEqual(["active"]);

  // A concurrent flow committed against v2 but has not switched: activation must leave it.
  await alice.hooks.commitPayload!(
    {
      userId: "alice",
      credentialVersion: "racing",
      payload: rewrap(first.identity.keyId),
      flow: "change-password",
    },
    alice.endpoint,
  );

  const replacement = newKeys();
  await alice.register("reset-password", "v3", replacement);
  expect(await bundleVersions(t, "alice")).toEqual(["racing", "v3"]);

  const rows = await identities(t, "alice");
  const byKey = new Map(rows.map((row) => [row.keyId, row]));
  expect(rows).toHaveLength(2);
  expect(byKey.get(first.identity.keyId)?.status).toBe("retired");
  expect(byKey.get(first.identity.keyId)?.retiredAt).toEqual(expect.any(Number));
  expect(byKey.get(replacement.identity.keyId)?.status).toBe("active");
});

test("loadPayload returns exactly the account's version and finishes a failed activation", async () => {
  const t = makeTest();
  const alice = opaqueAccount(t, "alice");
  const first = newKeys();
  await alice.register("sign-up", "v1", first);

  // Activation threw after the switch: v2's new identity is still pending, v1's bundle remains.
  const replacement = newKeys();
  await alice.register("reset-password", "v2", replacement, { activate: false });
  expect(await bundleVersions(t, "alice")).toEqual(["v1", "v2"]);

  const payload = await alice.load("sign-in");
  expect(payload).toEqual({
    v: 1,
    passwordWrapper: replacement.passwordWrapper,
    identity: replacement.identity,
  });

  const byKey = new Map((await identities(t, "alice")).map((row) => [row.keyId, row.status]));
  expect(byKey.get(replacement.identity.keyId)).toBe("active");
  expect(byKey.get(first.identity.keyId)).toBe("retired");
});

test("reset verify returns the current identity with its recovery wrapper", async () => {
  const t = makeTest();
  const alice = opaqueAccount(t, "alice");
  const keys = newKeys();
  await alice.register("sign-up", "v1", keys);
  await alice.register("change-password", "v2", rewrap(keys.identity.keyId));

  expect(await alice.load("reset-password")).toEqual({
    v: 1,
    recoveryWrapper: keys.recoveryWrapper,
    identity: keys.identity,
  });
});

test("key status and recovery wrapper updates are limited to the caller's active identity", async () => {
  const t = makeTest();
  const keys = newKeys();
  await opaqueAccount(t, "alice").register("sign-up", "v1", keys);

  expect(await t.query(api.e2ee.myKeyStatus, {})).toBeNull();
  expect(await asUser(t, "bob").query(api.e2ee.myKeyStatus, {})).toEqual({ state: "none" });
  const status = await asUser(t, "alice").query(api.e2ee.myKeyStatus, {});
  expect(status).toMatchObject({ state: "ready", keyId: keys.identity.keyId });

  const wrapper = new Uint8Array(79).fill(9).buffer;
  await expect(
    asUser(t, "bob").mutation(api.e2ee.setRecoveryWrapper, {
      keyId: keys.identity.keyId,
      recoveryWrapper: wrapper,
    }),
  ).rejects.toThrow();
  await expect(
    asUser(t, "alice").mutation(api.e2ee.setRecoveryWrapper, {
      keyId: keys.identity.keyId,
      recoveryWrapper: new Uint8Array(80).buffer,
    }),
  ).rejects.toThrow();

  await asUser(t, "alice").mutation(api.e2ee.setRecoveryWrapper, {
    keyId: keys.identity.keyId,
    recoveryWrapper: wrapper,
  });
  const reset = await opaqueAccount(t, "alice").hooks.loadPayload!(
    { userId: "alice", credentialVersion: "v1", flow: "reset-password" },
    {} as OpaqueHookContext,
  );
  expect(reset).toMatchObject({ recoveryWrapper: toBase64Url(new Uint8Array(wrapper)) });
});

test("a device recovery offer is taken once and not after it expires", async () => {
  const t = makeTest();
  const sealedAmk = new Uint8Array(79).fill(3).buffer;
  const slotId = b64(32);

  await expect(t.mutation(api.e2ee.offerDeviceRecovery, { slotId, sealedAmk })).rejects.toThrow();
  await expect(
    asUser(t, "alice").mutation(api.e2ee.offerDeviceRecovery, { slotId: b64(31), sealedAmk }),
  ).rejects.toThrow();

  await asUser(t, "alice").mutation(api.e2ee.offerDeviceRecovery, { slotId, sealedAmk });
  await expect(
    asUser(t, "mallory").mutation(api.e2ee.offerDeviceRecovery, { slotId, sealedAmk }),
  ).rejects.toThrow();

  const taken = await t.mutation(api.e2ee.takeDeviceRecovery, { slotId });
  expect(new Uint8Array(taken!.sealedAmk)).toEqual(new Uint8Array(sealedAmk));
  expect(await t.mutation(api.e2ee.takeDeviceRecovery, { slotId })).toBeNull();

  const expiring = b64(32);
  await asUser(t, "alice").mutation(api.e2ee.offerDeviceRecovery, { slotId: expiring, sealedAmk });
  await t.run(async (ctx) => {
    const row = await ctx.db
      .query("e2ee_device_recovery")
      .withIndex("by_slotId", (q) => q.eq("slotId", expiring))
      .unique();
    await ctx.db.patch("e2ee_device_recovery", row!._id, { expiresAt: Date.now() - 1 });
  });
  expect(await t.mutation(api.e2ee.takeDeviceRecovery, { slotId: expiring })).toBeNull();
  expect(await t.run((ctx) => ctx.db.query("e2ee_device_recovery").collect())).toEqual([]);
});

test("taking device recovery offers is rate-limited per client address", async () => {
  const t = makeTest();
  const client = t.withRequestMetadata({ ip: "203.0.113.7" });
  for (let i = 0; i < 60; i++) {
    await client.mutation(api.e2ee.takeDeviceRecovery, { slotId: b64(32) });
  }
  await expect(client.mutation(api.e2ee.takeDeviceRecovery, { slotId: b64(32) })).rejects.toThrow();
  const other = t.withRequestMetadata({ ip: "198.51.100.2" });
  expect(await other.mutation(api.e2ee.takeDeviceRecovery, { slotId: b64(32) })).toBeNull();
});

test("auth requests carry a trusted client address, a same-site origin and bounded bodies only", async () => {
  const site = "https://app.example";
  vi.stubEnv("SITE_URL", site);
  const ctx = {
    meta: { getRequestMetadata: async () => ({ ip: "203.0.113.7" }) },
  } as unknown as GenericCtx<DataModel>;

  // Better Auth's origin check skips OPAQUE endpoints, so a cross-site page could log a visitor
  // into another account; the ingress refuses such requests and ones without an Origin.
  const opaqueChallenge = (origin: string | null) =>
    prepareAuthRequest(
      ctx,
      new Request("https://site.example/api/auth/sign-in/opaque/challenge", {
        method: "POST",
        headers: origin ? { origin } : {},
        body: "{}",
      }),
    );
  expect(((await opaqueChallenge("https://evil.example")) as Response).status).toBe(403);
  expect(((await opaqueChallenge(null)) as Response).status).toBe(403);
  expect(await opaqueChallenge(site)).toBeInstanceOf(Request);

  const spoofed = await prepareAuthRequest(
    ctx,
    new Request("https://site.example/api/auth/sign-in/opaque/challenge", {
      method: "POST",
      headers: {
        [CLIENT_IP_HEADER]: "198.51.100.1",
        // Spoofable by any direct caller and forwarded unchanged by the web proxy.
        "x-forwarded-for": "198.51.100.9",
        "x-real-ip": "198.51.100.10",
        "cf-connecting-ip": "198.51.100.11",
        "content-type": "application/json",
        origin: site,
      },
      body: JSON.stringify({ email: "a@example.invalid" }),
    }),
  );
  expect(spoofed).toBeInstanceOf(Request);
  expect((spoofed as Request).headers.get(CLIENT_IP_HEADER)).toBe("203.0.113.7");
  expect(await (spoofed as Request).json()).toEqual({ email: "a@example.invalid" });

  const withoutAddress = await prepareAuthRequest(
    {
      meta: { getRequestMetadata: async () => ({ ip: null }) },
    } as unknown as GenericCtx<DataModel>,
    new Request("https://site.example/api/auth/get-session", {
      headers: { [CLIENT_IP_HEADER]: "198.51.100.1" },
    }),
  );
  expect((withoutAddress as Request).headers.get(CLIENT_IP_HEADER)).toBeNull();

  // The web app's server-side proxy names its client only with the deployment's secret.
  const proxied = (secret: string) =>
    prepareAuthRequest(
      ctx,
      new Request("https://site.example/api/auth/get-session", {
        headers: { [PROXY_SECRET_HEADER]: secret, [PROXY_CLIENT_IP_HEADER]: "192.0.2.44" },
      }),
      "proxy-secret",
    ) as Promise<Request>;
  const trusted = await proxied("proxy-secret");
  expect(trusted.headers.get(CLIENT_IP_HEADER)).toBe("192.0.2.44");
  expect(trusted.headers.get(PROXY_SECRET_HEADER)).toBeNull();
  expect(trusted.headers.get(PROXY_CLIENT_IP_HEADER)).toBeNull();
  expect((await proxied("guessed-secret")).headers.get(CLIENT_IP_HEADER)).toBe("203.0.113.7");

  const oversized = new Uint8Array(MAX_AUTH_REQUEST_BYTES + 1);
  const declared = await prepareAuthRequest(
    ctx,
    new Request("https://site.example/api/auth/sign-up/opaque/complete", {
      method: "POST",
      headers: { origin: site },
      body: oversized,
    }),
  );
  expect((declared as Response).status).toBe(413);

  const streamed = await prepareAuthRequest(
    ctx,
    new Request("https://site.example/api/auth/sign-up/opaque/complete", {
      method: "POST",
      headers: { origin: site },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(oversized);
          controller.close();
        },
      }),
      duplex: "half",
    }),
  );
  expect((streamed as Response).status).toBe(413);
  vi.unstubAllEnvs();
});
