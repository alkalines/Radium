import { and, count, eq } from "drizzle-orm";
import { legacyAad } from "contracts/e2ee/legacy-contract";
import {
  generateEncryptionKeyPair,
  grantStatement,
  rosterStatement,
  sealBox,
  sign,
  signingPublicKeyFromSeed,
  toBase64Url,
  utf8,
} from "radium-crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestRuntime, type TestRuntime } from "../../test/runtime";
import { classicUser } from "../../test/users";
import { chatMembers, chats } from "../chatroom/schema";
import {
  e2eeIdentities,
  e2eeInvites,
  e2eeJoinRequests,
  e2eeRosters,
  e2eeWorkspaceEpochs,
} from "../e2ee/schema";
import { insertWorkspaceEpoch, workspaceKeysInput } from "../e2ee/workspace-keys";
import { appRouter } from "../trpc/router";
import { workers } from "../worker/schema";
import { projectFolders, projects, workspaceMembers, workspaces } from "./schema";
import { lockWorkspace } from "./workspaces";

// The workspaces slice through the real router: authorization boundaries (owner, member,
// outsider, archived), the invariants that relied on Convex serializing mutations, and member
// removal with its atomic key rotation.

type Role = "owner" | "member" | "outsider";

let test: TestRuntime;
const users = {} as Record<Role, { id: string; headers: Headers }>;
let workspace = "";

const call = (role: Role | Headers) =>
  appRouter.createCaller({
    runtime: test.runtime,
    headers: role instanceof Headers ? role : users[role].headers,
  });
const db = () => test.runtime.drivers.db;

const seeds: Record<Role, Uint8Array> = {
  owner: new Uint8Array(32).fill(1),
  member: new Uint8Array(32).fill(2),
  outsider: new Uint8Array(32).fill(3),
};
const keyId = (fill: number) => toBase64Url(new Uint8Array(16).fill(fill));
const identityKey: Record<Role, string> = { owner: keyId(1), member: keyId(2), outsider: keyId(3) };
const b64 = (n: number) => toBase64Url(new Uint8Array(n).fill(7));
let memberKeys: Awaited<ReturnType<typeof generateEncryptionKeyPair>>;

/** A fresh signed-in account with no workspace. */
let accounts = 0;
async function freshUser() {
  accounts += 1;
  return await classicUser(test.runtime, `fresh${accounts}@example.test`);
}

async function addWorkspace(ownerId: string, values: Partial<typeof workspaces.$inferInsert> = {}) {
  const [row] = await db()
    .insert(workspaces)
    .values({ ownerId, name: "Workspace", ...values })
    .returning();
  return row!;
}

/** Owner-signed epoch `epoch` of `workspaceId` with the owner's two grants (wire form). */
async function rotation(workspaceId: string, epoch: number) {
  const grant = async (purpose: "member" | "owner") => {
    const sealed = new Uint8Array(1200).fill(epoch);
    const signature = await sign(
      seeds.owner,
      grantStatement({
        workspaceId,
        epoch,
        purpose,
        recipientUserId: users.owner.id,
        recipientKeyId: identityKey.owner,
        sealed,
      }),
    );
    return {
      epoch,
      purpose,
      userId: users.owner.id,
      recipientKeyId: identityKey.owner,
      granterKeyId: identityKey.owner,
      sealed: toBase64Url(sealed),
      signature: toBase64Url(signature),
    };
  };
  const body = utf8(
    JSON.stringify({
      v: 1,
      workspace: workspaceId,
      version: epoch,
      epoch,
      owner: { userId: users.owner.id, keyId: identityKey.owner, fingerprint: "owner" },
      epochs: [],
      members: [],
    }),
  );
  return {
    epoch: {
      epoch,
      suite: 1,
      memberKeyId: keyId(10 + epoch),
      memberPublicKey: toBase64Url(memberKeys.publicKey),
      ownerKeyId: keyId(20 + epoch),
      ownerPublicKey: toBase64Url(memberKeys.publicKey),
    },
    grants: [await grant("member"), await grant("owner")],
    roster: {
      version: epoch,
      body: toBase64Url(body),
      signature: toBase64Url(
        await sign(seeds.owner, rosterStatement({ workspaceId, body })),
      ),
      signerKeyId: identityKey.owner,
    },
  };
}

