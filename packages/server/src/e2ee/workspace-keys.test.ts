import { and, eq } from "drizzle-orm";
import {
  fingerprint,
  grantStatement,
  randomBytes,
  ROSTER_EPOCH_WINDOW,
  rosterStatement,
  sign,
  signingPublicKeyFromSeed,
  toBase64Url,
  utf8,
  workerKeysStatement,
} from "radium-crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestRuntime, type TestRuntime } from "../../test/runtime";
import { classicUser } from "../../test/users";
import { appRouter } from "../trpc/router";
import type { WorkerScope } from "../worker/auth";
import { workerEnrollments, workerKeys as workerProofKeys, workers } from "../worker/schema";
import { workspaceMembers, workspaces } from "../workspaces/schema";
import { pruneExpiredInvites } from "./invites";
import {
  e2eeIdentities,
  e2eeInvites,
  e2eeJoinRequests,
  e2eeWorkerPairings,
  e2eeWorkspaceGrants,
} from "./schema";
import {
  publishWorkerKeys,
  publishWorkerKeysInput,
  pruneWorkerPairings,
  requireDispatchableWorker,
  WORKER_PAIRING_RETENTION_MS,
} from "./worker-keys";

// Workspace keys, admission and Worker pairing through the real router: authorization (owner,
// member, outsider, archived) for every workspace procedure, behavior ported from Convex
// `e2ee_workspaces.test.ts` and `e2ee_workers.test.ts`, retention, and the invariants that relied
// on Convex serializing mutations (roster versions, single-use access links).

type Role = "owner" | "member" | "other" | "outsider";
type Person = { id: string; headers: Headers; email: string; keyId: string; seed: Uint8Array };

let test: TestRuntime;
const people = {} as Record<Role, Person>;
const db = () => test.runtime.drivers.db;
const call = (person: Person) =>
  appRouter.createCaller({ runtime: test.runtime, headers: person.headers });

const keyId = (fill: number) => toBase64Url(new Uint8Array(16).fill(fill));
/** Distinct key ids for workspace epoch keys: `[kind, epoch, 0…]`. */
const epochKeyId = (kind: number, epoch: number) => {
  const id = new Uint8Array(16);
  id[0] = kind;
  id[1] = epoch % 256;
  id[2] = Math.floor(epoch / 256);
  return toBase64Url(id);
};
const memberKeyId = (epoch: number) => epochKeyId(200, epoch);
const ownerKeyId = (epoch: number) => epochKeyId(201, epoch);
const bytes = (n: number, fill = 7) => toBase64Url(new Uint8Array(n).fill(fill));
const invalid = { code: "BAD_REQUEST", message: "E2EE_KEYS_INVALID" };
const notFound = { code: "NOT_FOUND" };

let accounts = 0;
/** A signed-in account with an active identity whose key id byte is `fill`. */
async function person(label: string, fill: number): Promise<Person> {
  accounts += 1;
  const email = `${label}${accounts}@example.test`;
  const user = await classicUser(test.runtime, email);
  const seed = new Uint8Array(32).fill(fill);
  await addIdentity(user.id, keyId(fill), seed);
  return { ...user, email, keyId: keyId(fill), seed };
}

async function addIdentity(userId: string, id: string, seed: Uint8Array) {
  await db()
    .insert(e2eeIdentities)
    .values({
      userId,
      keyId: id,
      suite: 1,
      encryptionPublicKey: new Uint8Array(1216).fill(5),
      signingPublicKey: await signingPublicKeyFromSeed(seed),
      secrets: new Uint8Array(1),
      selfSignature: new Uint8Array(64),
      recoveryWrapper: new Uint8Array(1),
      status: "active",
    });
}

