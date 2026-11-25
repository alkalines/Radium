import { eq } from "drizzle-orm";
import { exportJWK, jwtVerify, type JWK } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestRuntime, TEST_SECRET_STORE_KEY, type TestRuntime } from "../../test/runtime";
import { classicUser } from "../../test/users";
import {
  enrollOver,
  machineCaller,
  proof,
  setupCode,
  workerAuth,
  workerIssuerEnv,
  workerProofKey,
} from "../../test/workers";
import { loadConfig } from "../config";
import { appRouter } from "../trpc/router";
import { workspaceMembers, workspaces } from "../workspaces/schema";
import { WORKER_AUDIENCE, workerIssuer } from "./auth";
import { workerEnrollments, workers } from "./schema";
import type { WorkerIdentity } from "./signing";

// Worker machine authentication over the Hono app (`/api/worker/auth/*`, contract of Convex
// `src/http/worker.ts`) and setup codes: ported Convex `workers.test.ts` and
// `worker-component.test.ts` cases, owner/member/outsider/archived boundaries of
// `workers.createEnrollment`, rate limits, and the single-use enrollment invariant.

type Role = "owner" | "member" | "outsider";

let test: TestRuntime;
let issuerPublicKey: CryptoKey;
const users = {} as Record<Role, { id: string; headers: Headers }>;
const db = () => test.runtime.drivers.db;
const call = (role: Role) =>
  appRouter.createCaller({ runtime: test.runtime, headers: users[role].headers });
const denied = { error: "WORKER_AUTH_DENIED" };

beforeAll(async () => {
  const issuer = await workerIssuerEnv();
  issuerPublicKey = issuer.publicKey;
  test = await createTestRuntime({ env: issuer.env });
  for (const role of ["owner", "member", "outsider"] as const) {
    users[role] = await classicUser(test.runtime, `auth-${role}@example.test`);
  }
});

afterAll(async () => {
  await test?.close();
});

async function newWorkspace(options: { archived?: boolean } = {}) {
  const [row] = await db()
    .insert(workspaces)
    .values({
      ownerId: users.owner.id,
      name: "Workers",
      archivedAt: options.archived ? new Date() : null,
    })
    .returning();
  await db()
    .insert(workspaceMembers)
    .values({ workspace: row!.id, userId: users.member.id, role: "member" });
  return row!.id;
}

async function enrolled(workspace?: string) {
  const space = workspace ?? (await newWorkspace());
  const bundle = await setupCode(test, users.owner.headers, space);
  const key = await workerProofKey();
  const response = await enrollOver(test, bundle, key);
  expect(response.status).toBe(200);
  return { workspace: space, bundle, key, identity: (await response.json()) as WorkerIdentity };
}

async function challenge(body: Record<string, unknown>) {
  const response = await workerAuth(test, "challenge", body);
  return { status: response.status, body: (await response.json()) as Record<string, string> };
}

async function tokenChallenge(identity: WorkerIdentity) {
  return await challenge({
    kind: "token",
    workspaceId: identity.workspaceId,
    workerId: identity.workerId,
    keyId: identity.keyId,
  });
}

