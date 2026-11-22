import { and, eq } from "drizzle-orm";
import {
  AMK_WRAPPER_BYTES,
  ENCRYPTION_PUBLIC_KEY_BYTES,
  IDENTITY_SECRETS_BYTES,
  KEY_ID_BYTES,
  SIGNATURE_BYTES,
  SIGNING_PUBLIC_KEY_BYTES,
  SUITE_1,
  toBase64Url,
} from "radium-crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestRuntime, type TestRuntime } from "../../test/runtime";
import { user } from "../auth/schema";
import { activateBundle, commitBundle } from "./keys";
import { e2eeIdentities, e2eeKeyBundles } from "./schema";

// Invariants Convex kept by serializing mutations: one active identity per user, one bundle per
// credential version, idempotent retries, key ids that cannot be adopted by another user.

const random = (length: number) => toBase64Url(crypto.getRandomValues(new Uint8Array(length)));

function newKeys() {
  return {
    v: 1,
    kind: "new-keys",
    passwordWrapper: random(AMK_WRAPPER_BYTES),
    recoveryWrapper: random(AMK_WRAPPER_BYTES),
    identity: {
      keyId: random(KEY_ID_BYTES),
      suite: SUITE_1,
      encryptionPublicKey: random(ENCRYPTION_PUBLIC_KEY_BYTES),
      signingPublicKey: random(SIGNING_PUBLIC_KEY_BYTES),
      secrets: random(IDENTITY_SECRETS_BYTES),
      selfSignature: random(SIGNATURE_BYTES),
    },
  };
}

let test: TestRuntime;

async function newUser() {
  const id = crypto.randomUUID();
  const now = new Date();
  await test.runtime.drivers.db
    .insert(user)
    .values({ id, name: "user", email: `${id}@example.test`, createdAt: now, updatedAt: now });
  return id;
}

async function statuses(userId: string) {
  const rows = await test.runtime.drivers.db
    .select({ keyId: e2eeIdentities.keyId, status: e2eeIdentities.status })
    .from(e2eeIdentities)
    .where(eq(e2eeIdentities.userId, userId));
  return rows;
}

beforeAll(async () => {
  test = await createTestRuntime();
});

afterAll(async () => {
  await test?.close();
});

describe("account key bundles", () => {
  it("treats a repeated commit as a no-op and a different one for the same version as an error", async () => {
    const { db } = test.runtime.drivers;
    const userId = await newUser();
    const payload = newKeys();
    const commit = {
      userId,
      credentialVersion: "v1",
      currentCredentialVersion: null,
      flow: "sign-up" as const,
    };

    await Promise.all([
      commitBundle(db, { ...commit, payload }),
      commitBundle(db, { ...commit, payload }),
    ]);
    expect(await statuses(userId)).toEqual([{ keyId: payload.identity.keyId, status: "pending" }]);

    await expect(commitBundle(db, { ...commit, payload: newKeys() })).rejects.toThrow(
      /different key bundle/,
    );
  });

  it("never lets another user adopt an existing key id", async () => {
    const { db } = test.runtime.drivers;
    const payload = newKeys();
    const commit = {
      credentialVersion: "v1",
      currentCredentialVersion: null,
      flow: "sign-up" as const,
      payload,
    };
    await commitBundle(db, { ...commit, userId: await newUser() });
    await expect(commitBundle(db, { ...commit, userId: await newUser() })).rejects.toThrow(
      /Key id already in use/,
    );
  });

  it("leaves exactly one active identity when two credential switches activate at once", async () => {
    const { db } = test.runtime.drivers;
    const userId = await newUser();
    const first = newKeys();
    const second = newKeys();
    const commit = { userId, currentCredentialVersion: null, flow: "reset-password" as const };
    await commitBundle(db, { ...commit, credentialVersion: "a", payload: first });
    await commitBundle(db, { ...commit, credentialVersion: "b", payload: second });

    await Promise.all([
      activateBundle(db, { userId, credentialVersion: "a", previousCredentialVersion: null }),
      activateBundle(db, { userId, credentialVersion: "b", previousCredentialVersion: null }),
    ]);

    const active = (await statuses(userId)).filter((identity) => identity.status === "active");
    expect(active).toHaveLength(1);
  });

  it("retires the replaced identity and deletes only the previous version's bundle", async () => {
    const { db } = test.runtime.drivers;
    const userId = await newUser();
    const original = newKeys();
    const replacement = newKeys();
    await commitBundle(db, {
      userId,
      credentialVersion: "v1",
      currentCredentialVersion: null,
      flow: "sign-up",
      payload: original,
    });
    await activateBundle(db, { userId, credentialVersion: "v1", previousCredentialVersion: null });
    await commitBundle(db, {
      userId,
      credentialVersion: "v2",
      currentCredentialVersion: "v1",
      flow: "reset-password",
      payload: replacement,
    });
    await activateBundle(db, { userId, credentialVersion: "v2", previousCredentialVersion: "v1" });

    expect((await statuses(userId)).toSorted((a, b) => a.status.localeCompare(b.status))).toEqual([
      { keyId: replacement.identity.keyId, status: "active" },
      { keyId: original.identity.keyId, status: "retired" },
    ]);
    const bundles = await db
      .select({ version: e2eeKeyBundles.credentialVersion })
      .from(e2eeKeyBundles)
      .where(and(eq(e2eeKeyBundles.userId, userId)));
    expect(bundles).toEqual([{ version: "v2" }]);
  });

  it("rejects a rewrap that names an identity other than the current one", async () => {
    const { db } = test.runtime.drivers;
    const userId = await newUser();
    const payload = newKeys();
    await commitBundle(db, {
      userId,
      credentialVersion: "v1",
      currentCredentialVersion: null,
      flow: "sign-up",
      payload,
    });
    await activateBundle(db, { userId, credentialVersion: "v1", previousCredentialVersion: null });

    const rewrap = {
      v: 1,
      kind: "rewrap",
      passwordWrapper: random(AMK_WRAPPER_BYTES),
      keyId: random(KEY_ID_BYTES),
    };
    await expect(
      commitBundle(db, {
        userId,
        credentialVersion: "v2",
        currentCredentialVersion: "v1",
        flow: "change-password",
        payload: rewrap,
      }),
    ).rejects.toThrow(/not the account's current identity/);
  });
});