/** A fresh workspace of the owner with `members` as direct members. */
async function newWorkspace(members: Person[] = [people.member, people.other]) {
  const [row] = await db()
    .insert(workspaces)
    .values({ ownerId: people.owner.id, name: "Keys" })
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

/** A grant of `epoch` to `recipient`, signed by `signer`, in wire form. */
async function grant(
  workspace: string,
  recipient: Person,
  options: {
    epoch?: number;
    signer?: Person;
    purpose?: "member" | "owner";
    recipientKeyId?: string;
  } = {},
) {
  const { epoch = 1, signer = people.owner, purpose = "member" } = options;
  const recipientKeyId = options.recipientKeyId ?? recipient.keyId;
  const sealed = new Uint8Array(1200).fill(epoch % 256);
  return {
    epoch,
    purpose,
    userId: recipient.id,
    recipientKeyId,
    granterKeyId: signer.keyId,
    sealed: toBase64Url(sealed),
    signature: toBase64Url(
      await sign(
        signer.seed,
        grantStatement({
          workspaceId: workspace,
          epoch,
          purpose,
          recipientUserId: recipient.id,
          recipientKeyId,
          sealed,
        }),
      ),
    ),
  };
}

type RosterOptions = {
  v?: 1 | 2 | 3;
  members?: Person[];
  workers?: { workerId: string; keyId: string; fingerprint: string }[];
  archive?: { through: number; hash: string };
};

/** An owner-signed roster body in wire form. */
async function roster(
  workspace: string,
  version: number,
  epoch: number,
  { v = 1, members = [], workers: listed = [], archive }: RosterOptions = {},
) {
  const body = utf8(
    JSON.stringify({
      v,
      workspace,
      version,
      epoch,
      owner: { userId: people.owner.id, keyId: people.owner.keyId, fingerprint: "owner" },
      epochs: [],
      members: members.map((member) => ({
        userId: member.id,
        keyId: member.keyId,
        fingerprint: member.id,
      })),
      ...(v === 1 ? {} : { workers: listed }),
      ...(archive ? { archive } : {}),
    }),
  );
  return {
    version,
    body: toBase64Url(body),
    signature: toBase64Url(
      await sign(people.owner.seed, rosterStatement({ workspaceId: workspace, body })),
    ),
    signerKeyId: people.owner.keyId,
  };
}

/** Stand-in roster archive chain value after `through`; the server stores it, readers verify it. */
const archiveHash = (through: number) =>
  toBase64Url(new Uint8Array(32).fill(through === 0 ? 0 : (through % 255) + 1));

/** Epoch `epoch` with the owner's two grants and a roster of version `epoch`. */
async function rotation(workspace: string, epoch: number, options: RosterOptions = {}) {
  const through = Math.max(0, epoch - ROSTER_EPOCH_WINDOW);
  return {
    epoch: {
      epoch,
      suite: 1,
      memberKeyId: memberKeyId(epoch),
      memberPublicKey: bytes(1216, 9),
      ownerKeyId: ownerKeyId(epoch),
      ownerPublicKey: bytes(1216, 8),
    },
    grants: [
      await grant(workspace, people.owner, { epoch }),
      await grant(workspace, people.owner, { epoch, purpose: "owner" }),
    ],
    roster: await roster(workspace, epoch, epoch, {
      ...options,
      ...(options.v === 3 ? { archive: { through, hash: archiveHash(through) } } : {}),
    }),
  };
}

async function keyedWorkspace(members?: Person[]) {
  const workspace = await newWorkspace(members);
  await call(people.owner).e2ee.bootstrapWorkspaceKeys({
    workspace,
    ...(await rotation(workspace, 1)),
  });
  return workspace;
}

beforeAll(async () => {
  test = await createTestRuntime();
  for (const [index, role] of (["owner", "member", "other", "outsider"] as const).entries()) {
    people[role] = await person(role, index + 1);
  }
});

afterAll(async () => {
  await test?.close();
});

describe("authorization", () => {
  it("refuses members, outsiders and archived workspaces alike on every workspace procedure", async () => {
    const workspace = await keyedWorkspace();
    const archived = await keyedWorkspace();
    await db()
      .update(workspaces)
      .set({ archivedAt: new Date() })
      .where(eq(workspaces.id, archived));

    type Call = (caller: ReturnType<typeof call>, workspace: string) => Promise<unknown>;
    const ownerOnly: Record<string, Call> = {
      bootstrapWorkspaceKeys: async (c, w) =>
        c.e2ee.bootstrapWorkspaceKeys({ workspace: w, ...(await rotation(w, 1)) }),
      rotateWorkspaceEpoch: async (c, w) =>
        c.e2ee.rotateWorkspaceEpoch({ workspace: w, ...(await rotation(w, 2)) }),
      publishRoster: async (c, w) =>
        c.e2ee.publishRoster({ workspace: w, roster: await roster(w, 9, 1) }),
      createInvite: (c, w) =>
        c.e2ee.createInvite({
          workspace: w,
          inviteId: keyId(90),
          invitedUserId: people.member.id,
          epoch: 1,
          sealed: bytes(10),
          ownerSecret: bytes(10),
        }),
      revokeInvite: (c, w) => c.e2ee.revokeInvite({ workspace: w, inviteId: keyId(90) }),
      setPhrase: (c, w) =>
        c.e2ee.setPhrase({
          workspace: w,
          epoch: 1,
          phraseId: keyId(91),
          wrapper: bytes(10),
          ownerSecret: bytes(10),
        }),
      removePhrase: (c, w) => c.e2ee.removePhrase({ workspace: w }),
      dismissJoinRequest: (c, w) => c.e2ee.dismissJoinRequest({ workspace: w, requestId: "x" }),
      staleWorkspaceWraps: (c, w) => c.e2ee.staleWorkspaceWraps({ workspace: w }),
      replaceWorkspaceWraps: (c, w) =>
        c.e2ee.replaceWorkspaceWraps({ workspace: w, replacements: [] }),
      createWorkerPairing: (c, w) =>
        c.e2ee.createWorkerPairing({
          workspace: w,
          pairingId: keyId(92),
          sealedSecret: bytes(10),
          target: { kind: "worker", workerId: "x" },
        }),
      workerPairings: (c, w) => c.e2ee.workerPairings({ workspace: w }),
    };
    const members: Record<string, Call> = {
      workspaceKeyState: (c, w) => c.e2ee.workspaceKeyState({ workspace: w }),
      workspaceArchivedEpochs: (c, w) =>
        c.e2ee.workspaceArchivedEpochs({ workspace: w, fromEpoch: 1, toEpoch: 1 }),
      addGrants: (c, w) => c.e2ee.addGrants({ workspace: w, grants: [] }),
      acceptPhrase: async (c, w) =>
        c.e2ee.acceptPhrase({
          workspace: w,
          keyId: people.member.keyId,
          mac: bytes(32),
          selfGrant: await grant(w, people.member, { signer: people.member }),
        }),
      requestKeys: (c, w) => c.e2ee.requestKeys({ workspace: w, keyId: people.member.keyId }),
      workerKeys: (c, w) => c.e2ee.workerKeys({ workspace: w }),
    };

    for (const [name, run] of Object.entries(ownerOnly)) {
      for (const [who, target] of [
        [people.member, workspace],
        [people.outsider, workspace],
        [people.owner, archived],
      ] as const) {
        await expect(run(call(who), target), name).rejects.toMatchObject(notFound);
      }
    }
    for (const [name, run] of Object.entries(members)) {
      for (const [who, target] of [
        [people.outsider, workspace],
        [people.member, archived],
        [people.owner, archived],
      ] as const) {
        await expect(run(call(who), target), name).rejects.toMatchObject(notFound);
      }
      // Members pass the access check (the call itself may still refuse the input).
      const outcome = await run(call(people.member), workspace).catch(
        (error: { code: string }) => error,
      );
      expect((outcome as { code?: string } | undefined)?.code, name).not.toBe("NOT_FOUND");
    }
  });
});

describe("workspace keys", () => {
  it("bootstrap once, owner-signed rosters only, strictly increasing versions", async () => {
    const workspace = await newWorkspace();
    const keys = await rotation(workspace, 1);
    // No rotation of a keyless workspace, and a forged roster fails closed.
    await expect(
      call(people.owner).e2ee.rotateWorkspaceEpoch({ workspace, ...keys }),
    ).rejects.toMatchObject(invalid);
    await expect(
      call(people.owner).e2ee.bootstrapWorkspaceKeys({
        workspace,
        ...keys,
        roster: { ...keys.roster, signature: bytes(64) },
      }),
    ).rejects.toMatchObject(invalid);
    await call(people.owner).e2ee.bootstrapWorkspaceKeys({ workspace, ...keys });
    await expect(
      call(people.owner).e2ee.bootstrapWorkspaceKeys({ workspace, ...keys }),
    ).rejects.toMatchObject(invalid);

    await expect(
      call(people.owner).e2ee.publishRoster({
        workspace,
        roster: { ...(await roster(workspace, 2, 1)), signature: bytes(64) },
      }),
    ).rejects.toMatchObject(invalid);
    // A stale or repeated version never replaces the head.
    for (const version of [1, 0]) {
      await expect(
        call(people.owner).e2ee.publishRoster({
          workspace,
          roster: await roster(workspace, version, 1),
        }),
      ).rejects.toMatchObject(invalid);
    }
    // Rosters list current members by their active keys only.
    await expect(
      call(people.owner).e2ee.publishRoster({
        workspace,
        roster: await roster(workspace, 2, 1, { members: [people.outsider] }),
      }),
    ).rejects.toMatchObject(invalid);
    await call(people.owner).e2ee.publishRoster({
      workspace,
      roster: await roster(workspace, 3, 1, { members: [people.member] }),
    });
    const state = await call(people.member).e2ee.workspaceKeyState({ workspace });
    expect(state).toMatchObject({
      role: "member",
      ownerId: people.owner.id,
      keyEpoch: 1,
      roster: { version: 3, signerKeyId: people.owner.keyId },
      myGrants: [],
      invites: [],
      phrase: null,
    });
    expect(state.epochs).toMatchObject([{ epoch: 1, memberKeyId: memberKeyId(1) }]);
    expect(state.members).toEqual([
      { userId: people.owner.id, role: "owner", keyId: people.owner.keyId, grantedEpoch: 1 },
      { userId: people.member.id, role: "member", keyId: people.member.keyId, grantedEpoch: null },
      { userId: people.other.id, role: "member", keyId: people.other.keyId, grantedEpoch: null },
    ]);
  });

  it("serializes racing roster publishes: exactly one of each version lands", async () => {
    const workspace = await keyedWorkspace();
    const next = await roster(workspace, 2, 1, { members: [people.member] });
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        call(people.owner).e2ee.publishRoster({ workspace, roster: next }),
      ),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    for (const result of results) {
      if (result.status === "rejected") expect(result.reason).toMatchObject(invalid);
    }
    expect((await call(people.owner).e2ee.workspaceKeyState({ workspace })).roster?.version).toBe(
      2,
    );
  });

  it("grants need active recipients and no plain self-grants; owner grants resolve key requests", async () => {
    const workspace = await keyedWorkspace();
    await expect(
      call(people.owner).e2ee.addGrants({
        workspace,
        grants: [await grant(workspace, people.member, { recipientKeyId: keyId(99) })],
      }),
    ).rejects.toMatchObject(invalid);
    await expect(
      call(people.member).e2ee.addGrants({
        workspace,
        grants: [await grant(workspace, people.member, { signer: people.member })],
      }),
    ).rejects.toMatchObject(invalid);
    await expect(
      call(people.owner).e2ee.addGrants({
        workspace,
        grants: [await grant(workspace, people.outsider)],
      }),
    ).rejects.toMatchObject(invalid);

    // Requests are idempotent per identity.
    await call(people.member).e2ee.requestKeys({ workspace, keyId: people.member.keyId });
    await call(people.member).e2ee.requestKeys({ workspace, keyId: people.member.keyId });
    await expect(
      call(people.member).e2ee.requestKeys({ workspace, keyId: people.other.keyId }),
    ).rejects.toMatchObject(invalid);
    expect(
      (await call(people.owner).e2ee.workspaceKeyState({ workspace })).joinRequests,
    ).toMatchObject([{ userId: people.member.id, source: "request", mac: null }]);

    await call(people.owner).e2ee.addGrants({
      workspace,
      grants: [await grant(workspace, people.member)],
    });
    const state = await call(people.owner).e2ee.workspaceKeyState({ workspace });
    expect(state.joinRequests).toEqual([]);
    expect(state.members.find((m) => m.userId === people.member.id)?.grantedEpoch).toBe(1);
    // Once granted, asking again changes nothing.
    await call(people.member).e2ee.requestKeys({ workspace, keyId: people.member.keyId });
    expect((await call(people.owner).e2ee.workspaceKeyState({ workspace })).joinRequests).toEqual(
      [],
    );
    expect(
      (await call(people.member).e2ee.workspaceKeyState({ workspace })).myGrants,
    ).toMatchObject([{ epoch: 1, purpose: "member", userId: people.member.id }]);
  });

  it("owner grants replace member re-grants, which never count as granted or suppress requests", async () => {
    const workspace = await keyedWorkspace();
    await call(people.owner).e2ee.publishRoster({
      workspace,
      roster: await roster(workspace, 2, 1, { members: [people.member, people.other] }),
    });
    await call(people.owner).e2ee.addGrants({
      workspace,
      grants: [await grant(workspace, people.member)],
    });
    // A member's re-grant (possibly junk) must not hide the missing owner-signed grant.
    await call(people.member).e2ee.addGrants({
      workspace,
      grants: [await grant(workspace, people.other, { signer: people.member })],
    });
    const grantedEpoch = async () =>
      (await call(people.owner).e2ee.workspaceKeyState({ workspace })).members.find(
        (member) => member.userId === people.other.id,
      )?.grantedEpoch;
    expect(await grantedEpoch()).toBeNull();
    await call(people.other).e2ee.requestKeys({ workspace, keyId: people.other.keyId });
    expect(
      (await call(people.owner).e2ee.workspaceKeyState({ workspace })).joinRequests.map(
        (request) => request.userId,
      ),
    ).toEqual([people.other.id]);
    // Members see key requests of roster-listed members, which they may re-grant.
    expect(
      (await call(people.member).e2ee.workspaceKeyState({ workspace })).joinRequests.map(
        (request) => request.userId,
      ),
    ).toEqual([people.other.id]);

    await call(people.owner).e2ee.addGrants({
      workspace,
      grants: [await grant(workspace, people.other)],
    });
    const rows = await db()
      .select()
      .from(e2eeWorkspaceGrants)
      .where(
        and(
          eq(e2eeWorkspaceGrants.workspace, workspace),
          eq(e2eeWorkspaceGrants.userId, people.other.id),
        ),
      );
    expect(rows.map((row) => row.granterUserId)).toEqual([people.owner.id]);
    expect(await grantedEpoch()).toBe(1);
    expect((await call(people.owner).e2ee.workspaceKeyState({ workspace })).joinRequests).toEqual(
      [],
    );
  });

  it("member re-grants must target the identity pinned in the signed roster", async () => {
    const late = await person("late", 50);
    const workspace = await keyedWorkspace([people.member, late]);
    await call(people.owner).e2ee.publishRoster({
      workspace,
      roster: await roster(workspace, 2, 1, { members: [late] }),
    });
    await call(people.owner).e2ee.addGrants({
      workspace,
      grants: [await grant(workspace, people.member)],
    });
    // A member re-grants only to roster-listed members, and only epochs they hold.
    await expect(
      call(late).e2ee.addGrants({
        workspace,
        grants: [await grant(workspace, people.member, { signer: late })],
      }),
    ).rejects.toMatchObject(invalid);
    await db()
      .update(e2eeIdentities)
      .set({ status: "retired" })
      .where(eq(e2eeIdentities.keyId, late.keyId));
    await addIdentity(late.id, keyId(51), late.seed);
    await expect(
      call(people.member).e2ee.addGrants({
        workspace,
        grants: [
          await grant(workspace, late, { signer: people.member, recipientKeyId: keyId(51) }),
        ],
      }),
    ).rejects.toMatchObject(invalid);
  });

  it("rotate past the roster window and the former 200-epoch cap; archived epochs page", async () => {
    const workspace = await newWorkspace();
    await call(people.owner).e2ee.bootstrapWorkspaceKeys({
      workspace,
      ...(await rotation(workspace, 1, { v: 3 })),
    });
    const last = ROSTER_EPOCH_WINDOW + 3;
    for (let epoch = 2; epoch <= last; epoch++) {
      await call(people.owner).e2ee.rotateWorkspaceEpoch({
        workspace,
        ...(await rotation(workspace, epoch, { v: 3 })),
      });
    }
    const window = Array.from({ length: ROSTER_EPOCH_WINDOW }, (_, index) => index + 4);
    const state = await call(people.owner).e2ee.workspaceKeyState({ workspace });
    expect(state.epochs.map((row) => row.epoch)).toEqual(window);
    expect([...new Set(state.myGrants.map((row) => row.epoch))]).toEqual(window);

    const page = await call(people.owner).e2ee.workspaceArchivedEpochs({
      workspace,
      fromEpoch: 3,
      toEpoch: 3,
    });
    expect(page.prefixHash).toBe(archiveHash(2));
    expect(page.epochs.map((row) => row.epoch)).toEqual([3]);
    expect(page.myGrants.map((row) => row.epoch)).toEqual([3, 3]);
    const first = await call(people.member).e2ee.workspaceArchivedEpochs({
      workspace,
      fromEpoch: 1,
      toEpoch: 3,
    });
    expect(first.prefixHash).toBeNull();
    expect(first.epochs.map((row) => row.epoch)).toEqual([1, 2, 3]);
    expect(first.myGrants).toEqual([]);
    for (const range of [
      { fromEpoch: last, toEpoch: last + 1 },
      { fromEpoch: 3, toEpoch: 2 },
      { fromEpoch: 0, toEpoch: 1 },
    ]) {
      await expect(
        call(people.owner).e2ee.workspaceArchivedEpochs({ workspace, ...range }),
      ).rejects.toMatchObject(invalid);
    }

    // Rotation and member removal continue beyond the former cap.
    await db().update(workspaces).set({ keyEpoch: 200 }).where(eq(workspaces.id, workspace));
    await call(people.owner).e2ee.rotateWorkspaceEpoch({
      workspace,
      ...(await rotation(workspace, 201, { v: 3 })),
    });
    await call(people.owner).workspaces.removeMember({
      workspace,
      email: people.member.email,
      rotation: await rotation(workspace, 202, { v: 3 }),
    });
    expect((await call(people.owner).e2ee.workspaceKeyState({ workspace })).keyEpoch).toBe(202);
    await expect(
      call(people.owner).e2ee.workspaceArchivedEpochs({ workspace, fromEpoch: 1, toEpoch: 65 }),
    ).rejects.toMatchObject(invalid);
  });
});

