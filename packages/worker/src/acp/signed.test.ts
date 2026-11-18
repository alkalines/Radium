import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  acpAgentDefinitionStatement,
  SUITE_1,
  acpAnswerStatement,
  acpBindingStatement,
  acpCommandStatement,
  chatKeyBindingStatement,
  chatKeyStatement,
  decodeCapsule,
  generateEncryptionKeyPair,
  generateSigningKeyPair,
  openBox,
  openCapsule,
  openWithCapsule,
  sealBox,
  sign,
  utf8,
  verify,
  workerObjectStatement,
  type ChatScopeName,
} from "radium-crypto";
import type {
  AcpAgentDefinition,
  AcpAgentReport,
  AcpAgentSessionEntry,
  AcpCommandPayload,
  AcpFrameInput,
  AcpInteractionAnswer,
  AcpInteractionRequest,
  AcpOp,
  AcpSignedBinding,
} from "backend/src/acp/contract";
import type { WorkerTrust } from "../e2ee/trust.js";
import { AcpHost } from "./host.js";
import { AcpSigned, arrayBuffer } from "./signed.js";
import type {
  AcpAnsweredInteraction,
  AcpAssignment,
  AcpChatE2ee,
  AcpChatKey,
  AcpClaim,
  AcpEpochCapsule,
  AcpSealedRequest,
  AcpSessionBinding,
  AcpSessionPatch,
  AcpTransport,
  AcpWarmSession,
} from "./transport.js";

const WORKSPACE = "workspace-1";
const WORKER_ID = "worker-1";
const CHAT = "chat";
const E2EE_ID = "e2ee-chat";

interface User {
  userId: string;
  keyId: string;
  role: "owner" | "member";
  sign: { seed: Uint8Array; publicKey: Uint8Array };
}

async function user(userId: string, role: User["role"]): Promise<User> {
  return { userId, keyId: `${userId}-key`, role, sign: await generateSigningKeyPair() };
}

/** Real keys for everyone involved; the creator is a plain member, so owner-only rules differ from it. */
async function environment() {
  const [owner, creator, member] = await Promise.all([
    user("owner-user", "owner"),
    user("creator-user", "member"),
    user("member-user", "member"),
  ]);
  return {
    owner,
    creator,
    member,
    worker: { enc: await generateEncryptionKeyPair(), sign: await generateSigningKeyPair() },
    ownerEnc: await generateEncryptionKeyPair(),
    chatKey: await generateEncryptionKeyPair(),
  };
}
type Environment = Awaited<ReturnType<typeof environment>>;

/** A `WorkerTrust` stand-in built from real keys: same verification contract, no backend. */
function fakeTrust(env: Environment): WorkerTrust {
  const users = new Map([env.owner, env.creator, env.member].map((entry) => [entry.keyId, entry]));
  const marks = new Map<string, number>();
  const pins = new Map<string, string>();
  const claims = new Map<string, number>();
  const trust = {
    workerId: WORKER_ID,
    workspaceId: WORKSPACE,
    keyId: "worker-key",
    encryptionSeed: () => env.worker.enc.seed.slice(),
    signObject: (parts: {
      table: string;
      parent: string;
      record: string;
      field: string;
      object: Uint8Array;
    }) =>
      sign(
        env.worker.sign.seed,
        workerObjectStatement({ workspaceId: WORKSPACE, workerId: WORKER_ID, ...parts }),
      ),
    verifyUser: async (input: {
      signerKeyId: string;
      message: Uint8Array;
      signature: Uint8Array;
    }) => {
      const signer = users.get(input.signerKeyId);
      if (!signer || !(await verify(signer.sign.publicKey, input.message, input.signature)))
        return null;
      return { userId: signer.userId, role: signer.role };
    },
    ownerPublicKey: async () => ({
      epoch: 1,
      keyId: "owner-epoch-key",
      publicKey: env.ownerEnc.publicKey,
    }),
    highWater: (name: string) => marks.get(name) ?? 0,
    advanceHighWater: async (name: string, value: number) => {
      marks.set(name, Math.max(marks.get(name) ?? 0, value));
    },
    claimOnce: async (name: string, expiresAt: number) => {
      if ((claims.get(name) ?? 0) > Date.now()) return false;
      claims.set(name, expiresAt);
      return true;
    },
    pin: async (name: string, value: string) => {
      if (!pins.has(name)) pins.set(name, value);
      return pins.get(name) === value;
    },
  };
  return trust as unknown as WorkerTrust;
}