describe("setup codes", () => {
  it("the owner gets a v1 code carrying the backend origin; others get NOT_FOUND", async () => {
    const workspace = await newWorkspace();
    const created = await call("owner").workers.createEnrollment({ workspace, name: " Laptop " });
    const decoded = JSON.parse(
      Buffer.from(created.code.slice("radium-worker-v1.".length), "base64url").toString(),
    );
    expect(decoded).toEqual(created.bundle);
    expect(created.bundle).toEqual({
      version: 1,
      backendUrl: "http://localhost:3100",
      enrollmentId: created.enrollmentId,
      token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      expiresAt: created.expiresAt,
    });
    const [row] = await db()
      .select()
      .from(workerEnrollments)
      .where(eq(workerEnrollments.id, created.enrollmentId));
    // Only the digest is stored, with the trimmed name.
    expect(row).toMatchObject({ name: "Laptop", state: "pending" });
    expect(row!.tokenHash).not.toContain(created.bundle.token);

    const archived = await newWorkspace({ archived: true });
    for (const [role, space] of [
      ["member", workspace],
      ["outsider", workspace],
      ["owner", archived],
    ] as const) {
      await expect(
        call(role).workers.createEnrollment({ workspace: space, name: "x" }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    await expect(
      call("owner").workers.createEnrollment({ workspace, name: "  " }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("revokeEnrollment cancels unused codes only, within the owner's workspace", async () => {
    const workspace = await newWorkspace();
    const other = await newWorkspace();
    const bundle = await setupCode(test, users.owner.headers, workspace);
    for (const [role, space] of [
      ["member", workspace],
      ["owner", other],
    ] as const) {
      await expect(
        call(role).workers.revokeEnrollment({ workspace: space, enrollmentId: bundle.enrollmentId }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    await call("owner").workers.revokeEnrollment({ workspace, enrollmentId: bundle.enrollmentId });
    expect((await enrollOver(test, bundle, await workerProofKey())).status).toBe(401);
    expect(await call("owner").workers.list({ workspace })).toEqual([]);

    const used = await enrolled(workspace);
    await expect(
      call("owner").workers.revokeEnrollment({
        workspace,
        enrollmentId: used.bundle.enrollmentId,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("setup codes are limited to 10 per minute per workspace", async () => {
    const workspace = await newWorkspace();
    for (let index = 0; index < 10; index++) {
      await call("owner").workers.createEnrollment({ workspace, name: `w${index}` });
    }
    await expect(
      call("owner").workers.createEnrollment({ workspace, name: "over" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    // Another workspace has its own budget.
    await call("owner").workers.createEnrollment({ workspace: await newWorkspace(), name: "ok" });
  });
});

describe("enrollment", () => {
  it("is single use with exact retry recovery", async () => {
    const { workspace, bundle, key, identity } = await enrolled();
    expect(identity).toEqual({
      workerId: expect.any(String),
      keyId: expect.any(String),
      workspaceId: workspace,
      identityEpoch: 1,
    });
    const [worker] = await db().select().from(workers).where(eq(workers.id, identity.workerId));
    expect(worker).toMatchObject({ name: "Box", status: "active", capabilities: [] });

    // A lost response: the same request id and key get the recorded identity again.
    const retry = await enrollOver(test, bundle, key);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual(identity);
    // Another key, or the same key under another request id, is refused.
    expect((await enrollOver(test, bundle, await workerProofKey())).status).toBe(401);
    expect((await enrollOver(test, bundle, key, "request-b")).status).toBe(401);
    expect(await call("owner").workers.list({ workspace })).toHaveLength(1);
  });

  it("one machine key cannot enroll twice", async () => {
    const { workspace, key } = await enrolled();
    const second = await setupCode(test, users.owner.headers, workspace, "Second");
    expect((await enrollOver(test, second, key)).status).toBe(401);
    const [row] = await db()
      .select()
      .from(workerEnrollments)
      .where(eq(workerEnrollments.id, second.enrollmentId));
    // The refused completion rolled back: the code is still unused.
    expect(row!.state).toBe("pending");
  });

  it("a token for one code cannot complete another code", async () => {
    const workspace = await newWorkspace();
    const first = await setupCode(test, users.owner.headers, workspace);
    const second = await setupCode(test, users.owner.headers, workspace, "Second");
    const key = await workerProofKey();
    expect(
      (await enrollOver(test, { enrollmentId: second.enrollmentId, token: first.token }, key))
        .status,
    ).toBe(401);
    expect(await call("owner").workers.list({ workspace })).toEqual([]);
  });

  it("rejects wrong keys, audiences, contexts, long-lived proofs and private keys; consumes once", async () => {
    const workspace = await newWorkspace();
    const bundle = await setupCode(test, users.owner.headers, workspace);
    const key = await workerProofKey();
    const other = await workerProofKey();
    const open = async () =>
      (
        await challenge({
          kind: "enroll",
          enrollmentId: bundle.enrollmentId,
          requestId: "request-a",
          publicKey: key.jwk,
        })
      ).body.challengeId!;
    const now = Math.floor(Date.now() / 1000);
    for (const bad of [
      async (id: string) => ({ proof: await proof(other, id), token: bundle.token }),
      async (id: string) => ({ proof: await proof(key, id, { aud: "other" }), token: bundle.token }),
      async (id: string) => ({ proof: await proof(key, "other"), token: bundle.token }),
      async (id: string) => ({ proof: await proof(key, id, { exp: now + 300 }), token: bundle.token }),
      async (id: string) => ({ proof: await proof(key, id), token: "b".repeat(43) }),
      async (id: string) => ({ proof: await proof(key, id) }),
    ]) {
      const challengeId = await open();
      const response = await workerAuth(test, "complete", { challengeId, ...(await bad(challengeId)) });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual(denied);
      expect(response.headers.get("cache-control")).toBe("no-store");
      // The failed attempt used the challenge up: a correct proof on it is refused too.
      expect(
        (
          await workerAuth(test, "complete", {
            challengeId,
            proof: await proof(key, challengeId),
            token: bundle.token,
          })
        ).status,
      ).toBe(401);
    }
    const privateJwk: JWK = await exportJWK(
      (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]))
        .privateKey,
    );
    expect(
      (
        await challenge({
          kind: "enroll",
          enrollmentId: bundle.enrollmentId,
          requestId: "request-a",
          publicKey: privateJwk,
        })
      ).status,
    ).toBe(401);
    expect(await call("owner").workers.list({ workspace })).toEqual([]);
    expect((await enrollOver(test, bundle, key)).status).toBe(200);
  });

  it("an expired unused code cannot create a Worker; a used one recovers after expiry", async () => {
    const workspace = await newWorkspace();
    const unused = await setupCode(test, users.owner.headers, workspace);
    const { bundle, key, identity } = await enrolled(workspace);
    await db()
      .update(workerEnrollments)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(workerEnrollments.workspace, workspace));
    expect((await enrollOver(test, unused, await workerProofKey())).status).toBe(401);

    const recovery = await challenge({
      kind: "recover",
      enrollmentId: bundle.enrollmentId,
      requestId: "request-a",
      publicKey: key.jwk,
    });
    const response = await workerAuth(test, "complete", {
      challengeId: recovery.body.challengeId,
      proof: await proof(key, recovery.body.challengeId!),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(identity);

    // Recovery needs the original key and no setup token.
    const wrong = await workerProofKey();
    const forged = await challenge({
      kind: "recover",
      enrollmentId: bundle.enrollmentId,
      requestId: "request-a",
      publicKey: wrong.jwk,
    });
    expect(
      (
        await workerAuth(test, "complete", {
          challengeId: forged.body.challengeId,
          proof: await proof(wrong, forged.body.challengeId!),
        })
      ).status,
    ).toBe(401);
    const withToken = await challenge({
      kind: "recover",
      enrollmentId: bundle.enrollmentId,
      requestId: "request-a",
      publicKey: key.jwk,
    });
    expect(
      (
        await workerAuth(test, "complete", {
          challengeId: withToken.body.challengeId,
          proof: await proof(key, withToken.body.challengeId!),
          token: bundle.token,
        })
      ).status,
    ).toBe(401);
  });

  it("an expired challenge cannot complete", async () => {
    const workspace = await newWorkspace();
    const bundle = await setupCode(test, users.owner.headers, workspace);
    const key = await workerProofKey();
    const opened = await challenge({
      kind: "enroll",
      enrollmentId: bundle.enrollmentId,
      requestId: "request-a",
      publicKey: key.jwk,
    });
    const stored = `worker:challenge:${opened.body.challengeId}`;
    const ttl = Number(await test.runtime.drivers.kv.send("PTTL", [stored]));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60_000);
    // Valkey drops the key when its TTL ends; deleting it stands in for the wait.
    await test.runtime.drivers.kv.send("DEL", [stored]);
    expect(
      (
        await workerAuth(test, "complete", {
          challengeId: opened.body.challengeId,
          proof: await proof(key, opened.body.challengeId!),
          token: bundle.token,
        })
      ).status,
    ).toBe(401);
  });

  it("concurrent completions of one code with different keys enroll exactly one Worker", async () => {
    const workspace = await newWorkspace();
    const bundle = await setupCode(test, users.owner.headers, workspace);
    const keys = await Promise.all(Array.from({ length: 4 }, () => workerProofKey()));
    const bodies = await Promise.all(
      keys.map(async (key, index) => {
        const opened = await challenge({
          kind: "enroll",
          enrollmentId: bundle.enrollmentId,
          requestId: `request-${index}`,
          publicKey: key.jwk,
        });
        return {
          challengeId: opened.body.challengeId,
          proof: await proof(key, opened.body.challengeId!),
          token: bundle.token,
        };
      }),
    );
    const responses = await Promise.all(bodies.map((body) => workerAuth(test, "complete", body)));
    expect(responses.map((response) => response.status).sort()).toEqual([200, 401, 401, 401]);
    expect(await call("owner").workers.list({ workspace })).toHaveLength(1);
  });

  it("concurrent retries with the same key and request id get one identity", async () => {
    const workspace = await newWorkspace();
    const bundle = await setupCode(test, users.owner.headers, workspace);
    const key = await workerProofKey();
    const responses = await Promise.all([0, 1, 2].map(() => enrollOver(test, bundle, key)));
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
    const identities = await Promise.all(responses.map((response) => response.json()));
    expect(new Set(identities.map((identity) => JSON.stringify(identity))).size).toBe(1);
    expect(await call("owner").workers.list({ workspace })).toHaveLength(1);
  });
});

describe("access tokens", () => {
  it("are ES256 for the machine audience and issuer, and authenticate worker.*", async () => {
    const { identity, key } = await enrolled();
    const opened = await tokenChallenge(identity);
    expect(opened.body.audience).toBe("http://localhost:3100");
    const response = await workerAuth(test, "complete", {
      challengeId: opened.body.challengeId,
      proof: await proof(key, opened.body.challengeId!),
    });
    expect(response.status).toBe(200);
    const { token, expiresAt } = (await response.json()) as { token: string; expiresAt: number };
    expect(expiresAt - Date.now()).toBeLessThanOrEqual(5 * 60_000);
    const { payload } = await jwtVerify(token, issuerPublicKey, {
      issuer: workerIssuer("http://localhost:3100"),
      audience: WORKER_AUDIENCE,
    });
    expect(payload).toMatchObject({
      sub: identity.workerId,
      kind: "worker",
      workspaceId: identity.workspaceId,
      keyId: identity.keyId,
      identityEpoch: 1,
    });
    const machine = appRouter.createCaller({
      runtime: test.runtime,
      headers: new Headers({ authorization: `Bearer ${token}` }),
    });
    expect(await machine.worker.current()).toMatchObject({
      workerId: identity.workerId,
      status: "active",
      identityEpoch: 1,
    });
  });

  it("revocation refuses pending token challenges, new challenges and recovery", async () => {
    const { workspace, identity, key, bundle } = await enrolled();
    const opened = await tokenChallenge(identity);
    const signed = await proof(key, opened.body.challengeId!);
    const machine = await machineCaller(test.runtime, identity);
    await call("owner").workers.revoke({ workspace, workerId: identity.workerId });
    expect(
      (await workerAuth(test, "complete", { challengeId: opened.body.challengeId, proof: signed }))
        .status,
    ).toBe(401);
    expect((await tokenChallenge(identity)).status).toBe(401);
    expect(
      (
        await challenge({
          kind: "recover",
          enrollmentId: bundle.enrollmentId,
          requestId: "request-a",
          publicKey: key.jwk,
        }).then(async (recovery) =>
          workerAuth(test, "complete", {
            challengeId: recovery.body.challengeId,
            proof: await proof(key, recovery.body.challengeId!),
          }),
        )
      ).status,
    ).toBe(401);
    await expect(machine.worker.current()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("refuses another workspace's selectors and archived workspaces", async () => {
    const { workspace, identity, key } = await enrolled();
    const other = await enrolled();
    expect((await tokenChallenge({ ...identity, workspaceId: other.workspace })).status).toBe(401);
    expect((await tokenChallenge({ ...identity, keyId: other.identity.keyId })).status).toBe(401);

    const opened = await tokenChallenge(identity);
    const signed = await proof(key, opened.body.challengeId!);
    const machine = await machineCaller(test.runtime, identity);
    await db().update(workspaces).set({ archivedAt: new Date() }).where(eq(workspaces.id, workspace));
    expect(
      (await workerAuth(test, "complete", { challengeId: opened.body.challengeId, proof: signed }))
        .status,
    ).toBe(401);
    expect((await tokenChallenge(identity)).status).toBe(401);
    await expect(machine.worker.current()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("challenges are limited to 120 per minute per workspace; invalid selectors cost nothing", async () => {
    const { identity, workspace } = await enrolled();
    const other = await enrolled();
    for (let index = 0; index < 5; index++) {
      expect((await tokenChallenge({ ...identity, keyId: "unknown" })).status).toBe(401);
    }
    // The enrollment above took one challenge of this workspace's budget.
    for (let index = 0; index < 119; index++) {
      expect((await tokenChallenge(identity)).status).toBe(200);
    }
    expect((await tokenChallenge(identity)).status).toBe(401);
    expect((await tokenChallenge(other.identity)).status).toBe(200);
    expect(workspace).not.toBe(other.workspace);
  });
});

describe("request handling", () => {
  it("refuses non-JSON, oversized and non-strict bodies alike", async () => {
    const { identity } = await enrolled();
    const valid = {
      kind: "token",
      workspaceId: identity.workspaceId,
      workerId: identity.workerId,
      keyId: identity.keyId,
    };
    const responses = await Promise.all([
      test.app.request("/api/worker/auth/challenge", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: JSON.stringify(valid),
      }),
      workerAuth(test, "challenge", { ...valid, padding: "x".repeat(9000) }),
      workerAuth(test, "challenge", { ...valid, extra: true }),
      workerAuth(test, "complete", { challengeId: "x", proof: "y", extra: true }),
      test.app.request("/api/worker/auth/challenge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{broken",
      }),
    ]);
    for (const response of responses) {
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual(denied);
    }
  });

  it("without the private issuer key, sign-in and setup codes are refused", async () => {
    const issuer = await workerIssuerEnv();
    const bare = await createTestRuntime({ env: { WORKER_AUTH_JWKS: issuer.env.WORKER_AUTH_JWKS } });
    try {
      const owner = await classicUser(bare.runtime, "bare-owner@example.test");
      const [row] = await bare.runtime.drivers.db
        .insert(workspaces)
        .values({ ownerId: owner.id, name: "Bare" })
        .returning();
      await expect(
        appRouter
          .createCaller({ runtime: bare.runtime, headers: owner.headers })
          .workers.createEnrollment({ workspace: row!.id, name: "Box" }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      const response = await workerAuth(bare, "challenge", {
        kind: "token",
        workspaceId: row!.id,
        workerId: "w",
        keyId: "k",
      });
      expect(response.status).toBe(401);
    } finally {
      await bare.close();
    }
  });

  it("issuer misconfiguration fails at startup without echoing the value", async () => {
    const issuer = await workerIssuerEnv();
    const base = {
      SITE_URL: "http://localhost:3000",
      API_URL: "http://localhost:3100",
      DATABASE_URL: "postgres://x",
      VALKEY_URL: "redis://x",
      BETTER_AUTH_SECRET: "secret",
      OPAQUE_SERVER_SETUP: "setup",
      SECRET_STORE_KEYS: `1:${TEST_SECRET_STORE_KEY}`,
      FILES_DIR: "/tmp",
      WORKER_AUTH_JWKS: issuer.env.WORKER_AUTH_JWKS,
    };
    const marker = "private-config-marker";
    expect(() => loadConfig({ ...base, WORKER_AUTH_PRIVATE_JWK: `${marker}{broken` })).toThrow(
      /WORKER_AUTH_PRIVATE_JWK/,
    );
    try {
      loadConfig({ ...base, WORKER_AUTH_PRIVATE_JWK: `${marker}{broken` });
    } catch (error) {
      expect(String(error)).not.toContain(marker);
    }
    const wrongKid = JSON.stringify({ ...JSON.parse(issuer.env.WORKER_AUTH_PRIVATE_JWK), kid: "other" });
    expect(() => loadConfig({ ...base, WORKER_AUTH_PRIVATE_JWK: wrongKid })).toThrow(
      /no public key with the same kid/,
    );
    const otherKey = (await workerIssuerEnv()).env.WORKER_AUTH_PRIVATE_JWK;
    expect(() => loadConfig({ ...base, WORKER_AUTH_PRIVATE_JWK: otherKey })).toThrow(
      /no public key with the same kid/,
    );
    expect(loadConfig({ ...base, WORKER_AUTH_PRIVATE_JWK: issuer.env.WORKER_AUTH_PRIVATE_JWK }))
      .toHaveProperty("WORKER_AUTH_PRIVATE_JWK.kid", "issuer-1");
  });
});
