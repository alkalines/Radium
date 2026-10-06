/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, expect, test, vi } from "vitest";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { register } from "worker-component/test";
import rateLimiterTest from "@convex-dev/rate-limiter/test";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { handleWorkerAuth } from "../src/http/worker";
import { normalizeWorkerKey, PROOF_TYPE, tokenDigest, workerIssuer } from "../src/worker/auth";
import type { ActionCtx } from "./_generated/server";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupWorker, createMachineTokenFetcher } from "../../worker/src/auth";
import { readWorkerState } from "../../worker/src/state";

vi.mock("./auth", () => ({
  authComponent: {
    getAuthUser: async (ctx: ActionCtx) => {
      const user = await ctx.auth.getUserIdentity();
      if (!user || user.kind === "worker") throw new Error("Not logged in");
      return { _id: user.subject };
    },
  },
  createAuth: vi.fn(),
}));
const modules = import.meta.glob("./**/*.ts");
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

async function setup() {
  // The real Worker client persists a key in temporary state during roundtrip
  // coverage; force its protected-file test backend, never a desktop keyring.
  vi.stubEnv("RADIUM_WORKER_CREDENTIAL_STORE", "file");
  const t = convexTest(schema, modules);
  register(t);
  rateLimiterTest.register(t);
  const workspace = await t.run((ctx) =>
    ctx.db.insert("workspaces", { ownerType: "user", ownerId: "owner", name: "Test" }),
  );
  const pair = await generateKeyPair("ES256", { extractable: true });
  const jwk = await exportJWK(pair.publicKey);
  vi.stubEnv("CONVEX_SITE_URL", "https://backend.example.invalid");
  vi.stubEnv("CONVEX_CLOUD_URL", "https://convex.example.invalid");
  vi.stubEnv(
    "WORKER_AUTH_PRIVATE_JWK",
    JSON.stringify({ ...(await exportJWK(pair.privateKey)), kid: "test" }),
  );
  vi.stubEnv("WORKER_AUTH_JWKS", JSON.stringify({ keys: [{ ...jwk, kid: "test", alg: "ES256" }] }));
  const owner = t.withIdentity({ subject: "owner" });
  const setup = await owner.action(api.workers.createEnrollment, {
    workspace,
    name: "Test Worker",
  });
  const bundle = JSON.parse(
    atob(setup.code.split(".")[1]!.replaceAll("-", "+").replaceAll("_", "/")),
  );
  return { t, owner, workspace, pair, jwk, bundle };
}

