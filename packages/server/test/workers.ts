import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { appRouter } from "../src/trpc/router";
import type { Runtime } from "../src/runtime";
import { workerKeys, workers } from "../src/worker/schema";
import { issueWorkerToken, PROOF_TYPE, type WorkerIdentity } from "../src/worker/signing";
import type { TestRuntime } from "./runtime";

/** Worker test fixtures: an issuer key pair, Worker proof keys and machine-auth round trips. */

/** Issuer env (`WORKER_AUTH_JWKS` + `WORKER_AUTH_PRIVATE_JWK`) for a test runtime. */
export async function workerIssuerEnv() {
  const pair = await generateKeyPair("ES256", { extractable: true });
  const publicJwk = { ...(await exportJWK(pair.publicKey)), kid: "issuer-1", alg: "ES256" };
  return {
    publicKey: pair.publicKey,
    env: {
      WORKER_AUTH_JWKS: JSON.stringify({ keys: [publicJwk] }),
      WORKER_AUTH_PRIVATE_JWK: JSON.stringify({ ...(await exportJWK(pair.privateKey)), kid: "issuer-1" }),
    },
  };
}

/** A Worker's own proof key pair and its public JWK. */
export async function workerProofKey(): Promise<{ privateKey: CryptoKey; jwk: JWK }> {
  const pair = await generateKeyPair("ES256", { extractable: true });
  return { privateKey: pair.privateKey, jwk: await exportJWK(pair.publicKey) };
}

/** A proof over `challengeId` for audience `API_URL`, as the Worker signs it. */
export async function proof(
  key: { privateKey: CryptoKey },
  challengeId: string,
  overrides: Record<string, unknown> = {},
) {
  const now = Math.floor(Date.now() / 1000);
  return await new SignJWT({
    challengeId,
    aud: "http://localhost:3100",
    iat: now,
    exp: now + 60,
    ...overrides,
  })
    .setProtectedHeader({ alg: "ES256", typ: PROOF_TYPE })
    .sign(key.privateKey);
}

/** `POST /api/worker/auth/<operation>` through the Hono app. */
export async function workerAuth(
  test: TestRuntime,
  operation: "challenge" | "complete",
  body: unknown,
) {
  return await test.app.request(`/api/worker/auth/${operation}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Setup bundle of a new enrollment created by the owner through `workers.createEnrollment`. */
export async function setupCode(test: TestRuntime, owner: Headers, workspace: string, name = "Box") {
  const created = await appRouter
    .createCaller({ runtime: test.runtime, headers: owner })
    .workers.createEnrollment({ workspace, name });
  return created.bundle;
}

/** Enrolls `key` with a setup bundle over HTTP; returns the response. */
export async function enrollOver(
  test: TestRuntime,
  bundle: { enrollmentId: string; token: string },
  key: { privateKey: CryptoKey; jwk: JWK },
  requestId = "request-a",
) {
  const challenge = (await (
    await workerAuth(test, "challenge", {
      kind: "enroll",
      enrollmentId: bundle.enrollmentId,
      requestId,
      publicKey: key.jwk,
    })
  ).json()) as { challengeId: string };
  return await workerAuth(test, "complete", {
    challengeId: challenge.challengeId,
    proof: await proof(key, challenge.challengeId),
    token: bundle.token,
  });
}

/** A Worker row and proof-key row written directly, as enrollment would. */
export async function insertWorker(
  runtime: Runtime,
  workspace: string,
  values: { name?: string; status?: "active" | "revoked"; identityEpoch?: number } = {},
): Promise<WorkerIdentity> {
  const db = runtime.drivers.db;
  const [worker] = await db
    .insert(workers)
    .values({
      workspace,
      name: values.name ?? "Box",
      capabilities: [],
      status: values.status ?? "active",
      identityEpoch: values.identityEpoch ?? 1,
    })
    .returning();
  const [key] = await db
    .insert(workerKeys)
    .values({
      worker: worker!.id,
      algorithm: "ES256",
      material: "{}",
      thumbprint: crypto.randomUUID(),
    })
    .returning();
  return {
    workerId: worker!.id,
    keyId: key!.id,
    workspaceId: workspace,
    identityEpoch: worker!.identityEpoch,
  };
}

/** A tRPC caller authenticated as `identity` with a freshly issued access token. */
export async function machineCaller(runtime: Runtime, identity: WorkerIdentity) {
  const { token } = await issueWorkerToken(
    identity,
    runtime.config.WORKER_AUTH_PRIVATE_JWK!,
    runtime.config.API_URL,
  );
  return appRouter.createCaller({
    runtime,
    headers: new Headers({ authorization: `Bearer ${token}` }),
  });
}