async function signedBinding(
  env: Environment,
  input: {
    version?: number;
    scope?: ChatScopeName;
    members?: string[];
    signer?: User;
    chat?: string;
    e2eeId?: string;
    creator?: User;
  } = {},
): Promise<AcpSignedBinding> {
  const { version = 1, scope = "personal", members = [], signer = env.creator } = input;
  const signature = await sign(
    signer.sign.seed,
    acpBindingStatement({
      workspaceId: WORKSPACE,
      chatId: input.chat ?? CHAT,
      chatE2eeId: input.e2eeId ?? E2EE_ID,
      creatorUserId: (input.creator ?? env.creator).userId,
      workerId: WORKER_ID,
      agentId: "scripted",
      profile: "native",
      cwd: tmpdir(),
      scope,
      members,
      version,
    }),
  );
  return { version, scope, members, signerKeyId: signer.keyId, signature: arrayBuffer(signature) };
}

let commandCounter = 0;

async function signedCommand(
  env: Environment,
  payload: AcpCommandPayload,
  options: { signer?: User; issuedAt?: number } = {},
) {
  const { signer = env.creator, issuedAt = Date.now() } = options;
  const clientId = `client-${++commandCounter}`;
  const box = await sealBox({
    recipientPublicKey: env.worker.enc.publicKey,
    plaintext: utf8(JSON.stringify({ v: 1, issuedAt, command: payload })),
    aad: {
      table: "acp_commands",
      workspace: WORKSPACE,
      parent: CHAT,
      record: clientId,
      field: "payload",
    },
    pad: "content",
  });
  const signature = await sign(
    signer.sign.seed,
    acpCommandStatement({
      workspaceId: WORKSPACE,
      workerId: WORKER_ID,
      chatId: CHAT,
      kind: payload.kind,
      clientId,
      payload: box,
    }),
  );
  return {
    clientId,
    signed: {
      payload: arrayBuffer(box),
      signature: arrayBuffer(signature),
      signerKeyId: signer.keyId,
    },
  };
}

async function sealedAnswer(
  env: Environment,
  input: { requestKey: string; answer: AcpInteractionAnswer; signature: "valid" | "forged" },
) {
  const box = await sealBox({
    recipientPublicKey: env.worker.enc.publicKey,
    plaintext: utf8(JSON.stringify(input.answer)),
    aad: {
      table: "acp_interactions",
      workspace: WORKSPACE,
      parent: CHAT,
      record: input.requestKey,
      field: "answer",
    },
    pad: "content",
  });
  const message = acpAnswerStatement({
    workspaceId: WORKSPACE,
    workerId: WORKER_ID,
    chatId: CHAT,
    requestKey: input.requestKey,
    answer: box,
  });
  // A forged answer claims the creator's key ID but is signed by someone else.
  const seed = input.signature === "valid" ? env.creator.sign.seed : env.member.sign.seed;
  return {
    answer: arrayBuffer(box),
    signature: arrayBuffer(await sign(seed, message)),
    signerKeyId: env.creator.keyId,
  };
}

class SignedTransport implements AcpTransport {
  assignments: AcpAssignment[] = [];
  claims = new Map<string, AcpClaim>();
  receipts = new Map<string, { status: string; error?: string; result?: string }>();
  patches: AcpSessionPatch[] = [];
  frames: { epoch: number; frame: AcpFrameInput }[] = [];
  epochStarts: { epoch: number; capsule?: AcpEpochCapsule }[] = [];
  opened: { id: string; key: string; sealed?: AcpSealedRequest }[] = [];
  resolved: { interaction: string; status: string }[] = [];
  reopened: string[] = [];
  syncs: Parameters<AcpTransport["syncAgentSessions"]>[0][] = [];
  reports: AcpAgentReport[] = [];
  reportCount = 0;
  chatKeyCalls = 0;
  /** Everything the Worker wrote, for the "no plaintext reached Convex" check. */
  writes: unknown[] = [];
  warm = false;
  epoch = 0;
  chatKeyUnsigned = false;
  /** An epoch created before recipient binding: valid original signature, no binding. */
  chatKeyUnbound = false;
  chatKeyBound: Partial<{
    chatId: string;
    scope: ChatScopeName;
    creatorId: string;
    members: string[];
  }> = {};
  e2ee: AcpChatE2ee | null;
  binding: AcpSessionBinding = {
    agentId: "scripted",
    profile: "native",
    cwd: tmpdir(),
    sessionId: null,
    status: "idle",
    epoch: 0,
    warm: true,
    draft: null,
    config: null,
  };
  definitions: AcpAgentDefinition[] = [definition()];
  private commandListener?: (commands: AcpAssignment[]) => void;
  private warmListener?: (sessions: AcpWarmSession[]) => void;
  private answerListener?: (answers: AcpAnsweredInteraction[]) => void;

