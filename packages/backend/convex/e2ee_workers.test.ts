/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, expect, test, vi } from "vitest";
import { exportJWK, generateKeyPair } from "jose";
import {
  fingerprint,
  randomBytes,
  rosterStatement,
  sign,
  signingPublicKeyFromSeed,
  toBase64Url,
  workerKeysStatement,
} from "radium-crypto";
import { register } from "worker-component/test";
import { api, components } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import schema from "./schema";
import { normalizeWorkerKey, tokenDigest, workerIssuer } from "../src/worker/auth";
import { requireDispatchableWorker } from "../src/e2ee/worker-keys";

vi.mock("./auth", () => ({
  authComponent: {
    getAuthUser: async (ctx: QueryCtx) => {
      const identity = await ctx.auth.getUserIdentity();
      if (!identity || identity.kind === "worker") throw new Error("Not logged in");
      return { _id: identity.subject };
    },
  },
  createAuth: vi.fn(),
}));

const modules = import.meta.glob("./**/*.ts");
const ownerSeed = new Uint8Array(32).fill(1);
const ownerKeyId = toBase64Url(new Uint8Array(16).fill(1));
const id = () => toBase64Url(randomBytes(16));
const buffer = (bytes: Uint8Array) => bytes.slice().buffer as ArrayBuffer;

afterEach(() => {
  vi.unstubAllEnvs();
});

async function fixture(keyed = true) {
  vi.stubEnv("CONVEX_SITE_URL", "https://backend.example.invalid");
  const t = convexTest(schema, modules);
  register(t);
  const workspace = await t.run(async (ctx) => {
    const workspace = await ctx.db.insert("workspaces", {
      ownerType: "user",
      ownerId: "owner",
      name: "Workers",
      ...(keyed ? { keyEpoch: 1 } : {}),
    });
    await ctx.db.insert("e2ee_identities", {
      userId: "owner",
      keyId: ownerKeyId,
      suite: 1,
      encryptionPublicKey: new Uint8Array(1216).buffer,
      signingPublicKey: buffer(await signingPublicKeyFromSeed(ownerSeed)),
      secrets: new Uint8Array(1).buffer,
      selfSignature: new Uint8Array(64).buffer,
      recoveryWrapper: new Uint8Array(1).buffer,
      status: "active",
      createdAt: Date.now(),
    });
    return workspace;
  });

  const tokenHash = await tokenDigest("worker".padEnd(43, "_"));
  const pair = await generateKeyPair("ES256", { extractable: true });
  const publicKey = await normalizeWorkerKey(await exportJWK(pair.publicKey));
  await t.run((ctx) =>
    ctx.runMutation(components.workerIdentity.enrollment.createEnrollment, {
      workspaceId: workspace,
      name: "worker",
      tokenHash,
      expiresAt: Date.now() + 60_000,
      capabilities: [],
    }),
  );
  const identity = await t.run((ctx) =>
    ctx.runMutation(components.workerIdentity.enrollment.completeEnrollment, {
      workspaceId: workspace,
      tokenHash,
      requestId: tokenHash,
      publicKey,
    }),
  );
  const machine = t.withIdentity({
    ...identity,
    subject: identity.workerId,
    kind: "worker",
    issuer: workerIssuer("https://backend.example.invalid"),
  });
  return {
    t,
    workspace,
    workerId: identity.workerId,
    machine,
    owner: t.withIdentity({ subject: "owner" }),
  };
}

/** A Worker key set with a valid self-signature and a pairing row bound to the Worker. */
async function workerKeys(f: Awaited<ReturnType<typeof fixture>>) {
  const pairingId = id();
  await f.t.run((ctx) =>
    ctx.db.insert("e2ee_worker_pairings", {
      workspace: f.workspace,
      pairingId,
      ownerUserId: "owner",
      workerId: f.workerId,
      sealedSecret: new Uint8Array(64).buffer,
      expiresAt: Date.now() + 60_000,
    }),
  );
  const signingSeed = randomBytes(32);
  const keys = {
    keyId: id(),
    suite: 1,
    encryptionPublicKey: randomBytes(1216),
    signingPublicKey: await signingPublicKeyFromSeed(signingSeed),
  };
  const statement = workerKeysStatement({
    workspaceId: f.workspace,
    workerId: f.workerId,
    ...keys,
  });
  return {
    keys,
    fingerprint: await fingerprint(keys),
    args: {
      pairingId,
      keyId: keys.keyId,
      suite: keys.suite,
      encryptionPublicKey: buffer(keys.encryptionPublicKey),
      signingPublicKey: buffer(keys.signingPublicKey),
      selfSignature: buffer(await sign(signingSeed, statement)),
      pairingMac: buffer(randomBytes(32)),
    },
  };
}

