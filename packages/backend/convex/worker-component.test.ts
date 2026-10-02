/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { afterEach, expect, test, vi } from "vitest";
import { components } from "./_generated/api";
import schema from "./schema";
import workerSchema from "../../worker-component/src/component/schema";

const modules = import.meta.glob("./**/*.ts");
const workerModules = import.meta.glob("../../worker-component/src/component/**/*.ts");
const enrollment = components.workerIdentity.enrollment;
const identities = components.workerIdentity.identities;
const tokenHash = "a".repeat(64);
const publicKey = { algorithm: "test-only", material: "public-key-fixture", thumbprint: "key-a" };

function setup() {
  const t = convexTest(schema, modules);
  t.registerComponent("workerIdentity", workerSchema, workerModules);
  return t;
}

async function create(t: ReturnType<typeof setup>, overrides = {}) {
  return await t.mutation(enrollment.createEnrollment, {
    workspaceId: "workspace-a",
    tokenHash,
    name: "Local Worker",
    capabilities: ["acp"],
    expiresAt: Date.now() + 60_000,
    ...overrides,
  });
}

function complete(t: ReturnType<typeof setup>, overrides = {}) {
  return t.mutation(enrollment.completeEnrollment, {
    workspaceId: "workspace-a",
    tokenHash,
    requestId: "enroll-1",
    publicKey,
    ...overrides,
  });
}

afterEach(() => vi.useRealTimers());

test("package mount exposes typed references and enrollment is single-use with exact retry recovery", async () => {
  const t = setup();
  await create(t);
  const identity = await complete(t);
  expect(await complete(t)).toEqual(identity);
  await expect(complete(t, { publicKey: { ...publicKey, thumbprint: "key-b" } })).rejects.toThrow(
    "ENROLLMENT_ALREADY_USED",
  );
  await expect(complete(t, { publicKey: { ...publicKey, material: "changed" } })).rejects.toThrow(
    "ENROLLMENT_ALREADY_USED",
  );
  await expect(complete(t, { requestId: "different-operation" })).rejects.toThrow(
    "ENROLLMENT_ALREADY_USED",
  );
  const workers = await t.query(identities.listWorkers, { workspaceId: "workspace-a", limit: 100 });
  expect(workers).toEqual([
    {
      workerId: identity.workerId,
      workspaceId: "workspace-a",
      name: "Local Worker",
      capabilities: ["acp"],
      status: "active",
      identityEpoch: 1,
    },
  ]);
});

test("expired unused and revoked enrollment cannot create a worker", async () => {
  vi.useFakeTimers();
  const t = setup();
  const id = await create(t);
  vi.setSystemTime(Date.now() + 60_001);
  await expect(complete(t)).rejects.toThrow("ENROLLMENT_EXPIRED");
  await t.mutation(enrollment.revokeEnrollment, { workspaceId: "workspace-a", enrollmentId: id });
  await expect(complete(t)).rejects.toThrow("ENROLLMENT_REVOKED");
  expect(await t.query(identities.listWorkers, { workspaceId: "workspace-a", limit: 100 })).toEqual(
    [],
  );
});

test("lost enrollment response remains recoverable after token expiry and cleanup", async () => {
  vi.useFakeTimers();
  const t = setup();
  const enrollmentId = await create(t);
  const identity = await complete(t);
  vi.setSystemTime(Date.now() + 60_001);
  expect(await t.mutation(enrollment.pruneEnrollments, { limit: 100 })).toBe(0);
  const args = { workspaceId: "workspace-a", enrollmentId, thumbprint: publicKey.thumbprint };
  expect(await t.query(enrollment.recoverEnrollment, args)).toEqual(identity);
  expect(await complete(t)).toEqual(identity);
  await expect(
    t.query(enrollment.recoverEnrollment, { ...args, thumbprint: "wrong-key" }),
  ).rejects.toThrow("KEY_MISMATCH");
});