  constructor(
    private readonly env: Environment,
    binding: AcpSignedBinding,
  ) {
    this.e2ee = {
      e2eeId: E2EE_ID,
      creatorUserId: env.creator.userId,
      binding,
      sessionProof: null,
    };
  }

  gatewayState: AcpTransport["gatewayState"] = () => () => undefined;
  async mintGatewayKey(): Promise<{ keyId: string; key: string }> {
    throw new Error("unused");
  }
  async gatewayModels() {
    return [];
  }
  agentDefinitions = (receive: (rows: AcpAgentDefinition[]) => void) => {
    queueMicrotask(() => receive(this.definitions));
    return () => undefined;
  };
  assignedCommands = (receive: (rows: AcpAssignment[]) => void) => {
    this.commandListener = receive;
    queueMicrotask(() => receive(this.assignments));
    return () => undefined;
  };
  warmSessions = (receive: (rows: AcpWarmSession[]) => void) => {
    this.warmListener = receive;
    queueMicrotask(() => this.publishWarm());
    return () => undefined;
  };
  answeredInteractions = (receive: (rows: AcpAnsweredInteraction[]) => void) => {
    this.answerListener = receive;
    return () => undefined;
  };
  publishWarm() {
    this.warmListener?.(
      this.warm
        ? [
            {
              chat: CHAT,
              epoch: this.epoch,
              agentId: this.binding.agentId,
              profile: this.binding.profile,
              cwd: this.binding.cwd,
              sessionId: this.binding.sessionId,
              status: this.binding.status,
              e2ee: this.e2ee,
            },
          ]
        : [],
    );
  }
  publishAnswer(row: AcpAnsweredInteraction) {
    this.answerListener?.([row]);
  }

  /** Queue a command as the backend would serve it: sealed and signed, never plaintext. */
  addSigned(
    command: Awaited<ReturnType<typeof signedCommand>>,
    kind: AcpCommandPayload["kind"],
    forkTarget: AcpClaim["forkTarget"] = null,
  ) {
    const id = crypto.randomUUID();
    this.claims.set(id, {
      command: id,
      kind,
      clientId: command.clientId,
      payload: null,
      signed: command.signed,
      target: null,
      forkTarget,
      by: "user",
      chat: CHAT,
      session: { ...this.binding, e2ee: this.e2ee },
    });
    this.enqueue(id, kind);
    return id;
  }

  /** Queue a command the backend authored itself: plaintext payload, no signature. */
  addUnsigned(payload: AcpCommandPayload) {
    const id = crypto.randomUUID();
    this.claims.set(id, {
      command: id,
      kind: payload.kind,
      clientId: id,
      payload,
      signed: null,
      target: null,
      forkTarget: null,
      by: "user",
      chat: CHAT,
      session: { ...this.binding, e2ee: this.e2ee },
    });
    this.enqueue(id, payload.kind);
    return id;
  }

  private enqueue(id: string, kind: AcpCommandPayload["kind"]) {
    this.assignments = [...this.assignments, { _id: id, kind, chat: CHAT, createdAt: Date.now() }];
    this.commandListener?.(this.assignments);
  }