describe("admission", () => {
  it("access links are intended-account-only, single-use and expiring", async () => {
    const workspace = await keyedWorkspace();
    const inviteId = keyId(31);
    const invite = (id: string, invitedUserId: string, epoch = 1) =>
      call(people.owner).e2ee.createInvite({
        workspace,
        inviteId: id,
        invitedUserId,
        epoch,
        sealed: bytes(10),
        ownerSecret: bytes(12),
      });
    // Only current members at the current epoch, never the owner or an outsider.
    for (const [userId, epoch] of [
      [people.owner.id, 1],
      [people.outsider.id, 1],
      [people.member.id, 2],
    ] as const) {
      await expect(invite(keyId(30), userId, epoch)).rejects.toMatchObject(invalid);
    }
    await invite(inviteId, people.member.id);
    const owners = await call(people.owner).e2ee.workspaceKeyState({ workspace });
    expect(owners.invites).toMatchObject([{ inviteId, invitedUserId: people.member.id }]);
    expect((await call(people.member).e2ee.workspaceKeyState({ workspace })).invites).toEqual([]);

    const args = {
      inviteId,
      keyId: people.member.keyId,
      mac: bytes(32),
      selfGrant: await grant(workspace, people.member, { signer: people.member }),
    };
    expect(await call(people.other).e2ee.getInvite({ inviteId })).toBeNull();
    expect(await call(people.owner).e2ee.getInvite({ inviteId })).toBeNull();
    expect(await call(people.member).e2ee.getInvite({ inviteId })).toMatchObject({
      workspace,
      epoch: 1,
      sealed: bytes(10),
      ownerId: people.owner.id,
    });
    await expect(call(people.other).e2ee.acceptInvite(args)).rejects.toMatchObject(invalid);
    // A refused join (a grant to another key) leaves the link usable.
    await expect(
      call(people.member).e2ee.acceptInvite({ ...args, keyId: keyId(99) }),
    ).rejects.toMatchObject(invalid);
    await call(people.member).e2ee.acceptInvite(args);
    await expect(call(people.member).e2ee.acceptInvite(args)).rejects.toMatchObject(invalid);
    expect(await call(people.member).e2ee.getInvite({ inviteId })).toBeNull();
    const state = await call(people.owner).e2ee.workspaceKeyState({ workspace });
    expect(state.joinRequests).toMatchObject([
      {
        userId: people.member.id,
        source: "invite",
        sourceId: inviteId,
        epoch: 1,
        ownerSecret: bytes(12),
      },
    ]);

    // Expired links are neither shown nor accepted.
    await invite(keyId(32), people.member.id);
    await db()
      .update(e2eeInvites)
      .set({ expiresAt: new Date(Date.now() - 1) })
      .where(eq(e2eeInvites.inviteId, keyId(32)));
    expect(await call(people.member).e2ee.getInvite({ inviteId: keyId(32) })).toBeNull();
    await expect(
      call(people.member).e2ee.acceptInvite({ ...args, inviteId: keyId(32) }),
    ).rejects.toMatchObject(invalid);
    expect((await call(people.owner).e2ee.workspaceKeyState({ workspace })).invites).toEqual([]);

    // Revoked links are gone.
    await invite(keyId(33), people.other.id);
    await call(people.owner).e2ee.revokeInvite({ workspace, inviteId: keyId(33) });
    expect(await call(people.other).e2ee.getInvite({ inviteId: keyId(33) })).toBeNull();
  });

  it("access links of an archived workspace are neither shown nor accepted", async () => {
    const workspace = await keyedWorkspace();
    const inviteId = keyId(36);
    await call(people.owner).e2ee.createInvite({
      workspace,
      inviteId,
      invitedUserId: people.member.id,
      epoch: 1,
      sealed: bytes(10),
      ownerSecret: bytes(10),
    });
    await db()
      .update(workspaces)
      .set({ archivedAt: new Date() })
      .where(eq(workspaces.id, workspace));
    expect(await call(people.member).e2ee.getInvite({ inviteId })).toBeNull();
    await expect(
      call(people.member).e2ee.acceptInvite({
        inviteId,
        keyId: people.member.keyId,
        mac: bytes(32),
        selfGrant: await grant(workspace, people.member, { signer: people.member }),
      }),
    ).rejects.toMatchObject(notFound);
  });

  it("accepts one link once when several accepts race", async () => {
    const workspace = await keyedWorkspace();
    const inviteId = keyId(34);
    await call(people.owner).e2ee.createInvite({
      workspace,
      inviteId,
      invitedUserId: people.member.id,
      epoch: 1,
      sealed: bytes(10),
      ownerSecret: bytes(10),
    });
    const args = {
      inviteId,
      keyId: people.member.keyId,
      mac: bytes(32),
      selfGrant: await grant(workspace, people.member, { signer: people.member }),
    };
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => call(people.member).e2ee.acceptInvite(args)),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    for (const result of results) {
      if (result.status === "rejected") expect(result.reason).toMatchObject(invalid);
    }
    expect(
      await db().select().from(e2eeJoinRequests).where(eq(e2eeJoinRequests.workspace, workspace)),
    ).toHaveLength(1);
  });

  it("phrases are owner-set for the current epoch; members join through them", async () => {
    const workspace = await keyedWorkspace();
    const phraseId = keyId(40);
    const join = async () =>
      call(people.member).e2ee.acceptPhrase({
        workspace,
        keyId: people.member.keyId,
        mac: bytes(32),
        selfGrant: await grant(workspace, people.member, { signer: people.member }),
      });
    await expect(join()).rejects.toMatchObject(invalid);
    await expect(
      call(people.owner).e2ee.setPhrase({
        workspace,
        epoch: 2,
        phraseId,
        wrapper: bytes(20),
        ownerSecret: bytes(10),
      }),
    ).rejects.toMatchObject(invalid);
    await call(people.owner).e2ee.setPhrase({
      workspace,
      epoch: 1,
      phraseId,
      wrapper: bytes(20),
      ownerSecret: bytes(10),
    });
    expect((await call(people.member).e2ee.workspaceKeyState({ workspace })).phrase).toEqual({
      epoch: 1,
      phraseId,
      wrapper: bytes(20),
    });
    await join();
    // The owner sees the proof; members never see another member's join proof.
    const owners = await call(people.owner).e2ee.workspaceKeyState({ workspace });
    expect(owners.joinRequests).toMatchObject([{ source: "phrase", sourceId: phraseId }]);
    expect((await call(people.other).e2ee.workspaceKeyState({ workspace })).joinRequests).toEqual(
      [],
    );

    await call(people.owner).e2ee.dismissJoinRequest({
      workspace,
      requestId: owners.joinRequests[0]!.id,
    });
    expect((await call(people.owner).e2ee.workspaceKeyState({ workspace })).joinRequests).toEqual(
      [],
    );
    // Dismissing leaves grants intact.
    expect((await call(people.member).e2ee.workspaceKeyState({ workspace })).myGrants).toHaveLength(
      1,
    );

    await call(people.owner).e2ee.removePhrase({ workspace });
    expect((await call(people.member).e2ee.workspaceKeyState({ workspace })).phrase).toBeNull();
    await expect(join()).rejects.toMatchObject(invalid);
  });

  it("rotation deletes pending links and join requests", async () => {
    const workspace = await keyedWorkspace();
    await call(people.owner).e2ee.createInvite({
      workspace,
      inviteId: keyId(35),
      invitedUserId: people.member.id,
      epoch: 1,
      sealed: bytes(10),
      ownerSecret: bytes(10),
    });
    await call(people.other).e2ee.requestKeys({ workspace, keyId: people.other.keyId });
    await call(people.owner).e2ee.rotateWorkspaceEpoch({
      workspace,
      ...(await rotation(workspace, 2)),
    });
    const state = await call(people.owner).e2ee.workspaceKeyState({ workspace });
    expect(state.invites).toEqual([]);
    expect(state.joinRequests).toEqual([]);
    expect(await call(people.member).e2ee.getInvite({ inviteId: keyId(35) })).toBeNull();
  });
});

