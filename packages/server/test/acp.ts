import { eq } from "drizzle-orm";
import {
  acpBindingStatement,
  acpCommandStatement,
  CAPSULE_BYTES,
  fingerprint,
  generateEncryptionKeyPair,
  randomBytes,
  sign,
  signingPublicKeyFromSeed,
  toBase64Url,
} from "radium-crypto";
import type { AcpAgentReport } from "contracts/acp/contract";
import { acpSessions } from "../src/acp/schema";
import { chatMembers, chats } from "../src/chatroom/schema";
import {
  e2eeChatKeys,
  e2eeIdentities,
  e2eeRosters,
  e2eeWorkerKeys,
  e2eeWorkspaceEpochs,
} from "../src/e2ee/schema";
import type { Runtime } from "../src/runtime";
import { appRouter } from "../src/trpc/router";
import type { WorkerIdentity } from "../src/worker/signing";
import { workspaceMembers, workspaces } from "../src/workspaces/schema";
import type { TestRuntime } from "./runtime";
import { classicUser } from "./users";
import { insertWorker, machineCaller } from "./workers";

/*
 * ACP test fixtures: a keyed workspace whose users have signing identities, a Worker the newest
 * roster certifies, keyed ACP chats with a creator-signed binding, and the signatures browsers
 * would send. Rows are written the way the owning domains would write them.
 */

export type Role = "owner" | "member" | "other" | "outsider";
export const ROLES = ["owner", "member", "other", "outsider"] as const;
export type Scope = "personal" | "shared" | "workspace";
export type Users = Record<Role, { id: string; headers: Headers }>;

export const keyId = (fill: number) => toBase64Url(new Uint8Array(16).fill(fill));
export const seeds: Record<Role, Uint8Array> = {
  owner: new Uint8Array(32).fill(1),
  member: new Uint8Array(32).fill(2),
  other: new Uint8Array(32).fill(3),
  outsider: new Uint8Array(32).fill(4),
};
export const identityKey: Record<Role, string> = {
  owner: keyId(1),
  member: keyId(2),
  other: keyId(3),
  outsider: keyId(4),
};
export const CHAT_PUBLIC_KEY = new Uint8Array(1216).fill(9);

/** A sealed box stand-in: the backend only bounds and stores it. */
export const sealed = (size = CAPSULE_BYTES + 64) => toBase64Url(randomBytes(size));

/** The acp agent every fixture Worker reports. */
export const agentReport = (overrides: Partial<AcpAgentReport> = {}): AcpAgentReport => ({
  agentId: "test-agent",
  name: "Test agent",
  version: "1",
  source: "custom",
  status: "ready",
  capabilities: {
    loadSession: true,
    list: true,
    resume: true,
    close: true,
    delete: true,
    fork: true,
    logout: true,
    image: false,
    audio: false,
    embeddedContext: false,
    mcpHttp: false,
    mcpSse: false,
  },
  authMethods: [{ id: "browser", name: "Browser", type: "agent" }],
  ...overrides,
});

/** One account per role, each with an active signing identity. */
export async function acpUsers(runtime: Runtime, prefix: string): Promise<Users> {
  const users = {} as Users;
  // A real public key, so notification sealing to these identities works.
  const { publicKey } = await generateEncryptionKeyPair();
  for (const role of ROLES) {
    users[role] = await classicUser(runtime, `${prefix}-${role}@example.test`);
    await runtime.drivers.db.insert(e2eeIdentities).values({
      userId: users[role].id,
      keyId: identityKey[role],
      suite: 1,
      encryptionPublicKey: publicKey,
      signingPublicKey: await signingPublicKeyFromSeed(seeds[role]),
      secrets: new Uint8Array(1),
      selfSignature: new Uint8Array(64),
      recoveryWrapper: new Uint8Array(1),
      status: "active",
    });
  }
  return users;
}

/** Certifies `workers` in a new roster version of `workspace` (signature not checked on read). */
export async function certify(runtime: Runtime, workspace: string, workers: WorkerIdentity[], version: number) {
  const db = runtime.drivers.db;
  const entries = [];
  for (const [index, worker] of workers.entries()) {
    const encryptionPublicKey = new Uint8Array(1216).fill(30 + index);
    const signingPublicKey = new Uint8Array(32).fill(30 + index);
    const workerKeyId = keyId(60 + version * 8 + index);
    await db
      .insert(e2eeWorkerKeys)
      .values({
        worker: worker.workerId,
        keyId: workerKeyId,
        suite: 1,
        encryptionPublicKey,
        signingPublicKey,
        selfSignature: new Uint8Array(64),
        pairingMac: new Uint8Array(32),
        pairingId: keyId(90),
      })
      .onConflictDoUpdate({ target: e2eeWorkerKeys.worker, set: { keyId: workerKeyId } });
    entries.push({
      workerId: worker.workerId,
      keyId: workerKeyId,
      fingerprint: await fingerprint({ encryptionPublicKey, signingPublicKey }),
    });
  }
  await db.insert(e2eeRosters).values({
    workspace,
    version,
    body: new TextEncoder().encode(JSON.stringify({ v: 2, workers: entries, members: [] })),
    signature: new Uint8Array(64),
    signerKeyId: identityKey.owner,
  });
}

