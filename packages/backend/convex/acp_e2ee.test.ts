/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, expect, test, vi } from "vitest";
import { exportJWK, generateKeyPair } from "jose";
import { register } from "worker-component/test";
import {
  acpAgentDefinitionStatement,
  acpAnswerStatement,
  acpCommandStatement,
  CAPSULE_BYTES,
  generateSigningKeyPair,
  randomBytes,
  sign,
  toBase64Url,
} from "radium-crypto";
import { api, components } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import schema from "./schema";
import { normalizeWorkerKey, tokenDigest, workerIssuer } from "../src/worker/auth";
import type { AcpAgentDefinition, AcpAgentReport } from "contracts/acp/contract";
import type * as WorkerKeys from "../src/e2ee/worker-keys";

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

// Roster certification is Slice 1's concern; here a keyed workspace certifies every Worker.
vi.mock("../src/e2ee/worker-keys", async (importOriginal) => {
  const original = await importOriginal<typeof WorkerKeys>();
  const keys = async (ctx: QueryCtx, workspace: Id<"workspaces">) =>
    (await ctx.db.get(workspace))?.keyEpoch
      ? {
          keyId: "worker-key",
          encryptionPublicKey: new ArrayBuffer(1216),
          signingPublicKey: new ArrayBuffer(32),
        }
      : null;
  return { ...original, requireDispatchableWorker: keys, certifiedWorkerKeys: keys };
});

const modules = import.meta.glob("./**/*.ts");
const agent: AcpAgentReport = {
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
  authMethods: [],
};

afterEach(() => {
  vi.unstubAllEnvs();
});

/** A sealed box stand-in: Convex only bounds and stores it, so random bytes suffice. */
function sealed(size = CAPSULE_BYTES + 64) {
  return randomBytes(size).buffer as ArrayBuffer;
}

/** A keyed workspace with an encrypted ACP chat whose creator published a binding. */
async function keyedFixture() {
  vi.stubEnv("CONVEX_SITE_URL", "https://backend.example.invalid");
  const t = convexTest(schema, modules);
  register(t);
  const workspace = await t.run((ctx) =>
    ctx.db.insert("workspaces", { ownerType: "user", ownerId: "owner", name: "ACP" }),
  );
  await t.run((ctx) =>
    ctx.db.insert("workspace_members", { workspace, userId: "member", role: "member" }),
  );
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
  await machine.mutation(api.acp.reportAgents, { agents: [agent] });
  const owner = t.withIdentity({ subject: "owner" });
  const member = t.withIdentity({ subject: "member" });
  const chat = await owner.mutation(api.acp.CreateSession, {
    workspace,
    worker: identity.workerId,
    agentId: agent.agentId,
    cwd: "/work",
  });

  // Identities, chat keys and the binding exist as the browsers would have created them.
  const signers: Record<string, { keyId: string; seed: Uint8Array }> = {};
  for (const userId of ["owner", "member"]) {
    const signing = await generateSigningKeyPair();
    const keyId = toBase64Url(randomBytes(16));
    signers[userId] = { keyId, seed: signing.seed };
    await t.run((ctx) =>
      ctx.db.insert("e2ee_identities", {
        userId,
        keyId,
        suite: 1,
        encryptionPublicKey: new ArrayBuffer(1216),
        signingPublicKey: signing.publicKey.slice().buffer as ArrayBuffer,
        secrets: new ArrayBuffer(8),
        selfSignature: new ArrayBuffer(64),
        recoveryWrapper: new ArrayBuffer(8),
        status: "active",
        createdAt: Date.now(),
      }),
    );
  }
  await t.run(async (ctx) => {
    await ctx.db.patch(workspace, { keyEpoch: 1 });
    await ctx.db.patch(chat, { e2eeId: toBase64Url(randomBytes(16)), keyEpoch: 1 });
    const session = await ctx.db
      .query("acp_sessions")
      .withIndex("by_chat", (q) => q.eq("chat", chat))
      .unique();
    await ctx.db.patch(session!._id, {
      binding: {
        version: 1,
        scope: "personal",
        members: [],
        signerKeyId: signers.owner!.keyId,
        signature: new ArrayBuffer(64),
      },
    });
  });

  async function command(userId: string, kind: string, chatId: string, clientId: string) {
    const payload = new Uint8Array(sealed());
    const signer = signers[userId]!;
    const signature = await sign(
      signer.seed,
      acpCommandStatement({
        workspaceId: workspace,
        workerId: identity.workerId,
        chatId,
        kind,
        clientId,
        payload,
      }),
    );
    return {
      clientId,
      payload: payload.buffer as ArrayBuffer,
      signature: signature.slice().buffer as ArrayBuffer,
      signerKeyId: signer.keyId,
    };
  }
  return { t, workspace, identity, machine, owner, member, chat, signers, command };
}