describe("Worker keys", () => {
  async function workerFixture() {
    const workspace = await keyedWorkspace();
    const [active, revoked] = await db()
      .insert(workers)
      .values([
        { workspace, name: "a", capabilities: [], status: "active", identityEpoch: 1 },
        { workspace, name: "b", capabilities: [], status: "revoked", identityEpoch: 2 },
      ])
      .returning();
    const [proof] = await db()
      .insert(workerProofKeys)
      .values({
        worker: active!.id,
        algorithm: "ES256",
        material: "{}",
        thumbprint: toBase64Url(randomBytes(32)),
      })
      .returning();
    const scope: WorkerScope = {
      workerId: active!.id,
      keyId: proof!.id,
      workspaceId: workspace,
      identityEpoch: 1,
    };
    return { workspace, active: active!.id, revoked: revoked!.id, scope };
  }

  /** A key set with a valid self-signature for `scope`, published from `pairingId`. */
  async function keySet(scope: WorkerScope, pairingId: string) {
    const seed = randomBytes(32);
    const keys = {
      keyId: toBase64Url(randomBytes(16)),
      suite: 1,
      encryptionPublicKey: randomBytes(1216),
      signingPublicKey: await signingPublicKeyFromSeed(seed),
    };
    const statement = workerKeysStatement({
      workspaceId: scope.workspaceId,
      workerId: scope.workerId,
      ...keys,
    });
    return {
      fingerprint: await fingerprint(keys),
      input: publishWorkerKeysInput.parse({
        pairingId,
        keyId: keys.keyId,
        suite: 1,
        encryptionPublicKey: toBase64Url(keys.encryptionPublicKey),
        signingPublicKey: toBase64Url(keys.signingPublicKey),
        selfSignature: toBase64Url(await sign(seed, statement)),
        pairingMac: toBase64Url(randomBytes(32)),
      }),
    };
  }

  it("pairings are owner-only, for keyed workspaces and their active Workers or enrollments", async () => {
    const { workspace, active, revoked } = await workerFixture();
    const pair = (pairingId: string, target: { kind: "worker"; workerId: string }, w = workspace) =>
      call(people.owner).e2ee.createWorkerPairing({
        workspace: w,
        pairingId,
        sealedSecret: bytes(100),
        target,
      });
    const keyless = await newWorkspace();
    await expect(
      pair(keyId(60), { kind: "worker", workerId: active }, keyless),
    ).rejects.toMatchObject(invalid);
    await expect(pair(keyId(60), { kind: "worker", workerId: revoked })).rejects.toMatchObject(
      invalid,
    );
    await expect(
      call(people.owner).e2ee.createWorkerPairing({
        workspace,
        pairingId: keyId(60),
        sealedSecret: bytes(100),
        target: { kind: "enrollment", enrollmentId: "unknown" },
      }),
    ).rejects.toMatchObject(invalid);
    const { expiresAt } = await pair(keyId(60), { kind: "worker", workerId: active });
    expect(expiresAt).toBeGreaterThan(Date.now());
    await expect(pair(keyId(60), { kind: "worker", workerId: active })).rejects.toMatchObject(
      invalid,
    );
    expect(await call(people.owner).e2ee.workerPairings({ workspace })).toEqual([
      { pairingId: keyId(60), workerId: active, sealedSecret: bytes(100), expiresAt },
    ]);
  });

  it("publish checks the self-signature; rosters certify only an active Worker's current keys", async () => {
    const { workspace, active, scope } = await workerFixture();
    const pairingId = keyId(61);
    await call(people.owner).e2ee.createWorkerPairing({
      workspace,
      pairingId,
      sealedSecret: bytes(100),
      target: { kind: "worker", workerId: active },
    });
    const { input, fingerprint: listed } = await keySet(scope, pairingId);
    const forged = (await keySet(scope, pairingId)).input;
    for (const bad of [
      { ...input, encryptionPublicKey: forged.encryptionPublicKey },
      { ...input, selfSignature: forged.selfSignature },
      { ...input, pairingId: keyId(62) },
    ]) {
      await expect(publishWorkerKeys(db(), scope, bad)).rejects.toMatchObject(invalid);
    }
    await publishWorkerKeys(db(), scope, input);
    // A retry with identical keys is a no-op; the same key id with other keys is refused.
    await publishWorkerKeys(db(), scope, input);
    await expect(
      publishWorkerKeys(db(), scope, { ...input, pairingMac: forged.pairingMac }),
    ).rejects.toMatchObject(invalid);
    expect(await call(people.member).e2ee.workerKeys({ workspace })).toMatchObject([
      { workerId: active, keyId: input.keyId, pairingId },
    ]);
    // Published but not yet listed: not dispatchable.
    await expect(requireDispatchableWorker(db(), workspace, active)).rejects.toMatchObject({
      message: "WORKER_NOT_PAIRED",
    });

    const entry = { workerId: active, keyId: input.keyId, fingerprint: listed };
    let version = 2;
    for (const bad of [
      { ...entry, keyId: keyId(63) },
      { ...entry, fingerprint: "0000 0000 0000 0000 0000 0000 0000 0000" },
      { ...entry, workerId: "unknown" },
    ]) {
      await expect(
        call(people.owner).e2ee.publishRoster({
          workspace,
          roster: await roster(workspace, version, 1, { v: 2, workers: [bad] }),
        }),
      ).rejects.toMatchObject(invalid);
    }
    await call(people.owner).e2ee.publishRoster({
      workspace,
      roster: await roster(workspace, version++, 1, { v: 2, workers: [entry] }),
    });
    expect((await requireDispatchableWorker(db(), workspace, active))?.keyId).toBe(input.keyId);
    // Certification consumed the pairing secret.
    expect(await call(people.owner).e2ee.workerPairings({ workspace })).toEqual([]);

    // Revocation applies before the owner signs a roster without the Worker.
    await db().update(workers).set({ status: "revoked" }).where(eq(workers.id, active));
    await expect(requireDispatchableWorker(db(), workspace, active)).rejects.toMatchObject({
      message: "WORKER_NOT_PAIRED",
    });
    expect(await call(people.member).e2ee.workerKeys({ workspace })).toEqual([]);
    await expect(
      call(people.owner).e2ee.publishRoster({
        workspace,
        roster: await roster(workspace, version, 1, { v: 2, workers: [entry] }),
      }),
    ).rejects.toMatchObject(invalid);
  });

  it("a setup-code pairing binds to the Worker its enrollment produced", async () => {
    const { workspace, scope } = await workerFixture();
    const [enrollment] = await db()
      .insert(workerEnrollments)
      .values({
        workspace,
        tokenHash: toBase64Url(randomBytes(32)),
        name: "setup",
        capabilities: [],
        expiresAt: new Date(Date.now() + 60_000),
        state: "pending",
      })
      .returning();
    const pairingId = keyId(64);
    await call(people.owner).e2ee.createWorkerPairing({
      workspace,
      pairingId,
      sealedSecret: bytes(100),
      target: { kind: "enrollment", enrollmentId: enrollment!.id },
    });
    const { input } = await keySet(scope, pairingId);
    // Not completed by this Worker (yet): refused.
    await expect(publishWorkerKeys(db(), scope, input)).rejects.toMatchObject(invalid);
    await db()
      .update(workerEnrollments)
      .set({
        state: "completed",
        completionWorker: scope.workerId,
        completionKey: scope.keyId,
        completionRequestId: "request",
      })
      .where(eq(workerEnrollments.id, enrollment!.id));
    await publishWorkerKeys(db(), scope, input);
    expect(await call(people.owner).e2ee.workerPairings({ workspace })).toMatchObject([
      { pairingId, workerId: scope.workerId },
    ]);
  });

  it("dispatch is the keyless path in a keyless workspace", async () => {
    const workspace = await newWorkspace();
    const [worker] = await db()
      .insert(workers)
      .values({ workspace, name: "a", capabilities: [], status: "active", identityEpoch: 1 })
      .returning();
    expect(await requireDispatchableWorker(db(), workspace, worker!.id)).toBeNull();
    await expect(requireDispatchableWorker(db(), "unknown", worker!.id)).rejects.toMatchObject({
      message: "WORKER_NOT_PAIRED",
    });
  });
});