  async claimCommand({ command }: { command: string }) {
    const claim = this.claims.get(command) ?? null;
    this.claims.delete(command);
    this.assignments = this.assignments.filter((row) => row._id !== command);
    queueMicrotask(() => this.commandListener?.(this.assignments));
    return claim;
  }
  async finishCommand(args: {
    command: string;
    status: "done" | "failed";
    error?: string;
    result?: string;
  }) {
    this.writes.push(args);
    this.receipts.set(args.command, args);
  }
  async openInteraction(args: {
    chat: string;
    requestKey: string;
    request?: AcpInteractionRequest;
    sealed?: AcpSealedRequest;
  }) {
    this.writes.push(args);
    const id = crypto.randomUUID();
    this.opened.push({ id, key: args.requestKey, sealed: args.sealed });
    return id;
  }
  async resolveInteraction(args: { interaction: string; status: "resolved" | "cancelled" }) {
    this.resolved.push(args);
  }
  async reopenInteraction({ interaction }: { interaction: string }) {
    this.reopened.push(interaction);
  }
  async chatKey(): Promise<AcpChatKey> {
    this.chatKeyCalls++;
    const publicKey = this.env.chatKey.publicKey;
    const key = {
      workspaceId: WORKSPACE,
      chatE2eeId: E2EE_ID,
      epoch: 1,
      keyId: "chat-key-1",
      suite: SUITE_1,
      publicKey,
    };
    const signature = await sign(this.env.creator.sign.seed, chatKeyStatement(key));
    // What the creator signed as the key's binding; `chatKeyBound` overrides one field of it.
    const policy = {
      chatId: CHAT,
      scope: "personal" as ChatScopeName,
      creatorId: this.env.creator.userId,
      members: [] as string[],
      ...this.chatKeyBound,
    };
    const binding = await sign(
      this.env.creator.sign.seed,
      chatKeyBindingStatement({ ...key, ...policy }),
    );
    return {
      e2eeId: E2EE_ID,
      epoch: 1,
      keyId: "chat-key-1",
      suite: SUITE_1,
      publicKey: arrayBuffer(publicKey),
      signerKeyId: this.chatKeyUnsigned ? null : this.env.creator.keyId,
      signature: this.chatKeyUnsigned ? null : arrayBuffer(signature),
      bindingSignature: this.chatKeyUnbound ? null : arrayBuffer(binding),
      bindingMembers: policy.scope === "shared" ? policy.members : null,
      rekey: false,
    };
  }
  async startEpoch(args: { chat: string; epoch: number; capsule?: AcpEpochCapsule }) {
    this.epoch = args.epoch;
    this.epochStarts.push({ epoch: args.epoch, capsule: args.capsule });
    return { accepted: this.warm };
  }
  async appendFrames(args: { chat: string; epoch: number; frames: AcpFrameInput[] }) {
    this.writes.push(args);
    if (!this.warm || args.epoch !== this.epoch) return { accepted: false, bytes: 0 };
    this.frames.push(...args.frames.map((frame) => ({ epoch: args.epoch, frame })));
    const bytes = this.frames
      .filter((entry) => entry.epoch === args.epoch)
      .reduce((sum, entry) => sum + (entry.frame.payload as ArrayBuffer).byteLength, 0);
    return { accepted: true, bytes };
  }
  async updateSession({ patch }: { chat: string; patch: AcpSessionPatch }) {
    this.writes.push(patch);
    this.patches.push(patch);
    if (patch.sessionId) {
      this.binding.sessionId = patch.sessionId;
      if (this.e2ee && patch.sessionProof)
        this.e2ee = { ...this.e2ee, sessionProof: { kind: "worker", signature: patch.sessionProof } };
    }
    if (patch.status) this.binding.status = patch.status;
    if (patch.config) this.binding.config = patch.config;
    this.publishWarm();
  }
  async reportAgents({ agents }: { agents: AcpAgentReport[] }) {
    this.reportCount++;
    this.reports = structuredClone(agents);
    return {};
  }
  async knownAgentSessions(): Promise<AcpAgentSessionEntry[]> {
    return [];
  }
  async syncAgentSessions(args: Parameters<AcpTransport["syncAgentSessions"]>[0]) {
    this.writes.push(args);
    this.syncs.push(args);
  }
  async recoverWorker() {
    return { more: false };
  }
}

const hosts: AcpHost[] = [];
const script = fileURLToPath(new URL("./test-agent.ts", import.meta.url));
const bun = execFileSync("bun", ["-p", "process.execPath"], { encoding: "utf8" }).trim();

function definition(): AcpAgentDefinition {
  return {
    agentId: "scripted",
    name: "Scripted",
    command: bun,
    args: [script],
    env: [],
    enabled: true,
    source: "custom",
  };
}

async function until(check: () => boolean): Promise<void> {
  const expires = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() > expires) throw new Error("Timed out waiting for observable ACP state");
    await delay(10);
  }
}

async function startPaired(env: Environment, transport: SignedTransport) {
  const issuedAt = Date.now();
  for (const definition of transport.definitions) {
    definition.authorization = {
      issuedAt,
      signerKeyId: env.owner.keyId,
      signature: arrayBuffer(await sign(
        env.owner.sign.seed,
        acpAgentDefinitionStatement({ workspaceId: WORKSPACE, issuedAt, definition }),
      )),
    };
  }
  const host = new AcpHost(transport, {}, fakeTrust(env));
  hosts.push(host);
  host.setAvailable(true);
  await until(() => transport.reports.length > 0 && transport.syncs.some((sync) => sync.finish));
  return host;
}

