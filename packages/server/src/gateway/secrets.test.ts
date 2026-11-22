import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// The envelope code of the `convex-secret-store` component the Convex backend runs today.
import {
  decryptSecret as componentDecrypt,
  encryptSecret as componentEncrypt,
  importKey as componentImportKey,
} from "../../../backend/node_modules/convex-secret-store/src/component/crypto";
import { createTestRuntime, TEST_SECRET_STORE_KEY, type TestRuntime } from "../../test/runtime";
import { loadConfig } from "../config";
import { secretEvents, secrets } from "./schema";
import {
  getSecret,
  openSecret,
  parseSecretStoreKeys,
  putSecret,
  removeSecret,
  SecretKeyring,
  sealSecret,
} from "./secrets";

let test: TestRuntime;
const db = () => test.runtime.drivers.db;
const keyring = () => test.runtime.secrets;

beforeAll(async () => {
  test = await createTestRuntime();
});

afterAll(async () => {
  await test?.close();
});

describe("Secret Store envelope", () => {
  it("decrypts a row the convex-secret-store component encrypted, and vice versa", async () => {
    const location = { namespace: "workspace:w1:provider:openai", name: "c1" };
    const kek = await componentImportKey(TEST_SECRET_STORE_KEY);
    const imported = await componentEncrypt({
      value: '{"API_KEY":"sk-imported"}',
      namespace: location.namespace,
      name: location.name,
      keyVersion: 1,
      kek,
    });
    // The row exactly as the importer copies it.
    await db()
      .insert(secrets)
      .values({ ...location, ...imported, keyVersion: 1, updatedAt: new Date() });
    expect(await getSecret(db(), keyring(), location)).toMatchObject({
      ok: true,
      value: '{"API_KEY":"sk-imported"}',
    });

    const ours = await sealSecret(keyring(), location, "written-here");
    expect(
      await componentDecrypt({ ...ours, namespace: location.namespace, name: location.name, kek }),
    ).toBe("written-here");

    // The default namespace is JSON `null` in the AAD, as the component's `undefined` was.
    const unnamed = await componentEncrypt({
      value: "default-namespace",
      namespace: undefined,
      name: "n",
      keyVersion: 1,
      kek,
    });
    expect(
      await openSecret(keyring(), { namespace: null, name: "n" }, { ...unnamed, keyVersion: 1 }),
    ).toBe("default-namespace");
  });

  it("binds the ciphertext to its namespace, name and key version", async () => {
    const sealed = await sealSecret(keyring(), { namespace: "a", name: "x" }, "value");
    for (const location of [
      { namespace: "b", name: "x" },
      { namespace: "a", name: "y" },
      { namespace: null, name: "x" },
    ]) {
      await expect(openSecret(keyring(), location, sealed)).rejects.toThrow(
        "A stored secret could not be decrypted.",
      );
    }
    const rotated = new SecretKeyring([
      { version: 1, value: TEST_SECRET_STORE_KEY },
      { version: 2, value: Buffer.alloc(32, 9).toString("base64") },
    ]);
    await expect(
      openSecret(rotated, { namespace: "a", name: "x" }, { ...sealed, keyVersion: 2 }),
    ).rejects.toThrow();
    // A keyring with a newer version still opens version-1 rows and wraps new ones under 2.
    expect(await openSecret(rotated, { namespace: "a", name: "x" }, sealed)).toBe("value");
    expect((await sealSecret(rotated, { namespace: "a", name: "x" }, "v")).keyVersion).toBe(2);
  });

  it("upserts by place with an audit trail, reports unusable rows, and deletes", async () => {
    const location = { namespace: "workspace:w2:provider:openai", name: "c2" };
    expect(await putSecret(db(), keyring(), location, "one", { preview: "****one" })).toMatchObject(
      { created: true },
    );
    expect(await putSecret(db(), keyring(), location, "two")).toMatchObject({ created: false });
    // Omitted metadata is kept on overwrite.
    expect(await getSecret(db(), keyring(), location)).toMatchObject({
      ok: true,
      value: "two",
      metadata: { preview: "****one" },
    });

    const unconfigured = new SecretKeyring([{ version: 7, value: TEST_SECRET_STORE_KEY }]);
    expect(await getSecret(db(), unconfigured, location)).toEqual({
      ok: false,
      reason: "key_unavailable",
    });
    await db()
      .update(secrets)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(and(eq(secrets.namespace, location.namespace), eq(secrets.name, location.name)));
    expect(await getSecret(db(), keyring(), location)).toEqual({ ok: false, reason: "expired" });

    expect(await removeSecret(db(), location)).toBe(true);
    expect(await removeSecret(db(), location)).toBe(false);
    expect(await getSecret(db(), keyring(), location)).toEqual({ ok: false, reason: "not_found" });

    // Events never hold values and outlive the secret.
    const events = await db()
      .select()
      .from(secretEvents)
      .where(and(eq(secretEvents.namespace, location.namespace), eq(secretEvents.name, location.name)))
      .orderBy(secretEvents.createdAt, secretEvents.id);
    expect(events.map((event) => [event.type, event.secret])).toEqual([
      ["created", null],
      ["updated", null],
      ["deleted", null],
    ]);
    expect(JSON.stringify(events)).not.toContain("two");
  });

  it("keeps one row per place when writers race", async () => {
    const location = { namespace: "race", name: "same" };
    await Promise.all(
      Array.from({ length: 8 }, (_, index) => putSecret(db(), keyring(), location, `v${index}`)),
    );
    const rows = await db()
      .select()
      .from(secrets)
      .where(and(eq(secrets.namespace, "race"), eq(secrets.name, "same")));
    expect(rows).toHaveLength(1);
    const events = await db().select().from(secretEvents).where(eq(secretEvents.namespace, "race"));
    expect(events.filter((event) => event.type === "created")).toHaveLength(1);
    expect(events).toHaveLength(8);
  });

  it("parses SECRET_STORE_KEYS without echoing values", () => {
    expect(parseSecretStoreKeys(` 2:${TEST_SECRET_STORE_KEY} ,1:${TEST_SECRET_STORE_KEY}`)).toEqual([
      { version: 2, value: TEST_SECRET_STORE_KEY },
      { version: 1, value: TEST_SECRET_STORE_KEY },
    ]);
    for (const raw of ["", "1", "x:abc", `1:${TEST_SECRET_STORE_KEY.slice(1)}`]) {
      expect(() => parseSecretStoreKeys(raw)).toThrow();
    }
    expect(() =>
      parseSecretStoreKeys(`1:${TEST_SECRET_STORE_KEY},1:${TEST_SECRET_STORE_KEY}`),
    ).toThrow("key versions must be unique");
    try {
      loadConfig({ SECRET_STORE_KEYS: "1:not-a-real-key-value" });
    } catch (error) {
      expect((error as Error).message).toContain("SECRET_STORE_KEYS");
      expect((error as Error).message).not.toContain("not-a-real-key-value");
    }
  });
});