test("keyed agent definitions require fresh owner authorization over the executable", async () => {
  const f = await keyedFixture();
  const definition: AcpAgentDefinition = {
    agentId: "authorized-agent",
    name: "Authorized agent",
    command: "agent",
    args: ["serve"],
    env: [],
    enabled: true,
    source: "custom",
  };
  const issuedAt = Date.now();
  const authorize = async (value: AcpAgentDefinition, time: number): Promise<AcpAgentDefinition> => ({
    ...value,
    authorization: {
      issuedAt: time,
      signerKeyId: f.signers.owner!.keyId,
      signature: (await sign(
        f.signers.owner!.seed,
        acpAgentDefinitionStatement({ workspaceId: f.workspace, issuedAt: time, definition: value }),
      )).slice().buffer as ArrayBuffer,
    },
  });
  await expect(f.owner.mutation(api.acp.SaveAgentDefinition, {
    workspace: f.workspace, definition,
  })).rejects.toThrow("ACP_AGENT_AUTHORIZATION_REQUIRED");
  const approved = await authorize(definition, issuedAt);
  const id = await f.owner.mutation(api.acp.SaveAgentDefinition, {
    workspace: f.workspace, definition: approved,
  });
  await expect(f.owner.mutation(api.acp.SaveAgentDefinition, {
    workspace: f.workspace, id, definition: { ...approved, command: "other", args: ["attack"] },
  })).rejects.toThrow("ACP_AGENT_AUTHORIZATION_REQUIRED");
  await expect(f.owner.mutation(api.acp.SaveAgentDefinition, {
    workspace: f.workspace, id, definition: approved,
  })).rejects.toThrow("ACP_STALE_AGENT_AUTHORIZATION");
  const disabled = await authorize({ ...definition, enabled: false }, issuedAt + 1);
  await f.owner.mutation(api.acp.SaveAgentDefinition, {
    workspace: f.workspace, id, definition: disabled,
  });
  expect(await f.machine.query(api.acp.agentDefinitions, {})).toContainEqual(disabled);
});

test("keyed workspaces store only sealed, signer-verified commands", async () => {
  const f = await keyedFixture();
  const prompt = [{ type: "text" as const, text: "secret prompt" }];

  await expect(
    f.owner.mutation(api.acp.Prompt, { chat: f.chat, prompt, clientId: "plain" }),
  ).rejects.toThrow(/ACP_E2EE_MODE|ACP_SIGNATURE_REQUIRED/);
  const signed = await f.command("owner", "prompt", f.chat, "prompt-1");
  await expect(
    f.owner.mutation(api.acp.Prompt, { chat: f.chat, prompt, clientId: "prompt-1", signed }),
  ).rejects.toThrow(/ACP_E2EE_MODE/);
  // Signed by the member's key but submitted by the owner: `by` must be the signer.
  const forged = { ...(await f.command("member", "prompt", f.chat, "prompt-2")) };
  await expect(
    f.owner.mutation(api.acp.Prompt, { chat: f.chat, clientId: "prompt-2", signed: forged }),
  ).rejects.toThrow(/ACP_INVALID_SIGNATURE/);
  // A signature over another kind cannot be replayed as a prompt.
  const cancel = await f.command("owner", "cancel", f.chat, "prompt-3");
  await expect(
    f.owner.mutation(api.acp.Prompt, { chat: f.chat, clientId: "prompt-3", signed: cancel }),
  ).rejects.toThrow(/ACP_INVALID_SIGNATURE/);

  await f.owner.mutation(api.acp.Prompt, { chat: f.chat, clientId: "prompt-1", signed });
  const rows = await f.t.run((ctx) =>
    ctx.db
      .query("acp_commands")
      .withIndex("by_chat_and_status", (q) => q.eq("chat", f.chat))
      .collect(),
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]!.payload).toBeUndefined();
  expect(rows[0]!.signed?.payload).toBeInstanceOf(ArrayBuffer);

  const claim = await f.machine.mutation(api.acp.claimCommand, { command: rows[0]!._id });
  expect(claim).toMatchObject({ payload: null, clientId: "prompt-1" });
  expect(claim?.signed?.signerKeyId).toBe(f.signers.owner!.keyId);
  expect(claim?.session?.e2ee?.binding?.version).toBe(1);
  // Claiming erases the sealed command, and a paired Worker reports only fixed codes.
  expect((await f.t.run((ctx) => ctx.db.get(rows[0]!._id)))?.signed).toBeUndefined();
  await expect(
    f.machine.mutation(api.acp.finishCommand, {
      command: rows[0]!._id,
      status: "failed",
      error: "stack trace with secrets",
    }),
  ).rejects.toThrow(/ACP_PLAINTEXT_REFUSED/);
  await f.machine.mutation(api.acp.finishCommand, {
    command: rows[0]!._id,
    status: "failed",
    error: "ACP_FORBIDDEN",
  });
});