/** Gives `workspaceId` its first key epoch, as the E2EE bootstrap does. */
async function bootstrapKeys(workspaceId: string) {
  const keys = workspaceKeysInput.parse(await rotation(workspaceId, 1));
  await db().transaction(async (tx) =>
    insertWorkspaceEpoch(tx, await lockWorkspace(tx, workspaceId), keys),
  );
}

beforeAll(async () => {
  test = await createTestRuntime();
  memberKeys = await generateEncryptionKeyPair();
  for (const role of ["owner", "member", "outsider"] as const) {
    users[role] = await classicUser(test.runtime, `${role}@example.test`);
    await db()
      .insert(e2eeIdentities)
      .values({
        userId: users[role].id,
        keyId: identityKey[role],
        suite: 1,
        encryptionPublicKey: memberKeys.publicKey,
        signingPublicKey: await signingPublicKeyFromSeed(seeds[role]),
        secrets: new Uint8Array(1),
        selfSignature: new Uint8Array(64),
        recoveryWrapper: new Uint8Array(1),
        status: "active",
      });
  }
  workspace = (await addWorkspace(users.owner.id, { name: "Team" })).id;
  await db()
    .insert(workspaceMembers)
    .values({ workspace, userId: users.member.id, role: "member" });
});

afterAll(async () => {
  await test?.close();
});