async function setup(binding?: AcpSignedBinding) {
  const env = await environment();
  return { env, transport: new SignedTransport(env, binding ?? (await signedBinding(env))) };
}

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
});

describe("paired ACP host refuses what the backend could have authored", () => {
  it("does not probe an unsigned server-provided executable", async () => {
    const { env, transport } = await setup();
    const host = new AcpHost(transport, {}, fakeTrust(env));
    hosts.push(host);
    host.setAvailable(true);
    await until(() => transport.reportCount > 0);
    expect(transport.reports).toEqual([]);
    expect(transport.syncs).toEqual([]);
  });

  it("refuses unsigned, tampered, rolled-back and equivocated launch definitions", async () => {
    const { env, transport } = await setup();
    const verifier = new AcpSigned(fakeTrust(env), transport);
    const initial = definition();
    expect(await verifier.verifyDefinition(initial)).toBe(false);
    const authorize = async (value: AcpAgentDefinition, issuedAt: number, signer = env.owner) => ({
      ...value,
      authorization: {
        issuedAt,
        signerKeyId: signer.keyId,
        signature: arrayBuffer(await sign(signer.sign.seed,
          acpAgentDefinitionStatement({ workspaceId: WORKSPACE, issuedAt, definition: value }))),
      },
    });
    const approved = await authorize(initial, 100);
    expect(await verifier.verifyDefinition(approved)).toBe(true);
    expect(await verifier.verifyDefinition({ ...approved, command: "/tmp/attacker" })).toBe(false);
    expect(await verifier.verifyDefinition(await authorize(initial, 99))).toBe(false);
    expect(await verifier.verifyDefinition(await authorize({ ...initial, command: "/tmp/other" }, 100))).toBe(false);
    expect(await verifier.verifyDefinition(await authorize(initial, 101, env.member))).toBe(false);
    expect(await verifier.verifyDefinition(await authorize({ ...initial, enabled: false }, 101))).toBe(true);
    expect(await verifier.verifyDefinition(approved)).toBe(false);
  });

  it("rechecks previously seen bindings after rollback and creator revocation", async () => {
    const env = await environment();
    const first = await signedBinding(env);
    const transport = new SignedTransport(env, first);
    const trust = fakeTrust(env);
    const signed = new AcpSigned(trust, transport);
    const input = {
      chat: CHAT,
      e2ee: transport.e2ee!,
      agentId: "scripted",
      profile: "native" as const,
      cwd: tmpdir(),
    };
    await signed.verifyBinding(input);
    input.e2ee.binding = await signedBinding(env, { version: 2 });
    await signed.verifyBinding(input);
    input.e2ee.binding = await signedBinding(env, {
      version: 2,
      scope: "shared",
      members: [env.member.userId],
    });
    await expect(signed.verifyBinding(input)).rejects.toThrow("ACP_FORBIDDEN");
    input.e2ee.binding = first;
    await expect(signed.verifyBinding(input)).rejects.toThrow("ACP_FORBIDDEN");

    input.e2ee.binding = await signedBinding(env, { version: 2 });
    trust.verifyUser = async () => null;
    await expect(signed.verifyBinding(input)).rejects.toThrow("ACP_FORBIDDEN");
  });

  it("rejects a captured command after recreating the verifier", async () => {
    const { env, transport } = await setup();
    const trust = fakeTrust(env);
    const command = await signedCommand(env, { kind: "cancel" });
    const id = transport.addSigned(command, "cancel");
    const claim = transport.claims.get(id)!;
    await new AcpSigned(trust, transport).verifyCommand(claim);
    await expect(new AcpSigned(trust, transport).verifyCommand(claim)).rejects.toThrow("ACP_FORBIDDEN");
  });

  it("fails an unsigned command and executes nothing", async () => {
    const { env, transport } = await setup();
    await startPaired(env, transport);
    const command = transport.addUnsigned({ kind: "prompt", prompt: [{ type: "text", text: "x" }] });
    await until(() => transport.receipts.has(command));
    expect(transport.receipts.get(command)).toEqual({
      command,
      status: "failed",
      error: "ACP_UNSIGNED",
    });
    expect(transport.patches).toEqual([]);
  });

  it("refuses a command signed by a roster member outside the chat's audience", async () => {
    const { env, transport } = await setup();
    await startPaired(env, transport);
    const prompt: AcpCommandPayload = { kind: "prompt", prompt: [{ type: "text", text: "x" }] };
    const command = transport.addSigned(
      await signedCommand(env, prompt, { signer: env.member }),
      "prompt",
    );
    await until(() => transport.receipts.has(command));
    expect(transport.receipts.get(command)?.error).toBe("ACP_FORBIDDEN");
    expect(transport.patches).toEqual([]);
  });

  it("refuses a binding signed by someone other than the chat's creator", async () => {
    const env = await environment();
    const transport = new SignedTransport(env, await signedBinding(env, { signer: env.member }));
    await startPaired(env, transport);
    const command = transport.addSigned(await signedCommand(env, { kind: "cancel" }), "cancel");
    await until(() => transport.receipts.has(command));
    expect(transport.receipts.get(command)?.error).toBe("ACP_FORBIDDEN");
  });

  it("refuses a binding version lower than one it has already seen", async () => {
    const { env, transport } = await setup(undefined);
    transport.e2ee!.binding = await signedBinding(env, { version: 2 });
    await startPaired(env, transport);
    const accepted = transport.addSigned(await signedCommand(env, { kind: "cancel" }), "cancel");
    await until(() => transport.receipts.has(accepted));
    expect(transport.receipts.get(accepted)?.status).toBe("done");

    // The backend replays the creator's older, still validly signed binding.
    transport.e2ee!.binding = await signedBinding(env, { version: 1 });
    const rolledBack = transport.addSigned(await signedCommand(env, { kind: "cancel" }), "cancel");
    await until(() => transport.receipts.has(rolledBack));
    expect(transport.receipts.get(rolledBack)?.error).toBe("ACP_FORBIDDEN");
  });

  it("writes no frames for a chat key epoch that is not signed", async () => {
    const { env, transport } = await setup();
    transport.warm = true;
    transport.chatKeyUnsigned = true;
    await startPaired(env, transport);
    await until(() => transport.chatKeyCalls > 0);
    await delay(300);
    expect(transport.epochStarts).toEqual([]);
    expect(transport.frames).toEqual([]);
  });

  it("writes no frames for a chat key epoch that predates recipient binding", async () => {
    const { env, transport } = await setup();
    transport.warm = true;
    transport.chatKeyUnbound = true;
    await startPaired(env, transport);
    await until(() => transport.chatKeyCalls > 0);
    await delay(300);
    expect(transport.epochStarts).toEqual([]);
    expect(transport.frames).toEqual([]);
  });

  describe("chat key recipient binding", () => {
    async function keyFor(
      bound: SignedTransport["chatKeyBound"],
      options: { binding?: Parameters<typeof signedBinding>[1]; unbound?: boolean } = {},
    ) {
      const env = await environment();
      const transport = new SignedTransport(env, await signedBinding(env, options.binding));
      transport.chatKeyBound = bound;
      transport.chatKeyUnbound = options.unbound ?? false;
      const signed = new AcpSigned(fakeTrust(env), transport);
      const binding = await signed.verifyBinding({
        chat: CHAT,
        e2ee: transport.e2ee!,
        agentId: "scripted",
        profile: "native",
        cwd: tmpdir(),
      });
      return { env, signed, binding };
    }
    const shared = (members: string[]) => ({
      binding: { scope: "shared" as const, members: ["member-user"] },
      bound: { scope: "shared" as const, members },
    });

    it("returns the key only when bound to this chat, scope, creator and audience", async () => {
      const personal = await keyFor({});
      const key = await personal.signed.chatKey(personal.binding);
      expect(key.epoch).toBe(1);
      expect(Array.from(key.publicKey)).toEqual(Array.from(personal.env.chatKey.publicKey));

      const group = shared(["member-user"]);
      const sharedKey = await keyFor(group.bound, { binding: group.binding });
      await expect(sharedKey.signed.chatKey(sharedKey.binding)).resolves.toMatchObject({ epoch: 1 });
    });

    it("refuses an epoch with no binding signature", async () => {
      const { signed, binding } = await keyFor({}, { unbound: true });
      await expect(signed.chatKey(binding)).rejects.toThrow("ACP_FORBIDDEN");
    });

    it("refuses a key whose binding names another chat, scope or creator", async () => {
      for (const bound of [
        { chatId: "other-chat" },
        { scope: "workspace" as const },
        { creatorId: "member-user" },
      ]) {
        const { signed, binding } = await keyFor(bound);
        await expect(signed.chatKey(binding)).rejects.toThrow("ACP_UNSIGNED");
      }
    });

    it("refuses a key bound to a different member list than the creator-signed audience", async () => {
      for (const members of [[], ["member-user", "extra-user"], ["other-user"]]) {
        const group = shared(members);
        const { signed, binding } = await keyFor(group.bound, { binding: group.binding });
        await expect(signed.chatKey(binding)).rejects.toThrow("ACP_FORBIDDEN");
      }
      // A personal-bound key replayed under a shared audience carries no member list at all.
      const replay = await keyFor({}, { binding: shared([]).binding });
      await expect(replay.signed.chatKey(replay.binding)).rejects.toThrow("ACP_FORBIDDEN");
    });
  });

  it("refuses a fork whose target is not the chat its issuer bound", async () => {
    const { env, transport } = await setup();
    await startPaired(env, transport);
    // Each case binds its own target chat: a chat's creator is pinned on first sight.
    const target = async (
      id: string,
      input: { chat?: string; creator?: User; signer?: User } = {},
    ): Promise<NonNullable<AcpClaim["forkTarget"]>> => ({
      chat: input.chat ?? id,
      agentId: "scripted",
      profile: "native",
      cwd: tmpdir(),
      e2ee: {
        e2eeId: `e2ee-${id}`,
        creatorUserId: (input.creator ?? env.creator).userId,
        binding: await signedBinding(env, {
          chat: id,
          e2eeId: `e2ee-${id}`,
          creator: input.creator,
          signer: input.signer ?? input.creator,
        }),
        sessionProof: null,
      },
    });
    const fork = (targetChat: string) => signedCommand(env, { kind: "fork", targetChat });

    // The recorded target is a different chat than the one the command names.
    const wrongChat = transport.addSigned(
      await fork("wrong"),
      "fork",
      await target("wrong", { chat: "other" }),
    );
    // The target's binding belongs to another user than the one who issued the fork.
    const otherCreator = transport.addSigned(
      await fork("theirs"),
      "fork",
      await target("theirs", { creator: env.member }),
    );
    // The target binding is signed by someone other than its stated creator.
    const forgedBinding = transport.addSigned(
      await fork("forged"),
      "fork",
      await target("forged", { signer: env.member }),
    );
    // No target at all.
    const missing = transport.addSigned(await fork("missing"), "fork");
    for (const command of [wrongChat, otherCreator, forgedBinding, missing]) {
      await until(() => transport.receipts.has(command));
      expect(transport.receipts.get(command)?.error).toBe("ACP_FORBIDDEN");
    }
    expect(transport.patches).toEqual([]);

    // A target bound by the issuer passes authorization (the scripted agent may still fail the fork).
    const allowed = transport.addSigned(await fork("mine"), "fork", await target("mine"));
    await until(() => transport.receipts.has(allowed));
    expect(transport.receipts.get(allowed)?.error).not.toBe("ACP_FORBIDDEN");
  });
});