async function roster(
  workspace: Id<"workspaces">,
  version: number,
  workers: { workerId: string; keyId: string; fingerprint: string }[],
) {
  const body = new TextEncoder().encode(
    JSON.stringify({
      v: 2,
      workspace,
      version,
      epoch: 1,
      owner: { userId: "owner", keyId: ownerKeyId, fingerprint: "owner" },
      epochs: [],
      members: [],
      workers,
    }),
  );
  return {
    version,
    body: buffer(body),
    signature: buffer(await sign(ownerSeed, rosterStatement({ workspaceId: workspace, body }))),
    signerKeyId: ownerKeyId,
  };
}

test("publishKeys rejects a self-signature that does not cover the published keys", async () => {
  const f = await fixture();
  const { args } = await workerKeys(f);
  const forged = { ...args, encryptionPublicKey: buffer(randomBytes(1216)) };

  await expect(f.machine.mutation(api.workers.publishKeys, forged)).rejects.toThrow(
    /E2EE_KEYS_INVALID/,
  );
  await expect(
    f.machine.mutation(api.workers.publishKeys, {
      ...args,
      selfSignature: buffer(randomBytes(64)),
    }),
  ).rejects.toThrow(/E2EE_KEYS_INVALID/);
  await f.machine.mutation(api.workers.publishKeys, args);
  const rows = await f.t.run((ctx) => ctx.db.query("e2ee_worker_keys").collect());
  expect(rows.map((row) => row.keyId)).toEqual([args.keyId]);
});

test("rosters certify only an active Worker's current keyId and fingerprint", async () => {
  const f = await fixture();
  const { args, fingerprint: listedFingerprint } = await workerKeys(f);
  await f.machine.mutation(api.workers.publishKeys, args);
  const entry = { workerId: f.workerId, keyId: args.keyId, fingerprint: listedFingerprint };

  for (const bad of [
    { ...entry, keyId: id() },
    { ...entry, fingerprint: "0000 0000 0000 0000 0000 0000 0000 0000" },
  ]) {
    await expect(
      f.owner.mutation(api.e2ee.publishRoster, {
        workspace: f.workspace,
        roster: await roster(f.workspace, 1, [bad]),
      }),
    ).rejects.toThrow(/E2EE_KEYS_INVALID/);
  }

  await f.owner.mutation(api.e2ee.publishRoster, {
    workspace: f.workspace,
    roster: await roster(f.workspace, 1, [entry]),
  });
  const certified = await f.t.run((ctx) => requireDispatchableWorker(ctx, f.workspace, f.workerId));
  expect(certified?.keyId).toBe(args.keyId);

  await f.owner.mutation(api.workers.revoke, { workspace: f.workspace, workerId: f.workerId });
  await expect(
    f.owner.mutation(api.e2ee.publishRoster, {
      workspace: f.workspace,
      roster: await roster(f.workspace, 2, [entry]),
    }),
  ).rejects.toThrow(/E2EE_KEYS_INVALID/);
  // Revocation takes effect before the owner publishes a roster without the Worker.
  await expect(
    f.t.run((ctx) => requireDispatchableWorker(ctx, f.workspace, f.workerId)),
  ).rejects.toThrow(/WORKER_NOT_PAIRED/);
});

test("dispatch refuses an uncertified Worker in a keyed workspace and is legacy in a keyless one", async () => {
  const keyed = await fixture();
  const { args } = await workerKeys(keyed);
  await keyed.machine.mutation(api.workers.publishKeys, args);
  await expect(
    keyed.t.run((ctx) => requireDispatchableWorker(ctx, keyed.workspace, keyed.workerId)),
  ).rejects.toThrow(/WORKER_NOT_PAIRED/);

  const keyless = await fixture(false);
  expect(
    await keyless.t.run((ctx) =>
      requireDispatchableWorker(ctx, keyless.workspace, keyless.workerId),
    ),
  ).toBeNull();
});