async function http(
  t: Awaited<ReturnType<typeof setup>>["t"],
  operation: "challenge" | "complete",
  body: unknown,
) {
  return await handleWorkerAuth(
    {
      runQuery: t.query.bind(t),
      runMutation: t.mutation.bind(t),
    } as unknown as ActionCtx,
    new Request(`https://backend.example.invalid/api/worker/auth/${operation}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    operation,
  );
}

async function signed(
  pair: Awaited<ReturnType<typeof setup>>["pair"],
  challengeId: string,
  overrides = {},
) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    challengeId,
    aud: "https://backend.example.invalid",
    iat: now,
    exp: now + 60,
    ...overrides,
  })
    .setProtectedHeader({ alg: "ES256", typ: PROOF_TYPE })
    .sign(pair.privateKey);
}

async function enroll(f: Awaited<ReturnType<typeof setup>>) {
  const challenge = await (
    await http(f.t, "challenge", {
      kind: "enroll",
      enrollmentId: f.bundle.enrollmentId,
      requestId: "request-a",
      publicKey: f.jwk,
    })
  ).json();
  const body = {
    challengeId: challenge.challengeId,
    proof: await signed(f.pair, challenge.challengeId),
    token: f.bundle.token,
  };
  const response = await http(f.t, "complete", body);
  expect(response.status).toBe(200);
  return { identity: await response.json(), body };
}

test("owner-issued code contains separate origins; members and unauthenticated callers cannot manage identities", async () => {
  const f = await setup();
  expect(f.bundle.backendUrl).toBe("https://backend.example.invalid");
  expect(f.bundle.convexUrl).toBe("https://convex.example.invalid");
  await f.t.run((ctx) =>
    ctx.db.insert("workspace_members", {
      workspace: f.workspace,
      userId: "member",
      role: "member",
    }),
  );
  const member = f.t.withIdentity({ subject: "member" });
  await expect(
    member.action(api.workers.createEnrollment, { workspace: f.workspace, name: "No" }),
  ).rejects.toThrow();
  await expect(member.query(api.workers.list, { workspace: f.workspace })).rejects.toThrow();
  await expect(
    f.t.action(api.workers.createEnrollment, { workspace: f.workspace, name: "No" }),
  ).rejects.toThrow();
  const { identity } = await enroll(f);
  await expect(
    member.mutation(api.workers.revoke, { workspace: f.workspace, workerId: identity.workerId }),
  ).rejects.toThrow();
  const stored = await f.t.run((ctx) => ctx.db.query("worker_enrollments").first());
  expect(JSON.stringify(stored)).not.toContain(f.bundle.token);
});

test("HTTP proofs reject wrong key/audience/context, consume once, and recover after setup expiry without token", async () => {
  const f = await setup();
  const challenge = await (
    await http(f.t, "challenge", {
      kind: "enroll",
      enrollmentId: f.bundle.enrollmentId,
      requestId: "request-a",
      publicKey: f.jwk,
    })
  ).json();
  const base = { challengeId: challenge.challengeId, token: f.bundle.token };
  const other = await generateKeyPair("ES256");
  for (const proof of [
    await signed(other, challenge.challengeId),
    await signed(f.pair, challenge.challengeId, { aud: "other" }),
    await signed(f.pair, "other"),
  ]) {
    expect((await http(f.t, "complete", { ...base, proof })).status).toBe(401);
  }
  const { identity, body } = await enroll(f);
  expect((await http(f.t, "complete", body)).status).toBe(401);
  vi.useFakeTimers();
  vi.setSystemTime(Date.now() + 11 * 60_000);
  const recovery = await (
    await http(f.t, "challenge", {
      kind: "recover",
      enrollmentId: f.bundle.enrollmentId,
      requestId: "request-a",
      publicKey: f.jwk,
    })
  ).json();
  const response = await http(f.t, "complete", {
    challengeId: recovery.challengeId,
    proof: await signed(f.pair, recovery.challengeId),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(identity);
});

test("selector mismatch rolls enrollment consumption back; expired proofs and revoked keys cannot authenticate", async () => {
  const f = await setup();
  const second = await f.owner.action(api.workers.createEnrollment, {
    workspace: f.workspace,
    name: "Second",
  });
  const challenge = await f.t.mutation(internal.workers.createChallenge, {
    kind: "enroll",
    enrollmentId: second.enrollmentId,
    requestId: "request-a",
    publicKey: await normalizeWorkerKey(f.jwk),
  });
  await expect(
    f.t.mutation(internal.workers.admitProof, {
      challengeId: challenge.challengeId,
      tokenHash: await tokenDigest(f.bundle.token),
    }),
  ).rejects.toThrow();
  expect(await f.owner.query(api.workers.list, { workspace: f.workspace })).toEqual([]);
  const { identity } = await enroll(f);
  const tokenChallenge = await (
    await http(f.t, "challenge", {
      kind: "token",
      workspaceId: identity.workspaceId,
      workerId: identity.workerId,
      keyId: identity.keyId,
    })
  ).json();
  const tokenProof = await signed(f.pair, tokenChallenge.challengeId);
  await f.owner.mutation(api.workers.revoke, {
    workspace: f.workspace,
    workerId: identity.workerId,
  });
  expect(
    (await http(f.t, "complete", { challengeId: tokenChallenge.challengeId, proof: tokenProof }))
      .status,
  ).toBe(401);
});

test("current machine subscription derives scope and rejects stale epoch, human auth, foreign keys and archive", async () => {
  const f = await setup();
  const { identity } = await enroll(f);
  const claims = {
    issuer: workerIssuer(f.bundle.backendUrl),
    subject: identity.workerId,
    kind: "worker",
    workspaceId: identity.workspaceId,
    keyId: identity.keyId,
    identityEpoch: identity.identityEpoch,
  };
  const machine = f.t.withIdentity(claims);
  expect((await machine.query(api.workers.current, {}))?.workerId).toBe(identity.workerId);
  await expect(f.owner.query(api.workers.current, {})).rejects.toThrow();
  await expect(
    f.t.withIdentity({ ...claims, identityEpoch: 99 }).query(api.workers.current, {}),
  ).rejects.toThrow();
  await f.t.run((ctx) => ctx.db.patch(f.workspace, { archivedAt: Date.now() }));
  await expect(machine.query(api.workers.current, {})).rejects.toThrow();
});

test("JWT issuance uses machine audience/issuer and challenge expiry is authoritative", async () => {
  const f = await setup();
  const { identity } = await enroll(f);
  const tokenChallenge = await (
    await http(f.t, "challenge", {
      kind: "token",
      workspaceId: identity.workspaceId,
      workerId: identity.workerId,
      keyId: identity.keyId,
    })
  ).json();
  const proof = await signed(f.pair, tokenChallenge.challengeId);
  const response = await http(f.t, "complete", { challengeId: tokenChallenge.challengeId, proof });
  expect(response.status).toBe(200);
  const { token } = await response.json();
  const { jwtVerify } = await import("jose");
  const { payload } = await jwtVerify(token, f.pair.publicKey, {
    issuer: workerIssuer(f.bundle.backendUrl),
    audience: "radium-worker",
  });
  expect(payload.sub).toBe(identity.workerId);
  expect(payload.kind).toBe("worker");
  const expiring = await f.t.mutation(internal.workers.createChallenge, {
    kind: "token",
    workspaceId: identity.workspaceId,
    workerId: identity.workerId,
    keyId: identity.keyId,
  });
  vi.useFakeTimers();
  vi.setSystemTime(Date.now() + 60_001);
  await expect(
    f.t.mutation(internal.workers.admitProof, { challengeId: expiring.challengeId }),
  ).rejects.toThrow();
  expect(await f.t.mutation(internal.workers.pruneChallenges, {})).toBeGreaterThan(0);
});

test("bad tokens and long-lived proofs cannot enroll; revoked/expired codes and private keys are denied", async () => {
  const f = await setup();
  const challenge = await (
    await http(f.t, "challenge", {
      kind: "enroll",
      enrollmentId: f.bundle.enrollmentId,
      requestId: "request-a",
      publicKey: f.jwk,
    })
  ).json();
  const proof = await signed(f.pair, challenge.challengeId);
  expect(
    (
      await http(f.t, "complete", {
        challengeId: challenge.challengeId,
        proof,
        token: "b".repeat(43),
      })
    ).status,
  ).toBe(401);
  const longProof = await signed(f.pair, challenge.challengeId, {
    exp: Math.floor(Date.now() / 1000) + 300,
  });
  expect(
    (
      await http(f.t, "complete", {
        challengeId: challenge.challengeId,
        proof: longProof,
        token: f.bundle.token,
      })
    ).status,
  ).toBe(401);
  expect(
    (
      await http(f.t, "challenge", {
        kind: "enroll",
        enrollmentId: f.bundle.enrollmentId,
        requestId: "request-a",
        publicKey: await exportJWK(f.pair.privateKey),
      })
    ).status,
  ).toBe(401);
  await f.owner.mutation(api.workers.revokeEnrollment, {
    workspace: f.workspace,
    enrollmentId: f.bundle.enrollmentId,
  });
  expect(
    (
      await http(f.t, "complete", {
        challengeId: challenge.challengeId,
        proof,
        token: f.bundle.token,
      })
    ).status,
  ).toBe(401);
  const fresh = await f.owner.action(api.workers.createEnrollment, {
    workspace: f.workspace,
    name: "Expired",
  });
  const bundle = JSON.parse(
    atob(fresh.code.split(".")[1]!.replaceAll("-", "+").replaceAll("_", "/")),
  );
  vi.useFakeTimers();
  vi.setSystemTime(Date.now() + 11 * 60_000);
  const expired = await (
    await http(f.t, "challenge", {
      kind: "enroll",
      enrollmentId: bundle.enrollmentId,
      requestId: "request-b",
      publicKey: f.jwk,
    })
  ).json();
  expect(
    (
      await http(f.t, "complete", {
        challengeId: expired.challengeId,
        proof: await signed(f.pair, expired.challengeId),
        token: bundle.token,
      })
    ).status,
  ).toBe(401);
  expect(await f.owner.query(api.workers.list, { workspace: f.workspace })).toEqual([]);
});

test("foreign workspace selection and issuer mismatch do not establish machine or owner authority", async () => {
  const f = await setup();
  const { identity } = await enroll(f);
  const foreign = await f.t.run((ctx) =>
    ctx.db.insert("workspaces", { ownerType: "user", ownerId: "other", name: "Foreign" }),
  );
  await expect(
    f.owner.mutation(api.workers.revoke, { workspace: foreign, workerId: identity.workerId }),
  ).rejects.toThrow();
  await expect(
    f.t.withIdentity({ subject: "other" }).mutation(api.workers.revokeEnrollment, {
      workspace: foreign,
      enrollmentId: f.bundle.enrollmentId,
    }),
  ).rejects.toThrow();
  expect(
    (
      await http(f.t, "challenge", {
        kind: "token",
        workspaceId: foreign,
        workerId: identity.workerId,
        keyId: identity.keyId,
      })
    ).status,
  ).toBe(401);
  const claims = {
    issuer: "https://other.example.invalid/api/worker",
    subject: identity.workerId,
    kind: "worker",
    workspaceId: f.workspace,
    keyId: identity.keyId,
    identityEpoch: identity.identityEpoch,
  };
  await expect(f.t.withIdentity(claims).query(api.workers.current, {})).rejects.toThrow();
  await f.owner.mutation(api.workers.revoke, {
    workspace: f.workspace,
    workerId: identity.workerId,
  });
  await expect(
    f.t
      .withIdentity({ ...claims, issuer: workerIssuer(f.bundle.backendUrl) })
      .query(api.workers.current, {}),
  ).rejects.toThrow();
});

test("issuer misconfiguration fails closed without echoing private configuration fragments", async () => {
  const f = await setup();
  vi.stubEnv("WORKER_AUTH_PRIVATE_JWK", "private-config-marker{broken-json");
  try {
    await f.owner.action(api.workers.createEnrollment, { workspace: f.workspace, name: "Denied" });
    throw new Error("Unexpected success");
  } catch (error) {
    expect(String(error)).toContain("Invalid Worker private issuer configuration");
    expect(String(error)).not.toContain("private-config-marker");
  }
  vi.stubEnv(
    "WORKER_AUTH_PRIVATE_JWK",
    JSON.stringify({ ...(await exportJWK(f.pair.privateKey)), kid: "wrong" }),
  );
  await expect(
    f.owner.action(api.workers.createEnrollment, { workspace: f.workspace, name: "Denied" }),
  ).rejects.toThrow("signing key mismatch");
});

test("the real Worker client enrolls and refreshes against app handlers with its independently generated key", async () => {
  const f = await setup();
  const directory = await mkdtemp(join(tmpdir(), "radium-worker-app-test-"));
  try {
    const stateDirectory = join(directory, "state");
    const code =
      "radium-worker-v1." +
      btoa(JSON.stringify(f.bundle)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
    const fetchImpl = async (input: string | URL, init: RequestInit) =>
      http(
        f.t,
        new URL(String(input)).pathname.endsWith("/challenge") ? "challenge" : "complete",
        JSON.parse(String(init.body)),
      );
    const identity = await setupWorker(stateDirectory, code, { fetchImpl });
    const state = await readWorkerState(stateDirectory);
    expect(state?.identity).toEqual(identity);
    const fetchToken = createMachineTokenFetcher(state!, { fetchImpl });
    const token = await fetchToken({ forceRefreshToken: true });
    const { jwtVerify } = await import("jose");
    const { payload } = await jwtVerify(token!, f.pair.publicKey, {
      issuer: workerIssuer(f.bundle.backendUrl),
      audience: "radium-worker",
    });
    expect(payload.sub).toBe(identity.workerId);
    await f.owner.mutation(api.workers.revoke, {
      workspace: f.workspace,
      workerId: identity.workerId,
    });
    expect(await fetchToken({ forceRefreshToken: true })).toBeNull();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
