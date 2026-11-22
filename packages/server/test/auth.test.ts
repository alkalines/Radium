import { opaqueClient } from "@alkalines/better-auth-opaque/client";
import { createAuthClient } from "better-auth/client";
import { eq } from "drizzle-orm";
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
import { e2eeIdentities, e2eeKeyBundles } from "../src/e2ee/schema";
import { createTestRuntime, TEST_SITE_URL, type TestRuntime } from "./runtime";

// Real OPAQUE flows through the HTTP surface: the plugin's own client (serenity WASM, the same
// Argon2id profile the web app pins) talking to the Hono app, which stores into Postgres and
// Valkey. The key bundle is random bytes of the right sizes: the server only checks shapes.

const random = (length: number) => toBase64Url(crypto.getRandomValues(new Uint8Array(length)));

function newKeysPayload() {
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

/** Better Auth client routed into the app in process; remembers the session cookie it gets. */
function authClient(origin = TEST_SITE_URL) {
  const jar = { cookie: "" };
  const client = createAuthClient({
    baseURL: TEST_SITE_URL,
    plugins: [
      opaqueClient({
        keyStretching: { registration: ["rfc-recommended"], login: ["rfc-recommended"] },
      }),
    ],
    fetchOptions: {
      customFetchImpl: async (input, init) => {
        const request =
          input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);
        request.headers.set("origin", origin);
        if (jar.cookie) {
          request.headers.set("cookie", jar.cookie);
        }
        const response = await test.app.fetch(request);
        const session = response.headers
          .getSetCookie()
          .find((cookie) => cookie.startsWith("better-auth.session_token="));
        if (session) {
          jar.cookie = session.split(";")[0]!;
        }
        return response;
      },
    },
  });
  return { client, jar };
}

async function me(cookie: string) {
  const response = await test.app.request("/api/trpc/auth.me", { headers: { cookie } });
  return {
    status: response.status,
    body: (await response.json()) as { result?: { data: { email: string } } },
  };
}

beforeAll(async () => {
  test = await createTestRuntime();
});

afterAll(async () => {
  await test?.close();
});

describe("OPAQUE sign-up and sign-in", () => {
  const email = "ada@example.test";
  const password = "correct horse battery staple";
  const payload = newKeysPayload();
  let userId: string;

  it("signs up with a key bundle and stores it as the active identity", async () => {
    const { client, jar } = authClient();
    const result = await client.signUp.opaque({ email, password, name: "Ada", payload });
    expect(result.error).toBeNull();
    userId = result.data!.user.id;

    const { db } = test.runtime.drivers;
    const identities = await db
      .select()
      .from(e2eeIdentities)
      .where(eq(e2eeIdentities.userId, userId));
    expect(identities).toHaveLength(1);
    expect(identities[0]!.status).toBe("active");
    expect(identities[0]!.keyId).toBe(payload.identity.keyId);
    const bundles = await db.select().from(e2eeKeyBundles).where(eq(e2eeKeyBundles.userId, userId));
    expect(toBase64Url(bundles[0]!.passwordWrapper)).toBe(payload.passwordWrapper);

    expect(await me(jar.cookie)).toMatchObject({
      status: 200,
      body: { result: { data: { email } } },
    });
  });

  it("signs in and returns the stored bundle", async () => {
    const { client, jar } = authClient();
    const result = await client.signIn.opaque({ email, password });
    expect(result.error).toBeNull();
    expect(result.data!.payload).toMatchObject({
      v: 1,
      passwordWrapper: payload.passwordWrapper,
      identity: { keyId: payload.identity.keyId, secrets: payload.identity.secrets },
    });
    // The recovery wrapper is only for reset verify, never for sign-in.
    expect(JSON.stringify(result.data!.payload)).not.toContain(payload.recoveryWrapper);
    expect((await me(jar.cookie)).status).toBe(200);
  });

  it("refuses a wrong password", async () => {
    const { client } = authClient();
    const result = await client.signIn.opaque({ email, password: "not the password at all" });
    expect(result.error).not.toBeNull();
  });

  it("keeps the session across a backend restart and a Valkey flush", async () => {
    const { client, jar } = authClient();
    await client.signIn.opaque({ email, password });

    await test.restart();
    expect((await me(jar.cookie)).status).toBe(200);

    // Valkey is only the session cache; Postgres is the record.
    await test.runtime.drivers.kv.send("FLUSHDB", []);
    expect((await me(jar.cookie)).status).toBe(200);
  });

  it("refuses OPAQUE requests from another origin (login CSRF)", async () => {
    const { client } = authClient("https://evil.example");
    const result = await client.signIn.opaque({ email, password });
    expect(result.error?.status).toBe(403);
  });

  it("answers tRPC without a session with UNAUTHORIZED", async () => {
    expect((await me("")).status).toBe(401);
  });
});