describe("retention", () => {
  it("prunes expired links and pairing secrets past their retention only", async () => {
    const workspace = await keyedWorkspace();
    const [worker] = await db()
      .insert(workers)
      .values({ workspace, name: "a", capabilities: [], status: "active", identityEpoch: 1 })
      .returning();
    const now = Date.now();
    await db()
      .insert(e2eeInvites)
      .values(
        [
          { id: keyId(70), invitedUserId: people.member.id, expiresAt: new Date(now - 1) },
          { id: keyId(71), invitedUserId: people.other.id, expiresAt: new Date(now + 60_000) },
        ].map((invite) => ({
          workspace,
          inviteId: invite.id,
          invitedUserId: invite.invitedUserId,
          epoch: 1,
          sealed: new Uint8Array(1),
          ownerSecret: new Uint8Array(1),
          createdBy: people.owner.id,
          expiresAt: invite.expiresAt,
        })),
      );
    await db()
      .insert(e2eeWorkerPairings)
      .values(
        [now - WORKER_PAIRING_RETENTION_MS - 1, now - 1].map((expiresAt, index) => ({
          workspace,
          pairingId: keyId(72 + index),
          ownerUserId: people.owner.id,
          worker: worker!.id,
          sealedSecret: new Uint8Array(1),
          expiresAt: new Date(expiresAt),
        })),
      );
    expect(await pruneExpiredInvites(db(), now, 500)).toBe(1);
    expect(await pruneWorkerPairings(db(), now, 500)).toBe(1);
    expect(
      (await db().select().from(e2eeInvites).where(eq(e2eeInvites.workspace, workspace))).map(
        (row) => row.inviteId,
      ),
    ).toEqual([keyId(71)]);
    expect(
      (
        await db()
          .select()
          .from(e2eeWorkerPairings)
          .where(eq(e2eeWorkerPairings.workspace, workspace))
      ).map((row) => row.pairingId),
    ).toEqual([keyId(73)]);
  });
});
