import { eq } from "drizzle-orm";
import {
  recoveryWrapperStatement,
  randomBytes,
  sha256,
  sign,
  signingPublicKeyFromSeed,
  toBase64Url,
} from "radium-crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestRuntime, type TestRuntime } from "../../test/runtime";
import { classicUser } from "../../test/users";
import { chats } from "../chatroom/schema";
import { appRouter } from "../trpc/router";
import { workspaceMembers, workspaces } from "../workspaces/schema";
import { e2eeChatKeys, e2eeIdentities, e2eeTrustStores } from "./schema";

// Account keys, device recovery, the trust store and the public-key directory through the real
// router, ported from Convex `e2ee.test.ts` and the directory and trust-store parts of
// `e2ee_workspaces.test.ts`, plus the races Convex serialized (trust store CAS, recovery take).

type Account = { id: string; headers: Headers; keyId: string; seed: Uint8Array };

let test: TestRuntime;
const db = () => test.runtime.drivers.db;
const call = (account: { headers: Headers }, clientAddress?: string) =>
  appRouter.createCaller({
    runtime: test.runtime,
    headers: account.headers,
    ...(clientAddress ? { clientAddress: async () => clientAddress } : {}),
  });
const anonymous = { headers: new Headers() };

const b64 = (n: number, fill = 7) => toBase64Url(new Uint8Array(n).fill(fill));
const randomId = () => toBase64Url(randomBytes(16));
const slot = () => toBase64Url(randomBytes(32));
const invalid = { code: "BAD_REQUEST", message: "E2EE_KEYS_INVALID" };

let accounts = 0;
/** A signed-in account; with `status`, an identity in that state (a fresh random key id). */
async function account(status?: "active" | "pending" | "retired"): Promise<Account> {
  accounts += 1;
  const user = await classicUser(test.runtime, `e2ee${accounts}@example.test`);
  const seed = randomBytes(32);
  const keyId = randomId();
  if (status) {
    await db()
      .insert(e2eeIdentities)
      .values({
        userId: user.id,
        keyId,
        suite: 1,
        encryptionPublicKey: new Uint8Array(1216).fill(4),
        signingPublicKey: await signingPublicKeyFromSeed(seed),
        secrets: new Uint8Array(1),
        selfSignature: new Uint8Array(64).fill(3),
        recoveryWrapper: new Uint8Array(79).fill(1),
        status,
      });
  }
  return { ...user, keyId, seed };
}

async function workspaceOf(owner: Account, members: Account[], archived = false) {
  const [row] = await db()
    .insert(workspaces)
    .values({ ownerId: owner.id, name: "Directory", archivedAt: archived ? new Date() : null })
    .returning();
  if (members.length > 0) {
    await db()
      .insert(workspaceMembers)
      .values(
        members.map((member) => ({
          workspace: row!.id,
          userId: member.id,
          role: "member" as const,
        })),
      );
  }
  return row!.id;
}

beforeAll(async () => {
  test = await createTestRuntime();
});

afterAll(async () => {
  await test?.close();
});