describe("paired ACP host and signed interactions", () => {
  async function pendingPermission() {
    const { env, transport } = await setup();
    await startPaired(env, transport);
    const command = transport.addSigned(
      await signedCommand(env, { kind: "prompt", prompt: [{ type: "text", text: "permission" }] }),
      "prompt",
    );
    await until(() => transport.opened.length === 1);
    const opened = transport.opened[0]!;
    expect(opened.sealed).toBeDefined();

    // The request is sealed to the chat key and signed by the Worker for clients.
    const box = new Uint8Array(opened.sealed!.box);
    const request = JSON.parse(
      new TextDecoder().decode(
        await openBox({
          seed: env.chatKey.seed,
          box,
          aad: {
            table: "acp_interactions",
            workspace: WORKSPACE,
            parent: E2EE_ID,
            record: opened.key,
            field: "request",
          },
          pad: "content",
        }),
      ),
    ) as AcpInteractionRequest;
    expect(request.kind).toBe("permission");
    expect(
      await verify(
        env.worker.sign.publicKey,
        workerObjectStatement({
          workspaceId: WORKSPACE,
          workerId: WORKER_ID,
          table: "acp_interactions",
          parent: E2EE_ID,
          record: opened.key,
          field: "request",
          object: box,
        }),
        new Uint8Array(opened.sealed!.signature),
      ),
    ).toBe(true);
    return { env, transport, command, opened };
  }

  it("reopens a forged answer and never answers the agent", async () => {
    const { env, transport, command, opened } = await pendingPermission();
    transport.publishAnswer({
      _id: opened.id,
      chat: CHAT,
      requestKey: opened.key,
      sealed: await sealedAnswer(env, {
        requestKey: opened.key,
        answer: { kind: "permission", optionId: "allow_once" },
        signature: "forged",
      }),
    });
    await until(() => transport.reopened.length === 1);
    expect(transport.reopened).toEqual([opened.id]);
    expect(transport.resolved).toEqual([]);
    expect(transport.receipts.has(command)).toBe(false);

    // A genuine answer afterwards still resolves the same request.
    transport.publishAnswer({
      _id: opened.id,
      chat: CHAT,
      requestKey: opened.key,
      sealed: await sealedAnswer(env, {
        requestKey: opened.key,
        answer: { kind: "permission", optionId: "allow_once" },
        signature: "valid",
      }),
    });
    await until(() => transport.receipts.has(command));
    expect(transport.receipts.get(command)?.status).toBe("done");
  });

  it("reopens a validly signed answer that is invalid for the request", async () => {
    const { env, transport, command, opened } = await pendingPermission();
    transport.publishAnswer({
      _id: opened.id,
      chat: CHAT,
      requestKey: opened.key,
      sealed: await sealedAnswer(env, {
        requestKey: opened.key,
        answer: { kind: "permission", optionId: "an-option-that-was-never-offered" },
        signature: "valid",
      }),
    });
    await until(() => transport.reopened.length === 1);
    expect(transport.resolved).toEqual([]);
    expect(transport.receipts.has(command)).toBe(false);
  });
});