test("workspace scope is enforced on registration, recovery, management and revocation", async () => {
  const t = setup();
  const enrollmentId = await create(t);
  await expect(complete(t, { workspaceId: "workspace-b" })).rejects.toThrow("ENROLLMENT_NOT_FOUND");
  await expect(
    t.mutation(enrollment.revokeEnrollment, { workspaceId: "workspace-b", enrollmentId }),
  ).rejects.toThrow("ENROLLMENT_NOT_FOUND");
  const identity = await complete(t);
  await expect(
    t.query(enrollment.recoverEnrollment, {
      workspaceId: "workspace-b",
      enrollmentId,
      thumbprint: publicKey.thumbprint,
    }),
  ).rejects.toThrow("ENROLLMENT_NOT_FOUND");
  await expect(
    t.mutation(identities.revokeWorker, {
      workspaceId: "workspace-b",
      workerId: identity.workerId,
    }),
  ).rejects.toThrow("WORKER_NOT_FOUND");
  await expect(
    t.query(identities.getWorkerMetadata, {
      workspaceId: "workspace-b",
      workerId: identity.workerId,
    }),
  ).rejects.toThrow("WORKER_NOT_FOUND");
  expect(
    await t.query(identities.getVerificationKey, {
      workspaceId: "workspace-b",
      keyId: identity.keyId,
    }),
  ).toBeNull();
  expect(await t.query(identities.listWorkers, { workspaceId: "workspace-b", limit: 100 })).toEqual(
    [],
  );
});

test("revocation advances epoch once, removes verification authority and denies recovery", async () => {
  const t = setup();
  const enrollmentId = await create(t);
  const identity = await complete(t);
  const keyArgs = { workspaceId: "workspace-a", keyId: identity.keyId };
  expect(await t.query(identities.getVerificationKey, keyArgs)).toMatchObject({
    identityEpoch: 1,
    publicKey,
  });
  const revokeArgs = { workspaceId: "workspace-a", workerId: identity.workerId };
  expect(await t.mutation(identities.revokeWorker, revokeArgs)).toBe(2);
  expect(await t.mutation(identities.revokeWorker, revokeArgs)).toBe(2);
  expect(await t.query(identities.getVerificationKey, keyArgs)).toBeNull();
  await expect(complete(t)).rejects.toThrow("WORKER_REVOKED");
  await expect(
    t.query(enrollment.recoverEnrollment, {
      workspaceId: "workspace-a",
      enrollmentId,
      thumbprint: publicKey.thumbprint,
    }),
  ).rejects.toThrow("WORKER_REVOKED");
});

test("duplicate token hashes and reuse of one machine key across enrollments are rejected", async () => {
  const t = setup();
  await create(t);
  await expect(create(t)).rejects.toThrow("TOKEN_HASH_EXISTS");
  await complete(t);
  const nextHash = "b".repeat(64);
  await create(t, { tokenHash: nextHash, workspaceId: "workspace-b" });
  await expect(complete(t, { tokenHash: nextHash, workspaceId: "workspace-b" })).rejects.toThrow(
    "KEY_ALREADY_REGISTERED",
  );
  expect(await t.query(identities.listWorkers, { workspaceId: "workspace-b", limit: 100 })).toEqual(
    [],
  );
});

test("component enrollment writes roll back with the parent transaction", async () => {
  const t = setup();
  await create(t);
  await expect(
    t.run(async (ctx) => {
      await ctx.runMutation(enrollment.completeEnrollment, {
        workspaceId: "workspace-a",
        tokenHash,
        requestId: "enroll-1",
        publicKey,
      });
      throw new Error("parent operation failed");
    }),
  ).rejects.toThrow("parent operation failed");
  expect(await t.query(identities.listWorkers, { workspaceId: "workspace-a", limit: 100 })).toEqual(
    [],
  );
  await complete(t);
});

test("cleanup and management reads enforce bounds and preserve completed receipts", async () => {
  vi.useFakeTimers();
  const t = setup();
  await expect(create(t, { tokenHash: "raw-secret" })).rejects.toThrow("INVALID_TOKEN_HASH");
  await expect(create(t, { capabilities: Array(33).fill("capability") })).rejects.toThrow(
    "INVALID_ARGUMENT",
  );
  await expect(create(t, { expiresAt: Date.now() + 3_600_001 })).rejects.toThrow("INVALID_EXPIRY");
  await create(t);
  await complete(t);
  await create(t, { tokenHash: "b".repeat(64) });
  await create(t, { tokenHash: "c".repeat(64) });
  vi.setSystemTime(Date.now() + 60_001);
  expect(await t.mutation(enrollment.pruneEnrollments, { limit: 1 })).toBe(1);
  expect(await t.mutation(enrollment.pruneEnrollments, { limit: 1 })).toBe(1);
  expect(await t.mutation(enrollment.pruneEnrollments, { limit: 1 })).toBe(0);
  await expect(t.mutation(enrollment.pruneEnrollments, { limit: 101 })).rejects.toThrow(
    "INVALID_LIMIT",
  );
  await expect(
    t.query(identities.listWorkers, { workspaceId: "workspace-a", limit: 0 }),
  ).rejects.toThrow("INVALID_LIMIT");
});