test("keyed workspaces store frames, interactions and answers only as bytes", async () => {
  const f = await keyedFixture();
  await f.owner.mutation(api.chatroom.Watch, { chat: f.chat, tab: "tab" });
  const capsule = {
    chatEpoch: 1,
    capsule: sealed(CAPSULE_BYTES),
    signature: new ArrayBuffer(64),
  };
  await expect(f.machine.mutation(api.acp.startEpoch, { chat: f.chat, epoch: 1 })).rejects.toThrow(
    /ACP_E2EE_MODE/,
  );
  await f.machine.mutation(api.acp.startEpoch, { chat: f.chat, epoch: 1, capsule });
  // A retry must repeat the same capsule.
  await expect(
    f.machine.mutation(api.acp.startEpoch, {
      chat: f.chat,
      epoch: 1,
      capsule: { ...capsule, capsule: sealed(CAPSULE_BYTES) },
    }),
  ).rejects.toThrow(/ACP_FRAME_CONFLICT/);
  expect(await f.owner.query(api.acp.StreamCapsule, { chat: f.chat, epoch: 1 })).toMatchObject({
    chatEpoch: 1,
  });

  const frame = { seqFrom: 0, seqTo: 0, kind: "snapshot" as const };
  await expect(
    f.machine.mutation(api.acp.appendFrames, {
      chat: f.chat,
      epoch: 1,
      frames: [{ ...frame, payload: "[]" }],
    }),
  ).rejects.toThrow(/ACP_PLAINTEXT_REFUSED/);
  const bytes = sealed(512);
  await f.machine.mutation(api.acp.appendFrames, {
    chat: f.chat,
    epoch: 1,
    frames: [{ ...frame, payload: bytes }],
  });
  await f.machine.mutation(api.acp.appendFrames, {
    chat: f.chat,
    epoch: 1,
    frames: [{ ...frame, payload: bytes }],
  });
  await expect(
    f.machine.mutation(api.acp.appendFrames, {
      chat: f.chat,
      epoch: 1,
      frames: [{ ...frame, payload: sealed(512) }],
    }),
  ).rejects.toThrow(/ACP_FRAME_CONFLICT/);
  const frames = await f.owner.query(api.chatroom.LiveFrames, {
    chat: f.chat,
    stream: "acp:1",
    fromSeq: 0,
  });
  expect(frames).toHaveLength(1);
  expect(frames[0]!.payload).toBeInstanceOf(ArrayBuffer);

  await f.t.run(async (ctx) => {
    const session = await ctx.db
      .query("acp_sessions")
      .withIndex("by_chat", (q) => q.eq("chat", f.chat))
      .unique();
    await ctx.db.patch(session!._id, { status: "running" });
  });
  await expect(
    f.machine.mutation(api.acp.updateSession, { chat: f.chat, patch: { title: "Secret title" } }),
  ).rejects.toThrow(/ACP_PLAINTEXT_REFUSED/);
  await expect(
    f.machine.mutation(api.acp.openInteraction, {
      chat: f.chat,
      requestKey: "request-1",
      request: { kind: "permission", toolCallId: "t", options: [] },
    }),
  ).rejects.toThrow(/ACP_E2EE_MODE/);
  const interaction = await f.machine.mutation(api.acp.openInteraction, {
    chat: f.chat,
    requestKey: "request-1",
    sealed: { kind: "permission", epoch: 1, box: sealed(), signature: new ArrayBuffer(64) },
  });
  const [open] = await f.owner.query(api.acp.OpenInteractions, { chat: f.chat });
  expect(open).not.toHaveProperty("request");
  expect(open?.sealed?.box).toBeInstanceOf(ArrayBuffer);

  await expect(
    f.owner.mutation(api.acp.Answer, {
      interaction,
      answer: { kind: "permission", optionId: "allow" },
    }),
  ).rejects.toThrow(/ACP_E2EE_MODE/);
  const answer = new Uint8Array(sealed());
  const statement = acpAnswerStatement({
    workspaceId: f.workspace,
    workerId: f.identity.workerId,
    chatId: f.chat,
    requestKey: "request-1",
    answer,
  });
  // The member cannot submit an answer signed by the owner's key.
  const ownerSignature = await sign(f.signers.owner!.seed, statement);
  await expect(
    f.member.mutation(api.acp.Answer, {
      interaction,
      sealed: {
        answer: answer.buffer as ArrayBuffer,
        signature: ownerSignature.slice().buffer as ArrayBuffer,
        signerKeyId: f.signers.owner!.keyId,
      },
    }),
  ).rejects.toThrow();
  await f.owner.mutation(api.acp.Answer, {
    interaction,
    sealed: {
      answer: answer.buffer as ArrayBuffer,
      signature: ownerSignature.slice().buffer as ArrayBuffer,
      signerKeyId: f.signers.owner!.keyId,
    },
  });
  const stored = await f.t.run((ctx) => ctx.db.get(interaction));
  expect(stored).toMatchObject({ status: "answered" });
  expect(stored?.answer).toBeUndefined();
  expect(stored?.request).toBeUndefined();
  const [delivered] = await f.machine.query(api.acp.answeredInteractions, {});
  expect(delivered?.sealed?.answer).toBeInstanceOf(ArrayBuffer);

  // The Worker rejected the answer: the interaction is open again, without the old answer.
  await f.machine.mutation(api.acp.reopenInteraction, { interaction });
  const reopened = await f.t.run((ctx) => ctx.db.get(interaction));
  expect(reopened).toMatchObject({ status: "pending" });
  expect(reopened?.sealedAnswer).toBeUndefined();
});
