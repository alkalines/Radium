/// <reference types="vite/client" />

import { register as registerSecretStore } from "convex-secret-store/test";
import { convexTest, type TestConvex as ConvexTestHarness } from "convex-test";
import {
  AMK_WRAPPER_BYTES,
  equalBytes,
  fromBase64Url,
  generateEncryptionKeyPair,
  IDENTITY_SECRETS_BYTES,
  KEY_ID_BYTES,
  openBox,
  SIGNATURE_BYTES,
  SIGNING_PUBLIC_KEY_BYTES,
  SUITE_1,
  toBase64Url,
} from "radium-crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { legacyAad, type LegacyBox } from "contracts/e2ee/legacy-contract";
import { deleteLegacySidecar, MAX_SEAL_SOURCE_BYTES, newJob, readMigrationState, requestCustodyRelease } from "../src/e2ee/migration-contract";
import { notificationTitle } from "contracts/notifications/contract";

const modules = import.meta.glob("./**/*.ts");
const previousSecretStoreKeys = process.env.SECRET_STORE_KEYS;

beforeAll(() => {
  process.env.SECRET_STORE_KEYS = `1:${Buffer.alloc(32, 1).toString("base64")}`;
});

afterAll(() => {
  if (previousSecretStoreKeys === undefined) delete process.env.SECRET_STORE_KEYS;
  else process.env.SECRET_STORE_KEYS = previousSecretStoreKeys;
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const secretNotice = {
  userId: "alice",
  kind: "session_finished" as const,
  title: "Deploy the secret plan",
  body: "Rotate the vault key tonight",
  createdAt: 1,
};
const genericNotice = { title: notificationTitle("session_finished"), body: "Workspace" };
const SEAL_NOTIFICATIONS = { kind: "seal" as const, tables: ["notifications"] };
const cleanTally = { scanned: 0, changed: 0, blocked: 0, pending: 0, plaintext: 0, custody: 0 };

function makeTest() {
  const t = convexTest({ schema, modules });
  registerSecretStore(t);
  return t;
}
type TestConvex = ConvexTestHarness<typeof schema>;

async function drain(t: TestConvex) {
  await t.finishAllScheduledFunctions(vi.runAllTimers);
}

async function insertNotice(t: TestConvex, fields: Partial<typeof secretNotice> = {}) {
  return await t.run((ctx) => ctx.db.insert("notifications", { ...secretNotice, ...fields }));
}

async function readNotice(t: TestConvex, id: Id<"notifications">) {
  return await t.run((ctx) => ctx.db.get("notifications", id));
}

async function startCutover(t: TestConvex) {
  const { keyId } = await t.action(internal.e2ee_migration_node.createCustody, {});
  await t.mutation(internal.e2ee_migration.setFrozen, { frozen: true });
  return keyId;
}

/** Inserts a real job without scheduling it, so tests drive its steps directly. */
async function insertJob(t: TestConvex, fields: { kind: "seal" | "release" | "verify"; dryRun: boolean }) {
  return await t.run(async (ctx) => ctx.db.insert("e2ee_migration_jobs", newJob({
    ...fields, table: "notifications", batchSize: 10, state: await readMigrationState(ctx), now: 0,
  })));
}

async function readJob(t: TestConvex, job: Id<"e2ee_migration_jobs">) {
  return await t.run((ctx) => ctx.db.get("e2ee_migration_jobs", job));
}

describe("legacy content cutover", () => {
  test("a dry run counts work without touching rows, state, storage or custody", async () => {
    const t = makeTest();
    const id = await insertNotice(t);
    const before = await readNotice(t, id);

    await t.mutation(internal.e2ee_migration.startJobs, SEAL_NOTIFICATIONS);
    await drain(t);

    const status = await t.query(internal.e2ee_migration.status, {});
    expect(status.state).toBeNull();
    expect(status.jobs).toMatchObject([{ kind: "seal", dryRun: true, status: "completed", scanned: 1, changed: 1 }]);
    expect(await readNotice(t, id)).toEqual(before);
    expect(await t.run((ctx) => ctx.db.system.query("_storage").collect())).toEqual([]);
    expect(await t.run((ctx) => ctx.db.query("e2ee_legacy_custody").collect())).toEqual([]);
    await expect(t.query(internal.e2ee_migration.custodyPublicKey, {})).rejects.toThrow("Custody is unavailable");
  });

  test("real sealing requires custody and an explicit freeze", async () => {
    const t = makeTest();
    const real = { ...SEAL_NOTIFICATIONS, dryRun: false };
    await expect(t.mutation(internal.e2ee_migration.startJobs, real)).rejects.toThrow("not initialized");
    await t.action(internal.e2ee_migration_node.createCustody, {});
    await expect(t.mutation(internal.e2ee_migration.startJobs, real)).rejects.toThrow("explicit freeze");
    await expect(t.action(internal.e2ee_migration_node.createCustody, {})).rejects.toThrow("already");
  });

  test("sealing is recoverable, idempotent and keeps existing ciphertext byte-for-byte", async () => {
    const t = makeTest();
    const keyId = await startCutover(t);
    const plain = await insertNotice(t);
    const priorBox = new Uint8Array([7, 7, 1, 2, 3]).buffer;
    const prior = await insertNotice(t, genericNotice);
    await t.run((ctx) => ctx.db.patch("notifications", prior, {
      legacyContent: { kind: "identity", keyId: "earlier", epoch: 1, box: priorBox },
    }));

    await t.mutation(internal.e2ee_migration.startJobs, { ...SEAL_NOTIFICATIONS, dryRun: false });
    await drain(t);

    const sealed = await readNotice(t, plain);
    expect(sealed).toMatchObject({ ...genericNotice, legacyContent: { kind: "custody", keyId, epoch: 1 } });
    const seed = await t.query(internal.e2ee_migration.custodySeed, { keyId });
    const opened = await openBox({
      seed: new Uint8Array(seed),
      box: new Uint8Array(sealed!.legacyContent!.box),
      aad: legacyAad("notifications", plain),
      pad: "content",
    });
    expect(JSON.parse(new TextDecoder().decode(opened))).toEqual({ title: secretNotice.title, body: secretNotice.body });
    expect(new Uint8Array((await readNotice(t, prior))!.legacyContent!.box)).toEqual(new Uint8Array(priorBox));
    expect(await t.run((ctx) => ctx.db.query("e2ee_legacy_custody").collect()))
      .toMatchObject([{ table: "notifications", record: plain, userId: "alice" }]);

    // A second run finds nothing and rewrites no envelope.
    const firstBox = new Uint8Array(sealed!.legacyContent!.box);
    await t.mutation(internal.e2ee_migration.startJobs, { ...SEAL_NOTIFICATIONS, dryRun: false });
    await drain(t);
    const status = await t.query(internal.e2ee_migration.status, {});
    expect(status.jobs[0]).toMatchObject({ status: "completed", scanned: 2, changed: 0, conflicts: 0, blocked: 0 });
    expect(new Uint8Array((await readNotice(t, plain))!.legacyContent!.box)).toEqual(firstBox);
    expect(new Uint8Array((await readNotice(t, prior))!.legacyContent!.box)).toEqual(new Uint8Array(priorBox));
    expect(status.state?.custodyWrites).toBe(1);
  });

  test("account activation releases custody to the new identity, and repeating it rewrites nothing", async () => {
    const t = makeTest();
    const custodyKey = await startCutover(t);
    const legacy = await insertNotice(t);
    const nativeBox = new Uint8Array([5, 4, 3, 2, 1]);
    const native = await t.run((ctx) => ctx.db.insert("notifications", {
      ...secretNotice, ...genericNotice, sealed: { keyId: "native", box: nativeBox.slice().buffer },
    }));
    await t.mutation(internal.e2ee_migration.startJobs, { ...SEAL_NOTIFICATIONS, dryRun: false });
    await drain(t);
    expect((await readNotice(t, legacy))!.legacyContent).toMatchObject({ kind: "custody", keyId: custodyKey });

    // A classic account attaches keys: the real commit and activation the OPAQUE hooks run.
    const pair = await generateEncryptionKeyPair();
    const identityKeyId = toBase64Url(new Uint8Array(KEY_ID_BYTES).fill(4));
    const filled = (length: number, value: number) => toBase64Url(new Uint8Array(length).fill(value));
    await t.mutation(internal.e2ee.commitBundle, {
      userId: "alice",
      credentialVersion: "v1",
      currentCredentialVersion: null,
      flow: "attach",
      payload: {
        v: 1,
        kind: "new-keys",
        passwordWrapper: filled(AMK_WRAPPER_BYTES, 1),
        recoveryWrapper: filled(AMK_WRAPPER_BYTES, 2),
        identity: {
          keyId: identityKeyId,
          suite: SUITE_1,
          encryptionPublicKey: toBase64Url(pair.publicKey),
          signingPublicKey: filled(SIGNING_PUBLIC_KEY_BYTES, 3),
          secrets: filled(IDENTITY_SECRETS_BYTES, 5),
          selfSignature: filled(SIGNATURE_BYTES, 6),
        },
      },
    });
    // A committed but pending identity receives nothing.
    await drain(t);
    expect((await readNotice(t, legacy))!.legacyContent?.kind).toBe("custody");

    const activate = () => t.mutation(internal.e2ee.activateBundle, {
      userId: "alice", credentialVersion: "v1", previousCredentialVersion: null,
    });
    await activate();
    await drain(t);
    const released = (await readNotice(t, legacy))!;
    expect(released).toMatchObject({ ...genericNotice, legacyContent: { kind: "identity", keyId: identityKeyId, epoch: 1 } });
    expect(await t.run((ctx) => ctx.db.query("e2ee_legacy_custody").collect())).toEqual([]);
    const opened = await openBox({
      seed: pair.seed,
      box: new Uint8Array(released.legacyContent!.box),
      aad: legacyAad("notifications", legacy),
      pad: "content",
    });
    expect(JSON.parse(new TextDecoder().decode(opened))).toEqual({ title: secretNotice.title, body: secretNotice.body });

    // The load-repair path activates again: no custody remains, so no row changes.
    const nativeRow = await readNotice(t, native);
    await activate();
    await drain(t);
    expect(await readNotice(t, legacy)).toEqual(released);
    expect(await readNotice(t, native)).toEqual(nativeRow);
    expect(new Uint8Array(nativeRow!.sealed!.box)).toEqual(nativeBox);
    expect(nativeRow!.legacyContent).toBeUndefined();
    const releases = (await t.query(internal.e2ee_migration.status, {})).jobs.filter((job) => job.kind === "release");
    expect(releases).toMatchObject([{ scope: { userId: "alice" }, status: "completed", changed: 1, blocked: 0 }]);
  });

  test("a source or recipient race is a conflict that writes nothing", async () => {
    const t = makeTest();
    const keyId = await startCutover(t);
    const id = await insertNotice(t);
    const job = await insertJob(t, { kind: "seal", dryRun: false });
    const custodyBox = (key: string) => ({ kind: "custody" as const, keyId: key, epoch: 1, box: new Uint8Array([9]).buffer });
    const commit = (digest: string, run = 1, key = keyId) => t.mutation(internal.e2ee_migration.commitSeal, {
      job, run, table: "notifications", record: id, digest, sealed: custodyBox(key),
    });

    const stalePage = await t.query(internal.e2ee_migration.loadPage, { job, run: 1 });
    await t.run((ctx) => ctx.db.patch("notifications", id, { title: "Edited after the read" }));
    expect(await commit(stalePage!.seal[0].digest)).toBe("conflict");
    expect(await readNotice(t, id)).toMatchObject({ title: "Edited after the read" });
    expect((await readNotice(t, id))!.legacyContent).toBeUndefined();

    const page = await t.query(internal.e2ee_migration.loadPage, { job, run: 1 });
    const { digest } = page!.seal[0];
    expect(await commit(digest, 1, "another-custody-key")).toBe("conflict");
    expect(await commit(digest, 2)).toBe("conflict");
    expect((await readNotice(t, id))!.legacyContent).toBeUndefined();
    expect(await t.run((ctx) => ctx.db.query("e2ee_legacy_custody").collect())).toEqual([]);

    expect(await commit(digest)).toBe("committed");
    expect(await readNotice(t, id)).toMatchObject({ ...genericNotice, legacyContent: { kind: "custody", keyId } });
    expect(await commit(digest)).toBe("stale");
  });

  test("conflicts and blocked rows hold the cursor while clean pages count every row", async () => {
    const t = makeTest();
    await startCutover(t);
    const job = await insertJob(t, { kind: "seal", dryRun: false });
    const step = (fields: { cursor: string | null; conflicts?: number; tally?: Partial<typeof cleanTally>; run?: number }) =>
      t.mutation(internal.e2ee_migration.advance, {
        job,
        run: fields.run ?? 1,
        cursor: fields.cursor,
        next: "page-2",
        isDone: false,
        tally: { ...cleanTally, ...fields.tally },
        conflicts: fields.conflicts ?? 0,
        stale: [],
        issue: { record: "row", reason: "Source or recipient changed before commit." },
      });

    await step({ cursor: null, tally: { scanned: 3, changed: 1, pending: 2 } });
    expect(await readJob(t, job)).toMatchObject({ cursor: "page-2", scanned: 3, changed: 1, pending: 2, status: "running" });

    // Retried pages are rescanned later, so only committed changes and conflicts accumulate.
    const advanced = await readJob(t, job);
    await t.run((ctx) => ctx.db.patch("e2ee_migration_jobs", job, { cursor: "page-1" }));
    await step({ cursor: "page-1", conflicts: 1, tally: { scanned: 3, changed: 2 } });
    expect(await readJob(t, job)).toMatchObject({
      cursor: "page-1", scanned: advanced!.scanned, changed: 3, conflicts: 1, retries: 1, status: "running",
    });

    await step({ cursor: "another-page", tally: { scanned: 3 } });
    await step({ cursor: "page-1", run: 7, tally: { scanned: 3 } });
    expect(await readJob(t, job)).toMatchObject({ cursor: "page-1", scanned: 3, retries: 1 });

    await step({ cursor: "page-1", tally: { scanned: 3, blocked: 1 } });
    expect(await readJob(t, job)).toMatchObject({ cursor: "page-1", status: "blocked", issue: { record: "row" } });
    await step({ cursor: "page-1", tally: { scanned: 3 } });
    expect(await readJob(t, job)).toMatchObject({ cursor: "page-1", status: "blocked" });

    // Dry runs only report: a blocked row is counted and the scan continues.
    const dry = await insertJob(t, { kind: "seal", dryRun: true });
    await t.mutation(internal.e2ee_migration.advance, {
      job: dry, run: 1, cursor: null, next: "page-2", isDone: true,
      tally: { ...cleanTally, scanned: 2, blocked: 1 }, conflicts: 0, stale: [],
    });
    expect(await readJob(t, dry)).toMatchObject({ cursor: "page-2", status: "completed", scanned: 2, blocked: 1 });
  });

  test("custody inventory pages stay inside the requested account or workspace", async () => {
    const t = makeTest();
    const workspace = await t.run(async (ctx) => {
      const workspace = await ctx.db.insert("workspaces", { ownerType: "user", ownerId: "alice", name: "Inventory" });
      for (const [record, userId] of [["a1", "alice"], ["b1", "bob"], ["a2", "alice"]]) {
        await ctx.db.insert("e2ee_legacy_custody", { table: "notifications", record, userId });
      }
      await ctx.db.insert("e2ee_legacy_custody", { table: "telemetry_blobs", record: "w1", workspace });
      return workspace;
    });
    const inventory = (scope: { userId: string } | { workspace: Id<"workspaces"> }, cursor: string | null) =>
      t.query(internal.e2ee_migration.custodialRows, { scope, paginationOpts: { numItems: 1, cursor } });

    const alice: string[] = [];
    let cursor: string | null = null;
    for (;;) {
      const page = await inventory({ userId: "alice" }, cursor);
      expect(page.pageCount).toBe(page.page.length);
      expect(page.pageCount).toBeLessThanOrEqual(1);
      for (const row of page.page) {
        expect(row).toEqual({ table: "notifications", record: row.record, userId: "alice" });
        alice.push(row.record);
      }
      if (page.isDone) break;
      cursor = page.continueCursor;
    }
    expect(alice).toEqual(["a1", "a2"]);

    const shared = await inventory({ workspace }, null);
    expect(shared.page).toEqual([{ table: "telemetry_blobs", record: "w1", workspace }]);
  });

  test("conflict retries are bounded before the job blocks", async () => {
    const t = makeTest();
    await startCutover(t);
    const job = await insertJob(t, { kind: "seal", dryRun: false });
    for (let retry = 1; retry <= 4; retry += 1) {
      await t.mutation(internal.e2ee_migration.advance, {
        job, run: 1, cursor: null, next: "page-2", isDone: false, tally: cleanTally, conflicts: 1, stale: [],
      });
    }
    expect(await readJob(t, job)).toMatchObject({ status: "blocked", retries: 3, conflicts: 4 });
    expect((await readJob(t, job))!.cursor).toBeUndefined();
  });

  test("custody ends only under a current exhaustive zero proof", async () => {
    const t = makeTest();
    const keyId = await startCutover(t);
    const verify = async () => {
      await t.mutation(internal.e2ee_migration.startJobs, { kind: "verify" });
      await drain(t);
    };

    // A zero proof taken before a custody write cannot authorize ending custody afterwards.
    await verify();
    const id = await insertNotice(t);
    await t.mutation(internal.e2ee_migration.startJobs, { ...SEAL_NOTIFICATIONS, dryRun: false });
    await drain(t);
    await expect(t.mutation(internal.e2ee_migration.endCustody, {})).rejects.toThrow("custody-free proof");
    await expect(t.query(internal.e2ee_migration.custodySeed, { keyId })).resolves.toBeInstanceOf(ArrayBuffer);

    await verify();
    const cutover = await t.mutation(internal.e2ee_migration.finishCutover, {});
    expect(cutover).toMatchObject({ complete: true, plaintext: 0, custody: 1, blocked: 0 });
    expect((await t.query(internal.e2ee_migration.status, {})).state).toMatchObject({ frozen: false, cutoverComplete: true });

    // The finished cutover changed the generation; only a fresh proof counts, and it still sees custody.
    await expect(t.mutation(internal.e2ee_migration.endCustody, {})).rejects.toThrow("unverified");
    await verify();
    await expect(t.mutation(internal.e2ee_migration.endCustody, {})).rejects.toThrow("custody=1");

    // Without an audience key a release keeps custody rather than widening access.
    await t.run((ctx) => requestCustodyRelease(ctx, { userId: "alice" }));
    await drain(t);
    expect((await t.query(internal.e2ee_migration.status, {})).jobs[0]).toMatchObject({
      kind: "release", status: "completed", pending: 1, changed: 0,
    });
    expect((await readNotice(t, id))!.legacyContent?.kind).toBe("custody");

    // Removing the last custody row counts only once a completed verification proves it.
    await t.run(async (ctx) => {
      await deleteLegacySidecar(ctx, { table: "notifications", record: id });
      await ctx.db.delete("notifications", id);
    });
    await t.mutation(internal.e2ee_migration.startJobs, { kind: "verify" });
    await expect(t.mutation(internal.e2ee_migration.endCustody, {})).rejects.toThrow("custody-free proof");
    await drain(t);

    await t.mutation(internal.e2ee_migration.endCustody, {});
    expect((await t.query(internal.e2ee_migration.status, {})).state).toMatchObject({ custodyState: "ended" });
    await expect(t.query(internal.e2ee_migration.custodySeed, { keyId })).rejects.toThrow("unavailable");
    await expect(t.query(internal.e2ee_migration.custodyPublicKey, {})).rejects.toThrow("unavailable");
  });

  describe("legacy attachment sealing", () => {
    const upload = async (t: TestConvex, size: number, fill = (index: number) => (index * 31 + 7) & 255) => {
      const bytes = new Uint8Array(size);
      for (let index = 0; index < size; index += 1) bytes[index] = fill(index);
      const stored = await t.run(async (ctx) => {
        const workspace = await ctx.db.insert("workspaces", { ownerType: "user", ownerId: "alice", name: "Files" });
        const storageId = await ctx.storage.store(new Blob([bytes as Uint8Array<ArrayBuffer>]));
        const file = await ctx.db.insert("chat_files", {
          workspace, userId: "alice", storageId, url: "upload-1", mediaType: "image/png", filename: "photo.png", size,
        });
        return { file, storageId, workspace };
      });
      return { ...stored, bytes };
    };
    const jobsOf = async (t: TestConvex) => (await t.query(internal.e2ee_migration.status, {})).jobs;
    const openEnvelope = async (
      t: TestConvex, row: Id<"chat_files">, workspace: Id<"workspaces">, seed: Uint8Array,
    ) => await t.run(async (ctx) => {
      const file = await ctx.db.get("chat_files", row);
      const sealed = file!.legacyContent!;
      const stored = sealed.storageId ? await ctx.storage.get(sealed.storageId) : null;
      const box = stored ? new Uint8Array(await stored.arrayBuffer()) : new Uint8Array(sealed.box);
      const plaintext = await openBox({ seed, box, aad: legacyAad("chat_files", row, workspace), pad: "content" });
      return JSON.parse(new TextDecoder().decode(plaintext)) as { filename: string; mediaType: string; size: number; fileBytes: string };
    });

    test("dry runs and verification report missing source storage instead of clean readiness", async () => {
      const t = makeTest();
      const { file, storageId } = await upload(t, 8);
      await t.run((ctx) => ctx.storage.delete(storageId));

      await t.mutation(internal.e2ee_migration.startJobs, { kind: "seal", tables: ["chat_files"] });
      await t.mutation(internal.e2ee_migration.startJobs, { kind: "verify", tables: ["chat_files"] });
      await drain(t);

      const jobs = await jobsOf(t);
      const seal = jobs.find((job) => job.kind === "seal");
      const verify = jobs.find((job) => job.kind === "verify");
      expect(seal).toMatchObject({ status: "completed", scanned: 1, changed: 0, blocked: 1, issue: { record: file, reason: "Legacy source storage is missing." } });
      expect(verify).toMatchObject({ status: "completed", plaintext: 1, blocked: 1 });
    });

    test("dry runs report sources above the sealing bound without reading or shrinking them", async () => {
      const t = makeTest();
      const { file, storageId } = await upload(t, MAX_SEAL_SOURCE_BYTES + 1, () => 0);

      await t.mutation(internal.e2ee_migration.startJobs, { kind: "seal", tables: ["chat_files"] });
      await drain(t);

      expect((await jobsOf(t))[0]).toMatchObject({ status: "completed", changed: 0, blocked: 1, issue: { record: file } });
      expect((await jobsOf(t))[0].issue!.reason).toContain("sealing bound");
      expect(await t.run((ctx) => ctx.db.system.get("_storage", storageId))).not.toBeNull();
      expect((await t.run((ctx) => ctx.db.get("chat_files", file)))!.storageId).toBe(storageId);
    });

    test("dry runs read stored text and block invalid UTF-8 without changing its source", async () => {
      const t = makeTest();
      const previous = process.env.TELEMETRY_HASH_SECRET;
      process.env.TELEMETRY_HASH_SECRET = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
      try {
        const seeded = await t.run(async ctx => {
          const workspace = await ctx.db.insert("workspaces", { ownerType: "user", ownerId: "alice", name: "Text" });
          const storage = await ctx.storage.store(new Blob([new Uint8Array([255])]));
          const row = await ctx.db.insert("telemetry_blobs", { workspace, hash: "old-unkeyed", kind: "legacy", size: 1, storage });
          return { row, storage };
        });
        await t.mutation(internal.e2ee_migration.startJobs, { kind: "seal", tables: ["telemetry_blobs"] });
        await drain(t);
        expect((await jobsOf(t))[0]).toMatchObject({ status: "completed", changed: 0, blocked: 1, issue: { record: seeded.row } });
        const source = await t.run(ctx => ctx.db.get("telemetry_blobs", seeded.row));
        expect(source?.storage).toBe(seeded.storage);
        expect(source?.legacyContent).toBeUndefined();
        expect(await t.run(async ctx => (await ctx.storage.get(seeded.storage))?.size)).toBe(1);
      } finally {
        if (previous === undefined) delete process.env.TELEMETRY_HASH_SECRET;
        else process.env.TELEMETRY_HASH_SECRET = previous;
      }
    });

    test("a real run holds a row with missing source storage and writes nothing", async () => {
      const t = makeTest();
      await startCutover(t);
      const { file, storageId } = await upload(t, 8);
      await t.run((ctx) => ctx.storage.delete(storageId));

      await t.mutation(internal.e2ee_migration.startJobs, { kind: "seal", tables: ["chat_files"], dryRun: false });
      await drain(t);

      expect((await jobsOf(t))[0]).toMatchObject({ status: "blocked", changed: 0, issue: { record: file, reason: "Legacy source storage is missing." } });
      const row = await t.run((ctx) => ctx.db.get("chat_files", file));
      expect(row).toMatchObject({ storageId, filename: "photo.png", mediaType: "image/png" });
      expect(row!.legacyContent).toBeUndefined();
      expect(await t.run((ctx) => ctx.db.query("e2ee_legacy_custody").collect())).toEqual([]);
      expect(await t.run((ctx) => ctx.db.query("e2ee_legacy_storage").collect())).toEqual([]);
    });

    test("a replaced source or recipient race keeps the original blob and discards the uncommitted envelope", async () => {
      const t = makeTest();
      const keyId = await startCutover(t);
      const { file, storageId, workspace } = await upload(t, 1024);
      const job = await t.run(async (ctx) => ctx.db.insert("e2ee_migration_jobs", newJob({
        kind: "seal", dryRun: false, table: "chat_files", batchSize: 10, state: await readMigrationState(ctx), now: 0,
      })));
      const page = await t.query(internal.e2ee_migration.loadPage, { job, run: 1 });
      expect(page!.seal[0]).toMatchObject({ record: file, sourceSize: 1024, storage: { id: storageId, field: "fileBytes", encoding: "base64" } });

      const envelope = () => t.run(async (ctx) => ({
        kind: "custody" as const, keyId, epoch: 1, box: new ArrayBuffer(0),
        storageId: await ctx.storage.store(new Blob(["envelope"])),
      }));
      const raced = await envelope();
      await t.run(async (ctx) => {
        const other = await ctx.storage.store(new Blob(["another file"]));
        await ctx.db.patch("chat_files", file, { storageId: other });
      });
      const commit = (sealed: LegacyBox) => t.mutation(internal.e2ee_migration.commitSeal, {
        job, run: 1, table: "chat_files", record: file, digest: page!.seal[0].digest, sealed,
      });
      expect(await commit(raced)).toBe("conflict");
      await t.mutation(internal.e2ee_migration.discardSidecar, { storageId: raced.storageId });
      expect(await t.run((ctx) => ctx.db.system.get("_storage", raced.storageId))).toBeNull();
      expect(await t.run((ctx) => ctx.db.system.get("_storage", storageId))).not.toBeNull();
      expect((await t.run((ctx) => ctx.db.get("chat_files", file)))!.legacyContent).toBeUndefined();
      expect(await t.run((ctx) => ctx.db.query("e2ee_legacy_custody").collect())).toEqual([]);

      // Restored source: the same page now commits, registers its envelope, and a registered blob survives a discard.
      await t.run((ctx) => ctx.db.patch("chat_files", file, { storageId }));
      const committed = await envelope();
      expect(await commit(committed)).toBe("committed");
      await t.mutation(internal.e2ee_migration.discardSidecar, { storageId: committed.storageId });
      expect(await t.run((ctx) => ctx.db.system.get("_storage", committed.storageId))).not.toBeNull();
      expect(await t.run((ctx) => ctx.db.system.get("_storage", storageId))).toBeNull();
      expect(await t.run((ctx) => ctx.db.query("e2ee_legacy_custody").collect())).toMatchObject([{ table: "chat_files", record: file, userId: "alice", workspace }]);
    });

    test("a maximum-size legacy attachment seals to custody and releases byte-identically", async () => {
      const t = makeTest();
      const keyId = await startCutover(t);
      const { file, storageId, workspace, bytes } = await upload(t, 20 * 1024 * 1024);

      await t.mutation(internal.e2ee_migration.startJobs, { kind: "seal", tables: ["chat_files"], dryRun: false, batchSize: 1 });
      await drain(t);
      expect((await jobsOf(t))[0]).toMatchObject({ status: "completed", changed: 1, blocked: 0, conflicts: 0 });

      const row = await t.run((ctx) => ctx.db.get("chat_files", file));
      expect(row).toMatchObject({ mediaType: "application/octet-stream", size: 0, legacyContent: { kind: "custody", keyId } });
      expect(row!.storageId).toBeUndefined();
      expect(row!.filename).toBeUndefined();
      expect(row!.legacyContent!.box.byteLength).toBe(0);
      const custodyStorage = row!.legacyContent!.storageId!;
      expect(await t.run((ctx) => ctx.db.system.get("_storage", storageId))).toBeNull();

      const custodySeed = new Uint8Array(await t.query(internal.e2ee_migration.custodySeed, { keyId }));
      const sealed = await openEnvelope(t, file, workspace, custodySeed);
      expect(sealed).toMatchObject({ filename: "photo.png", mediaType: "image/png", size: bytes.length });
      expect(equalBytes(fromBase64Url(sealed.fileBytes), bytes)).toBe(true);

      // The uploader gets an identity key; releasing reseals the identical plaintext to it.
      const pair = await generateEncryptionKeyPair();
      await t.run(async (ctx) => {
        await ctx.db.insert("e2ee_identities", {
          userId: "alice", keyId: "alice-identity", suite: 1,
          encryptionPublicKey: pair.publicKey.slice().buffer, signingPublicKey: new ArrayBuffer(32),
          secrets: new ArrayBuffer(1), selfSignature: new ArrayBuffer(64), recoveryWrapper: new ArrayBuffer(1),
          status: "active", createdAt: 1,
        });
        await requestCustodyRelease(ctx, { userId: "alice" });
      });
      await drain(t);

      expect((await jobsOf(t))[0]).toMatchObject({ kind: "release", status: "completed", changed: 1, blocked: 0 });
      const released = await t.run((ctx) => ctx.db.get("chat_files", file));
      expect(released!.legacyContent).toMatchObject({ kind: "identity", keyId: "alice-identity" });
      expect(released!.legacyContent!.storageId).not.toBe(custodyStorage);
      expect(await t.run((ctx) => ctx.db.system.get("_storage", custodyStorage))).toBeNull();
      expect(await t.run((ctx) => ctx.db.query("e2ee_legacy_custody").collect())).toEqual([]);
      const reopened = await openEnvelope(t, file, workspace, pair.seed);
      expect(equalBytes(fromBase64Url(reopened.fileBytes), bytes)).toBe(true);
    }, 120_000);

    test("custody entries of telemetry payloads are attributed to their trace's chat", async () => {
      const t = makeTest();
      await startCutover(t);
      const { payload, chat } = await t.run(async (ctx) => {
        const workspace = await ctx.db.insert("workspaces", { ownerType: "user", ownerId: "alice", name: "Telemetry" });
        const chat = await ctx.db.insert("aisdk_chats", { workspace, userId: "bob", scope: "personal", lastInteractionAt: 1 });
        const trace = await ctx.db.insert("telemetry_traces", {
          workspace, userId: "alice", chatId: chat, source: "chatroom", requestId: "r", callId: "c", operationId: "o",
          functionId: "f", provider: "p", model: "m", status: "ok", startedAt: 1, recordsInputs: true, recordsOutputs: true,
        });
        const payload = await ctx.db.insert("telemetry_payloads", { trace, inputJson: "{\"secret\":true}" });
        return { payload, chat };
      });

      await t.mutation(internal.e2ee_migration.startJobs, { kind: "seal", tables: ["telemetry_payloads"], dryRun: false });
      await drain(t);

      expect(await t.run((ctx) => ctx.db.query("e2ee_legacy_custody").collect()))
        .toMatchObject([{ table: "telemetry_payloads", record: payload, chat }]);
      // The chat-key creation hook finds the entry through the registry's chat scope.
      expect(await t.run((ctx) => requestCustodyRelease(ctx, { chat }))).not.toBeNull();
    });
  });
});