describe("paired ACP host with a signed prompt", () => {
  it("runs the turn and writes only ciphertext frames and sealed text", async () => {
    const { env, transport } = await setup();
    transport.warm = true;
    await startPaired(env, transport);
    const command = transport.addSigned(
      await signedCommand(env, { kind: "prompt", prompt: [{ type: "text", text: "hello" }] }),
      "prompt",
    );
    await until(() => transport.receipts.has(command));
    expect(transport.receipts.get(command)).toEqual({ command, status: "done" });
    await until(() => transport.frames.length > 0 && transport.binding.status === "idle");

    // The new session ID is bound to the chat by the Worker's own proof.
    const created = transport.patches.find((patch) => patch.sessionId);
    expect(created?.sessionProof).toBeDefined();

    // Frames are bytes sealed under a Worker-signed capsule to the chat key.
    const start = transport.epochStarts.at(-1)!;
    expect(start.capsule).toBeDefined();
    expect(
      await verify(
        env.worker.sign.publicKey,
        workerObjectStatement({
          workspaceId: WORKSPACE,
          workerId: WORKER_ID,
          table: "acp_streams",
          parent: E2EE_ID,
          record: String(start.epoch),
          field: "capsule",
          object: new Uint8Array(start.capsule!.capsule),
        }),
        new Uint8Array(start.capsule!.signature),
      ),
    ).toBe(true);
    const capsuleKey = await openCapsule({
      seed: env.chatKey.seed,
      capsule: decodeCapsule(new Uint8Array(start.capsule!.capsule)),
      aad: {
        table: "acp_streams",
        workspace: WORKSPACE,
        parent: E2EE_ID,
        record: String(start.epoch),
        field: "capsule",
      },
    });
    const ops: AcpOp[] = [];
    for (const { epoch, frame } of transport.frames) {
      expect(typeof frame.payload).not.toBe("string");
      const plaintext = await openWithCapsule({
        capsuleKey,
        envelope: new Uint8Array(frame.payload as ArrayBuffer),
        aad: {
          table: "chat_frames",
          workspace: WORKSPACE,
          parent: E2EE_ID,
          record: `${epoch}:${frame.seqFrom}`,
          field: "payload",
        },
        pad: "content",
      });
      const opened = JSON.parse(new TextDecoder().decode(plaintext)) as {
        seqTo: number;
        kind: string;
        ops: AcpOp[];
      };
      expect(opened.seqTo).toBe(frame.seqTo);
      expect(opened.kind).toBe(frame.kind);
      ops.push(...opened.ops);
    }
    expect(JSON.stringify(ops)).toContain("hello");

    // Nothing the Worker wrote to Convex carries the content, titles or errors in the clear.
    expect(JSON.stringify(transport.writes)).not.toContain("hello");
    expect(transport.patches.every((patch) => patch.title === undefined)).toBe(true);
    expect(transport.patches.every((patch) => typeof patch.error !== "string")).toBe(true);
    expect(transport.patches.some((patch) => patch.sealedTitle)).toBe(true);
    expect(
      transport.syncs.every((sync) => sync.upserts.every((entry) => entry.title === undefined)),
    ).toBe(true);
  });
});