describe("workspaces", () => {
  it("lists owned and shared workspaces with the caller's role, never another user's", async () => {
    expect(await call("owner").workspaces.list()).toContainEqual(
      expect.objectContaining({ id: workspace, role: "owner" }),
    );
    expect(await call("member").workspaces.list()).toEqual([
      expect.objectContaining({ id: workspace, role: "member" }),
    ]);
    expect(await call("outsider").workspaces.list()).toEqual([]);
    await expect(call(new Headers()).workspaces.list()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  it("provisions exactly one personal workspace when several tabs ask at once", async () => {
    const fresh = await freshUser();
    const ids = await Promise.all(
      Array.from({ length: 5 }, () => call(fresh.headers).workspaces.ensurePersonal()),
    );
    expect(new Set(ids).size).toBe(1);
    const [owned] = await db()
      .select({ count: count() })
      .from(workspaces)
      .where(eq(workspaces.ownerId, fresh.id));
    expect(owned!.count).toBe(1);
    // An existing workspace is returned, not duplicated.
    expect(await call(fresh.headers).workspaces.ensurePersonal()).toBe(ids[0]);
  });

  it("lets only the owner change the color, and only to a supported color", async () => {
    await call("owner").workspaces.setColor({ workspace, color: "blue" });
    await expect(
      call("owner").workspaces.setColor({ workspace, color: "no-such-color" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "Unsupported workspace color." });
    for (const role of ["member", "outsider"] as const) {
      await expect(
        call(role).workspaces.setColor({ workspace, color: "red" }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    const [row] = await db().select().from(workspaces).where(eq(workspaces.id, workspace));
    expect(row!.color).toBe("blue");
  });

  it("archives only an empty workspace, hides it, and restores it for its owner alone", async () => {
    const fresh = await freshUser();
    const kept = await addWorkspace(fresh.id);
    const target = await addWorkspace(fresh.id);
    await db().insert(workspaceMembers).values({
      workspace: target.id,
      userId: users.member.id,
      role: "member",
    });
    const [chat] = await db()
      .insert(chats)
      .values({ workspace: target.id, userId: fresh.id })
      .returning();
    await expect(
      call(fresh.headers).workspaces.archive({ workspace: target.id }),
    ).rejects.toMatchObject({ message: "Delete or move this workspace's chats first." });
    await db().delete(chats).where(eq(chats.id, chat!.id));

    await call(fresh.headers).workspaces.archive({ workspace: target.id });
    expect((await call(fresh.headers).workspaces.list()).map((item) => item.id)).toEqual([kept.id]);
    expect(
      (await call(fresh.headers).workspaces.listArchived()).map((item) => item.id),
    ).toEqual([target.id]);
    // Members lose access while it is archived and never see it in the archive list.
    expect((await call("member").workspaces.list()).map((item) => item.id)).not.toContain(
      target.id,
    );
    expect(await call("member").workspaces.listArchived()).toEqual([]);
    await expect(
      call("member").projects.list({ workspace: target.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    for (const role of ["member", "outsider"] as const) {
      await expect(
        call(role).workspaces.restore({ workspace: target.id }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    await call(fresh.headers).workspaces.restore({ workspace: target.id });
    expect((await call("member").workspaces.list()).map((item) => item.id)).toContain(target.id);
  });

  it("keeps one active workspace when two archives race", async () => {
    const fresh = await freshUser();
    const pair = [await addWorkspace(fresh.id), await addWorkspace(fresh.id)];
    const results = await Promise.allSettled(
      pair.map((item) => call(fresh.headers).workspaces.archive({ workspace: item.id })),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: { message: "Keep at least one active workspace." },
    });
    expect(await call(fresh.headers).workspaces.list()).toHaveLength(1);
  });
});

describe("members", () => {
  it("are listed and managed by the owner only", async () => {
    expect(await call("owner").workspaces.listMembers({ workspace })).toEqual([
      { userId: users.owner.id, email: "owner@example.test", name: "owner@example.test", role: "owner" },
      { userId: users.member.id, email: "member@example.test", name: "member@example.test", role: "member" },
    ]);
    for (const role of ["member", "outsider"] as const) {
      await expect(call(role).workspaces.listMembers({ workspace })).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      await expect(
        call(role).workspaces.addMember({ workspace, email: "outsider@example.test" }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
  });

  it("are added by email, case-insensitively and idempotently; the owner is implicit", async () => {
    const team = await addWorkspace(users.owner.id);
    const first = await call("owner").workspaces.addMember({
      workspace: team.id,
      email: "  Outsider@Example.TEST ",
    });
    expect(
      await call("owner").workspaces.addMember({ workspace: team.id, email: "outsider@example.test" }),
    ).toBe(first);
    await expect(
      call("owner").workspaces.addMember({ workspace: team.id, email: "owner@example.test" }),
    ).rejects.toMatchObject({ message: "The workspace owner is implicit." });
    await expect(
      call("owner").workspaces.addMember({ workspace: team.id, email: "nobody@example.test" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: "User not found." });
    expect((await call("outsider").workspaces.list()).map((item) => item.id)).toEqual([team.id]);
    await call("owner").workspaces.removeMember({ workspace: team.id, email: "outsider@example.test" });
    expect(await call("outsider").workspaces.list()).toEqual([]);
  });

  it("removal from a keyed workspace rotates keys, revokes chat access and clears joins atomically", async () => {
    const team = await addWorkspace(users.owner.id);
    await db()
      .insert(workspaceMembers)
      .values({ workspace: team.id, userId: users.member.id, role: "member" });
    await bootstrapKeys(team.id);
    const [ownerShared, memberShared, memberPersonal] = await db()
      .insert(chats)
      .values([
        { workspace: team.id, userId: users.owner.id, scope: "shared" },
        { workspace: team.id, userId: users.member.id, scope: "shared" },
        { workspace: team.id, userId: users.member.id, scope: "personal" },
      ])
      .returning();
    await db().insert(chatMembers).values({
      chat: ownerShared!.id,
      workspace: team.id,
      userId: users.member.id,
      lastInteractionAt: new Date(),
    });
    await db().insert(e2eeInvites).values({
      workspace: team.id,
      inviteId: keyId(40),
      invitedUserId: users.member.id,
      epoch: 1,
      sealed: new Uint8Array(8),
      ownerSecret: new Uint8Array(8),
      createdBy: users.owner.id,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await db()
      .insert(e2eeJoinRequests)
      .values({ workspace: team.id, userId: users.member.id, keyId: identityKey.member, source: "request" });

    const remove = (rotationInput?: Awaited<ReturnType<typeof rotation>>) =>
      call("owner").workspaces.removeMember({
        workspace: team.id,
        email: "member@example.test",
        rotation: rotationInput,
      });
    await expect(remove()).rejects.toMatchObject({ message: "E2EE_KEYS_INVALID" });
    // Nothing changed on the refusal.
    expect(await call("member").projects.list({ workspace: team.id })).toEqual([]);

    // Two owner devices remove at once with the same next epoch: exactly one rotation lands.
    const next = await rotation(team.id, 2);
    const results = await Promise.allSettled([remove(next), remove(next)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);

    await expect(call("member").projects.list({ workspace: team.id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    const [row] = await db().select().from(workspaces).where(eq(workspaces.id, team.id));
    expect(row!.keyEpoch).toBe(2);
    expect(
      await db().select().from(e2eeRosters).where(eq(e2eeRosters.workspace, team.id)),
    ).toHaveLength(2);
    expect(await db().select().from(chatMembers).where(eq(chatMembers.workspace, team.id))).toEqual([]);
    const flags = new Map(
      (await db().select().from(chats).where(eq(chats.workspace, team.id))).map((chat) => [
        chat.id,
        chat.rekey,
      ]),
    );
    expect(flags.get(ownerShared!.id)).toBe(true);
    expect(flags.get(memberShared!.id)).toBe(true);
    expect(flags.get(memberPersonal!.id)).toBe(false);
    expect(await db().select().from(e2eeInvites).where(eq(e2eeInvites.workspace, team.id))).toEqual([]);
    expect(
      await db().select().from(e2eeJoinRequests).where(eq(e2eeJoinRequests.workspace, team.id)),
    ).toEqual([]);
  });

  it("refuses a rotation for a keyless workspace and a forged roster signature", async () => {
    const keyless = await addWorkspace(users.owner.id);
    await expect(
      call("owner").workspaces.removeMember({
        workspace: keyless.id,
        email: "member@example.test",
        rotation: await rotation(keyless.id, 1),
      }),
    ).rejects.toMatchObject({ message: "E2EE_KEYS_INVALID" });

    const keyed = await addWorkspace(users.owner.id);
    await bootstrapKeys(keyed.id);
    const forged = await rotation(keyed.id, 2);
    forged.roster.signature = b64(64);
    await expect(
      call("owner").workspaces.removeMember({
        workspace: keyed.id,
        email: "member@example.test",
        rotation: forged,
      }),
    ).rejects.toMatchObject({ message: "E2EE_KEYS_INVALID" });
    const epochs = await db()
      .select()
      .from(e2eeWorkspaceEpochs)
      .where(eq(e2eeWorkspaceEpochs.workspace, keyed.id));
    expect(epochs.map((epoch) => epoch.epoch)).toEqual([1]);
  });
});

describe("sealed names", () => {
  const seal = async (table: "workspaces" | "projects", record: string, owner: string) => ({
    kind: "workspace_member" as const,
    keyId: keyId(11),
    epoch: 1,
    box: toBase64Url(
      await sealBox({
        recipientPublicKey: memberKeys.publicKey,
        plaintext: utf8(JSON.stringify({ name: "Private", icon: "folder" })),
        aad: legacyAad(table, record, owner),
        pad: "content",
      }),
    ),
  });

  it("store only ciphertext, compare-and-swap, and follow write authority", async () => {
    const team = await addWorkspace(users.owner.id);
    await db()
      .insert(workspaceMembers)
      .values({ workspace: team.id, userId: users.member.id, role: "member" });
    const content = await seal("workspaces", team.id, team.id);

    await expect(
      call("member").workspaces.setName({ workspace: team.id, content, expected: null }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    // A keyless workspace has no member key to seal to.
    await expect(
      call("owner").workspaces.setName({ workspace: team.id, content, expected: null }),
    ).rejects.toMatchObject({ message: "Encrypted name requires the current workspace member key" });

    await bootstrapKeys(team.id);
    await expect(
      call("owner").workspaces.setName({
        workspace: team.id,
        content: { ...content, epoch: 2 },
        expected: null,
      }),
    ).rejects.toMatchObject({ message: "Encrypted name requires the current workspace member key" });
    await call("owner").workspaces.setName({ workspace: team.id, content, expected: null });
    await expect(
      call("owner").workspaces.setName({ workspace: team.id, content, expected: null }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const current = await call("member").workspaces.sealedName({ workspace: team.id });
    expect(current).toMatchObject({ name: "Workspace", icon: null });
    expect(current.legacyContent?.box).toBe(content.box);
    await call("owner").workspaces.setName({
      workspace: team.id,
      content: await seal("workspaces", team.id, team.id),
      expected: current.legacyContent,
    });

    // Members name their own Projects; the owner manages every Project.
    const project = await call("member").projects.create({ workspace: team.id });
    await call("member").projects.setName({
      project,
      content: await seal("projects", project, team.id),
      expected: null,
    });
    await expect(
      call("outsider").projects.setName({
        project,
        content: await seal("projects", project, team.id),
        expected: null,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const [stored] = await db().select().from(projects).where(eq(projects.id, project));
    expect(stored).toMatchObject({ name: "Project", icon: null });
  });
});

describe("projects", () => {
  let team = "";
  const worker = { active: "", revoked: "", foreign: "" };

  beforeAll(async () => {
    team = (await addWorkspace(users.owner.id)).id;
    await db()
      .insert(workspaceMembers)
      .values({ workspace: team, userId: users.member.id, role: "member" });
    const other = await addWorkspace(users.outsider.id);
    const rows = await db()
      .insert(workers)
      .values([
        { workspace: team, name: "a", capabilities: [], status: "active", identityEpoch: 0 },
        { workspace: team, name: "b", capabilities: [], status: "revoked", identityEpoch: 1 },
        { workspace: other.id, name: "c", capabilities: [], status: "active", identityEpoch: 0 },
      ])
      .returning();
    worker.active = rows[0]!.id;
    worker.revoked = rows[1]!.id;
    worker.foreign = rows[2]!.id;
  });

  it("are visible to members, folders only to the owner, management to creator and owner", async () => {
    const ownerProject = await call("owner").projects.create({
      workspace: team,
      color: "green",
      folders: [{ workerId: worker.active, directory: "/srv/app" }],
      defaultWorkerId: worker.active,
    });
    const memberProject = await call("member").projects.create({ workspace: team });

    const forOwner = await call("owner").projects.list({ workspace: team });
    expect(forOwner.find((item) => item.id === ownerProject)).toMatchObject({
      folders: [{ workerId: worker.active, directory: "/srv/app" }],
      defaultWorkerId: worker.active,
      canManage: true,
    });
    const forMember = await call("member").projects.list({ workspace: team });
    expect(forMember.find((item) => item.id === ownerProject)).toEqual(
      expect.not.objectContaining({ folders: expect.anything() }),
    );
    expect(forMember.find((item) => item.id === ownerProject)?.canManage).toBe(false);
    expect(forMember.find((item) => item.id === memberProject)?.canManage).toBe(true);
    await expect(call("outsider").projects.list({ workspace: team })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });

    await expect(
      call("member").projects.update({ project: ownerProject, color: "red" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(call("outsider").projects.remove({ project: memberProject })).rejects.toMatchObject(
      { code: "NOT_FOUND" },
    );
    await call("owner").projects.update({ project: memberProject, color: "red" });
    await expect(
      call("member").projects.update({
        project: memberProject,
        folders: [{ workerId: worker.active, directory: "/srv" }],
      }),
    ).rejects.toMatchObject({ message: "Only the workspace owner can set a Project folder." });
  });

  it("accept folders only on active Workers of the workspace, with a default among them", async () => {
    const project = await call("owner").projects.create({ workspace: team });
    const update = (change: object) =>
      call("owner").projects.update({ project, ...change });
    for (const workerId of [worker.revoked, worker.foreign, "no-such-worker"]) {
      await expect(
        update({ folders: [{ workerId, directory: "/srv" }] }),
      ).rejects.toMatchObject({ message: "Worker must be active in this workspace." });
    }
    await expect(update({ folders: [{ workerId: worker.active, directory: "srv" }] })).rejects.toMatchObject(
      { message: "Worker directory must be an absolute path on the Worker." },
    );
    await expect(update({ defaultWorkerId: worker.active })).rejects.toMatchObject({
      message: "The default Worker must have a Project folder.",
    });
    await update({ folders: [{ workerId: worker.active, directory: "/srv" }], defaultWorkerId: worker.active });
    // Removing the default's folder clears the default.
    await update({ folders: [] });
    expect(
      await db().select().from(projectFolders).where(eq(projectFolders.project, project)),
    ).toEqual([]);
  });

  it("keep a revoked Worker's unchanged folder editable around it", async () => {
    const project = await call("owner").projects.create({
      workspace: team,
      folders: [{ workerId: worker.active, directory: "/srv" }],
    });
    await db()
      .update(workers)
      .set({ status: "revoked" })
      .where(eq(workers.id, worker.active));
    try {
      await call("owner").projects.update({ project, color: "blue" });
      await call("owner").projects.update({
        project,
        folders: [{ workerId: worker.active, directory: "/srv" }],
      });
      await expect(
        call("owner").projects.update({
          project,
          folders: [{ workerId: worker.active, directory: "/elsewhere" }],
        }),
      ).rejects.toMatchObject({ message: "Worker must be active in this workspace." });
    } finally {
      await db().update(workers).set({ status: "active" }).where(eq(workers.id, worker.active));
    }
  });

  it("detach their chats on removal and never delete them", async () => {
    const project = await call("member").projects.create({ workspace: team });
    const filed = await db()
      .insert(chats)
      .values(
        Array.from({ length: 3 }, () => ({ workspace: team, userId: users.member.id, project })),
      )
      .returning();
    await call("member").projects.remove({ project });
    const rows = await db()
      .select()
      .from(chats)
      .where(and(eq(chats.workspace, team), eq(chats.userId, users.member.id)));
    expect(rows.filter((row) => filed.some((chat) => chat.id === row.id))).toHaveLength(3);
    expect(rows.every((row) => row.project === null)).toBe(true);
  });
});

describe("model preferences", () => {
  it("pins and hides exclusively, deduplicated, per user", async () => {
    const owner = call("owner").preferences;
    await owner.setModelPinned({ model: "a", pinned: true });
    await owner.setModelPinned({ model: "a", pinned: true });
    await owner.setModelHidden({ model: "b", hidden: true });
    await owner.setModelHidden({ model: "a", hidden: true });
    expect(await owner.get()).toEqual({ pinnedModels: [], hiddenModels: ["b", "a"] });
    await owner.setModelPinned({ model: "a", pinned: true });
    expect(await owner.get()).toEqual({ pinnedModels: ["a"], hiddenModels: ["b"] });
    expect(await call("member").preferences.get()).toEqual({ pinnedModels: [], hiddenModels: [] });
    await expect(owner.setModelPinned({ model: "", pinned: true })).rejects.toMatchObject({
      message: "Invalid model.",
    });
  });

  it("keeps every change when tabs pin concurrently", async () => {
    const fresh = await freshUser();
    const models = Array.from({ length: 10 }, (_, index) => `model-${index}`);
    await Promise.all(
      models.map((model) => call(fresh.headers).preferences.setModelPinned({ model, pinned: true })),
    );
    expect((await call(fresh.headers).preferences.get()).pinnedModels.sort()).toEqual(models.sort());
  });
});