describe("account keys", () => {
  it("key status and recovery wrapper updates are limited to the caller's active identity", async () => {
    const alice = await account("active");
    const bob = await account("active");
    const original = new Uint8Array(79).fill(1);
    const originalHash = await sha256(original);

    await expect(call(anonymous).e2ee.myKeyStatus()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(await call(await account()).e2ee.myKeyStatus()).toEqual({ state: "none" });
    expect(await call(alice).e2ee.myKeyStatus()).toEqual({
      state: "ready",
      keyId: alice.keyId,
      recoveryWrapperHash: toBase64Url(originalHash),
      fingerprintInputs: {
        encryptionPublicKey: b64(1216, 4),
        signingPublicKey: toBase64Url(await signingPublicKeyFromSeed(alice.seed)),
      },
    });

    const wrapper = new Uint8Array(79).fill(9);
    const signed = async (seed: Uint8Array, next: Uint8Array, previousWrapperHash: Uint8Array) =>
      toBase64Url(
        await sign(
          seed,
          recoveryWrapperStatement({
            userId: alice.id,
            keyId: alice.keyId,
            wrapper: next,
            previousWrapperHash,
          }),
        ),
      );
    const signature = await signed(alice.seed, wrapper, originalHash);
    const refused = { code: "BAD_REQUEST" };

    // Another account, a wrong size, no signature or another key's signature: refused.
    await expect(
      call(bob).e2ee.setRecoveryWrapper({
        keyId: alice.keyId,
        recoveryWrapper: toBase64Url(wrapper),
        signature,
      }),
    ).rejects.toMatchObject(refused);
    await expect(
      call(alice).e2ee.setRecoveryWrapper({
        keyId: alice.keyId,
        recoveryWrapper: b64(80),
        signature,
      }),
    ).rejects.toMatchObject(refused);
    for (const forged of [b64(64, 0), await signed(randomBytes(32), wrapper, originalHash)]) {
      await expect(
        call(alice).e2ee.setRecoveryWrapper({
          keyId: alice.keyId,
          recoveryWrapper: toBase64Url(wrapper),
          signature: forged,
        }),
      ).rejects.toMatchObject(refused);
    }

    await call(alice).e2ee.setRecoveryWrapper({
      keyId: alice.keyId,
      recoveryWrapper: toBase64Url(wrapper),
      signature,
    });
    expect(await call(alice).e2ee.myKeyStatus()).toMatchObject({
      recoveryWrapperHash: toBase64Url(await sha256(wrapper)),
    });

    // A captured request stops verifying once the wrapper it replaced has changed, so neither it
    // nor one signed over the original state can roll the account back.
    for (const replay of [
      { recoveryWrapper: original, signature: await signed(alice.seed, original, originalHash) },
      { recoveryWrapper: wrapper, signature },
    ]) {
      await expect(
        call(alice).e2ee.setRecoveryWrapper({
          keyId: alice.keyId,
          recoveryWrapper: toBase64Url(replay.recoveryWrapper),
          signature: replay.signature,
        }),
      ).rejects.toMatchObject(refused);
    }
  });
});

describe("device recovery", () => {
  it("an offer is taken once, by its slot only, and not after it expires", async () => {
    const alice = await account("active");
    const mallory = await account("active");
    const sealedAmk = b64(79, 3);
    const slotId = slot();

    await expect(
      call(anonymous).e2ee.offerDeviceRecovery({ slotId, sealedAmk }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      call(alice).e2ee.offerDeviceRecovery({ slotId: toBase64Url(randomBytes(31)), sealedAmk }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await call(alice).e2ee.offerDeviceRecovery({ slotId, sealedAmk: b64(79, 2) });
    // Offering again replaces the offer; another account cannot take over the slot.
    await call(alice).e2ee.offerDeviceRecovery({ slotId, sealedAmk });
    await expect(
      call(mallory).e2ee.offerDeviceRecovery({ slotId, sealedAmk: b64(79, 6) }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    expect(await call(anonymous).e2ee.takeDeviceRecovery({ slotId: slot() })).toBeNull();
    expect(await call(anonymous).e2ee.takeDeviceRecovery({ slotId })).toEqual({ sealedAmk });
    expect(await call(anonymous).e2ee.takeDeviceRecovery({ slotId })).toBeNull();

    const expiring = slot();
    await call(alice).e2ee.offerDeviceRecovery({ slotId: expiring, sealedAmk });
    const ttl = Number(await test.runtime.drivers.kv.send("PTTL", [`e2ee:recovery:${expiring}`]));
    expect(ttl).toBeGreaterThan(14 * 60_000);
    expect(ttl).toBeLessThanOrEqual(15 * 60_000);
    // Valkey drops a key whose expiry is not positive at once: the offer's TTL running out.
    await test.runtime.drivers.kv.send("PEXPIRE", [`e2ee:recovery:${expiring}`, "0"]);
    expect(await call(anonymous).e2ee.takeDeviceRecovery({ slotId: expiring })).toBeNull();
  });

  it("gives an offer to exactly one of several racing takes", async () => {
    const alice = await account("active");
    const slotId = slot();
    await call(alice).e2ee.offerDeviceRecovery({ slotId, sealedAmk: b64(79, 3) });
    const taken = await Promise.all(
      Array.from({ length: 5 }, () => call(anonymous).e2ee.takeDeviceRecovery({ slotId })),
    );
    expect(taken.filter((result) => result !== null)).toEqual([{ sealedAmk: b64(79, 3) }]);
  });

  it("rate-limits takes per client address and offers per account", async () => {
    for (let i = 0; i < 60; i++) {
      await call(anonymous, "203.0.113.7").e2ee.takeDeviceRecovery({ slotId: slot() });
    }
    await expect(
      call(anonymous, "203.0.113.7").e2ee.takeDeviceRecovery({ slotId: slot() }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(
      await call(anonymous, "198.51.100.2").e2ee.takeDeviceRecovery({ slotId: slot() }),
    ).toBeNull();

    const alice = await account("active");
    for (let i = 0; i < 10; i++) {
      await call(alice).e2ee.offerDeviceRecovery({ slotId: slot(), sealedAmk: b64(79) });
    }
    await expect(
      call(alice).e2ee.offerDeviceRecovery({ slotId: slot(), sealedAmk: b64(79) }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("trust store", () => {
  it("compare-and-swap rejects stale writers and keeps stores per account", async () => {
    const alice = await account("active");
    const bob = await account("active");
    const conflict = { code: "CONFLICT", message: "TRUST_STORE_CONFLICT" };
    expect(await call(alice).e2ee.getTrustStore()).toBeNull();
    await call(alice).e2ee.saveTrustStore({ expectedVersion: null, version: 1, envelope: b64(20) });
    for (const stale of [
      { expectedVersion: null, version: 1 },
      { expectedVersion: 0, version: 1 },
      { expectedVersion: 1, version: 3 },
      { expectedVersion: 2, version: 3 },
    ]) {
      await expect(
        call(alice).e2ee.saveTrustStore({ ...stale, envelope: b64(20) }),
      ).rejects.toMatchObject(conflict);
    }
    await call(alice).e2ee.saveTrustStore({ expectedVersion: 1, version: 2, envelope: b64(21, 2) });
    expect(await call(alice).e2ee.getTrustStore()).toEqual({ version: 2, envelope: b64(21, 2) });
    expect(await call(bob).e2ee.getTrustStore()).toBeNull();
  });

  it("lands exactly one of several racing saves of one version", async () => {
    const alice = await account("active");
    for (const expectedVersion of [null, 1]) {
      const version = (expectedVersion ?? 0) + 1;
      const results = await Promise.allSettled(
        Array.from({ length: 5 }, (_, index) =>
          call(alice).e2ee.saveTrustStore({
            expectedVersion,
            version,
            envelope: b64(20, index + 1),
          }),
        ),
      );
      const winners = results.flatMap((result, index) =>
        result.status === "fulfilled" ? [index] : [],
      );
      expect(winners).toHaveLength(1);
      for (const result of results) {
        if (result.status === "rejected") {
          expect(result.reason).toMatchObject({ code: "CONFLICT" });
        }
      }
      expect(await call(alice).e2ee.getTrustStore()).toEqual({
        version,
        envelope: b64(20, winners[0]! + 1),
      });
    }
    expect(
      await db().select().from(e2eeTrustStores).where(eq(e2eeTrustStores.userId, alice.id)),
    ).toHaveLength(1);
  });
});

describe("public-key directory", () => {
  it("shows only the caller and users sharing an active workspace", async () => {
    const owner = await account("active");
    const member = await account("active");
    const keyless = await account();
    const outsider = await account("active");
    const archivedOnly = await account("active");
    await workspaceOf(owner, [member, keyless]);
    await workspaceOf(owner, [archivedOnly], true);

    const rows = await call(member).e2ee.identityKeys({
      userIds: [owner.id, member.id, keyless.id],
    });
    expect(rows).toEqual([
      expect.objectContaining({ userId: owner.id, keyId: owner.keyId, suite: 1 }),
      expect.objectContaining({ userId: member.id, keyId: member.keyId }),
      null,
    ]);
    expect(await call(outsider).e2ee.identityKeys({ userIds: [outsider.id] })).toEqual([
      expect.objectContaining({ keyId: outsider.keyId }),
    ]);
    for (const [caller, target] of [
      [outsider, owner],
      [owner, outsider],
      [owner, archivedOnly],
      [archivedOnly, member],
    ] as const) {
      await expect(call(caller).e2ee.identityKeys({ userIds: [target.id] })).rejects.toMatchObject(
        invalid,
      );
      await expect(call(caller).e2ee.identityNames({ userIds: [target.id] })).rejects.toMatchObject(
        invalid,
      );
    }
    expect(
      await call(owner).e2ee.identityNames({ userIds: [member.id, member.id, owner.id] }),
    ).toEqual([
      { userId: member.id, name: expect.stringMatching(/@example\.test$/) },
      { userId: owner.id, name: expect.stringMatching(/@example\.test$/) },
    ]);
  });

  it("returns retired identities by key id but hides pending and unrelated keys", async () => {
    const owner = await account("active");
    const retired = await account("retired");
    const pending = await account("pending");
    const outsider = await account("active");
    await workspaceOf(owner, [retired, pending]);

    const rows = await call(owner).e2ee.identityKeysByKeyId({
      keyIds: [retired.keyId, pending.keyId, randomId()],
    });
    expect(rows).toEqual([
      expect.objectContaining({ userId: retired.id, keyId: retired.keyId, status: "retired" }),
      null,
      null,
    ]);
    await expect(
      call(outsider).e2ee.identityKeysByKeyId({ keyIds: [retired.keyId] }),
    ).rejects.toMatchObject(invalid);
    await expect(
      call(owner).e2ee.identityKeysByKeyId({ keyIds: ["not-a-key-id"] }),
    ).rejects.toMatchObject(invalid);
  });

  it("keeps a removed creator's chat signature verifiable for the chat's readers only", async () => {
    const owner = await account("active");
    const creator = await account("active");
    const reader = await account("active");
    const workspace = await workspaceOf(owner, [creator, reader]);
    const [chat] = await db()
      .insert(chats)
      .values({
        workspace,
        userId: creator.id,
        scope: "workspace",
        e2eeId: randomId(),
        keyEpoch: 1,
      })
      .returning();
    await db()
      .insert(e2eeChatKeys)
      .values({
        chat: chat!.id,
        epoch: 1,
        keyId: randomId(),
        suite: 1,
        publicKey: new Uint8Array(1216),
        signerUserId: creator.id,
        signerKeyId: creator.keyId,
        signature: new Uint8Array(64),
      });
    await db().delete(workspaceMembers).where(eq(workspaceMembers.userId, creator.id));

    await expect(
      call(reader).e2ee.identityKeysByKeyId({ keyIds: [creator.keyId] }),
    ).rejects.toMatchObject(invalid);
    expect(
      await call(reader).e2ee.identityKeysByKeyId({
        keyIds: [creator.keyId],
        chatEpoch: { chatId: chat!.id, epoch: 1 },
      }),
    ).toEqual([expect.objectContaining({ userId: creator.id, status: "active" })]);
    // The exception covers only that epoch's signer, and only for readers of the chat.
    await expect(
      call(reader).e2ee.identityKeysByKeyId({
        keyIds: [creator.keyId],
        chatEpoch: { chatId: chat!.id, epoch: 2 },
      }),
    ).rejects.toMatchObject(invalid);
    await expect(
      call(creator).e2ee.identityKeysByKeyId({
        keyIds: [owner.keyId],
        chatEpoch: { chatId: chat!.id, epoch: 1 },
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