/** A keyed workspace of `users.owner` with `member` and `other`, and one certified Worker. */
export async function acpWorkspace(runtime: Runtime, users: Users, options: { archived?: boolean } = {}) {
  const db = runtime.drivers.db;
  const [row] = await db
    .insert(workspaces)
    .values({
      ownerId: users.owner.id,
      name: "ACP",
      keyEpoch: 1,
      archivedAt: options.archived ? new Date() : null,
    })
    .returning();
  const workspace = row!.id;
  await db.insert(workspaceMembers).values([
    { workspace, userId: users.member.id, role: "member" },
    { workspace, userId: users.other.id, role: "member" },
  ]);
  await db.insert(e2eeWorkspaceEpochs).values({
    workspace,
    epoch: 1,
    suite: 1,
    memberKeyId: keyId(11),
    memberPublicKey: new Uint8Array(1216),
    ownerKeyId: keyId(21),
    ownerPublicKey: new Uint8Array(1216),
    createdBy: users.owner.id,
    createdAt: new Date(Date.now() - 24 * 60 * 60_000),
  });
  const worker = await insertWorker(runtime, workspace);
  await certify(runtime, workspace, [worker], 1);
  const machine = await machineCaller(runtime, worker);
  return { workspace, worker, machine };
}

/** The binding statement signature of a chat as its creator signs it. */
export async function bindingSignature(
  creator: Role,
  users: Users,
  values: {
    workspace: string;
    chat: string;
    e2eeId: string;
    worker: string;
    agentId?: string;
    cwd?: string;
    scope: Scope;
    members: string[];
    version: number;
  },
) {
  const signature = await sign(
    seeds[creator],
    acpBindingStatement({
      workspaceId: values.workspace,
      chatId: values.chat,
      chatE2eeId: values.e2eeId,
      creatorUserId: users[creator].id,
      workerId: values.worker,
      agentId: values.agentId ?? "test-agent",
      profile: "native",
      cwd: values.cwd ?? "/work",
      scope: values.scope,
      members: values.members,
      version: values.version,
    }),
  );
  return {
    version: values.version,
    scope: values.scope,
    members: values.members,
    signerKeyId: identityKey[creator],
    signature: toBase64Url(signature),
  };
}

let e2eeIds = 100;

/**
 * A keyed ACP chat of `creator` bound to `test-agent` on the fixture Worker, with a stored chat
 * key epoch one and (by default) the creator's published binding version 1.
 */
export async function acpChat(
  runtime: Runtime,
  users: Users,
  fixture: { workspace: string; worker: WorkerIdentity },
  creator: Role,
  options: {
    scope?: Scope;
    members?: Role[];
    bound?: boolean;
    sessionId?: string;
    status?: "idle" | "running" | "awaiting" | "starting" | "failed" | "ended";
    turnBy?: Role;
  } = {},
) {
  const db = runtime.drivers.db;
  const scope = options.scope ?? "personal";
  const e2eeId = keyId(++e2eeIds % 250);
  const [chat] = await db
    .insert(chats)
    .values({ workspace: fixture.workspace, userId: users[creator].id, scope, e2eeId, keyEpoch: 1 })
    .returning();
  const members = (options.members ?? []).map((role) => users[role].id);
  for (const userId of members) {
    await db.insert(chatMembers).values({
      chat: chat!.id,
      workspace: fixture.workspace,
      userId,
      lastInteractionAt: new Date(),
    });
  }
  await db.insert(e2eeChatKeys).values({
    chat: chat!.id,
    epoch: 1,
    keyId: keyId(200),
    suite: 1,
    publicKey: CHAT_PUBLIC_KEY,
  });
  const binding =
    options.bound === false
      ? null
      : await bindingSignature(creator, users, {
          workspace: fixture.workspace,
          chat: chat!.id,
          e2eeId,
          worker: fixture.worker.workerId,
          scope,
          members,
          version: 1,
        });
  const [session] = await db
    .insert(acpSessions)
    .values({
      chat: chat!.id,
      workspace: fixture.workspace,
      worker: fixture.worker.workerId,
      agentId: "test-agent",
      agentVersion: "1",
      cwd: "/work",
      sessionId: options.sessionId ?? null,
      sessionProof: options.sessionId
        ? { kind: "worker", signature: toBase64Url(new Uint8Array(64)) }
        : null,
      status: options.status ?? "idle",
      binding,
      turnBy: options.turnBy ? users[options.turnBy].id : null,
      updatedAt: new Date(),
    })
    .returning();
  return { chat: chat!.id, e2eeId, session: session! };
}

/** A command as a browser seals and signs it (the payload is random bytes). */
export async function signedCommand(
  role: Role,
  values: { workspace: string; worker: string; chat: string; kind: string; clientId: string },
) {
  const payload = randomBytes(CAPSULE_BYTES + 64);
  const signature = await sign(
    seeds[role],
    acpCommandStatement({
      workspaceId: values.workspace,
      workerId: values.worker,
      chatId: values.chat,
      kind: values.kind,
      clientId: values.clientId,
      payload,
    }),
  );
  return {
    clientId: values.clientId,
    payload: toBase64Url(payload),
    signature: toBase64Url(signature),
    signerKeyId: identityKey[role],
  };
}

/** The current `acp_sessions` row of `chat`. */
export async function sessionOf(runtime: Runtime, chat: string) {
  const [row] = await runtime.drivers.db.select().from(acpSessions).where(eq(acpSessions.chat, chat));
  return row!;
}

/** A tRPC caller for a signed-in user. */
export const userCaller = (test: TestRuntime, headers: Headers) =>
  appRouter.createCaller({ runtime: test.runtime, headers });
