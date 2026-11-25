import { describe, expect, test } from "bun:test";
import {
  createCapsule,
  encodeCapsule,
  generateEncryptionKeyPair,
  generateSigningKeyPair,
  randomBytes,
  sealBox,
  sealWithCapsule,
  sign,
  toBase64Url,
  utf8,
  workerObjectStatement,
} from "radium-crypto";
import {
  openAcpFrames,
  openAcpInteraction,
  type AcpChatContext,
  type AcpReadSources,
} from "./acp-crypto";

const workspaceId = "workspace-test";
const workerId = "worker-test";

/** A chat with a chat key, a roster Worker's signing key, and sources serving them. */
async function fixture() {
  const chatKey = await generateEncryptionKeyPair();
  const worker = await generateSigningKeyPair();
  const chat: AcpChatContext = {
    chatId: `chat-${toBase64Url(randomBytes(8))}`,
    workspaceId,
    e2eeId: toBase64Url(randomBytes(16)),
    workerId,
  };
  const stored: { capsule?: { chatEpoch: number; capsule: Uint8Array; signature: Uint8Array } } =
    {};
  const sources: AcpReadSources = {
    workerSigningKey: async () => worker.publicKey,
    streamCapsule: async () => stored.capsule ?? null,
    chatSeed: async () => chatKey.seed,
  };
  const statement = (record: string, field: string, table: string, object: Uint8Array) =>
    workerObjectStatement({
      workspaceId,
      workerId,
      table,
      parent: chat.e2eeId,
      record,
      field,
      object,
    });
  /** Publishes an epoch capsule signed by `signerSeed` over `signedRecord`'s location. */
  async function publishCapsule(
    epoch: number,
    signerSeed: Uint8Array,
    signedRecord = String(epoch),
  ) {
    const { capsule, capsuleKey } = await createCapsule({
      recipientPublicKey: chatKey.publicKey,
      aad: {
        table: "acp_streams",
        workspace: workspaceId,
        parent: chat.e2eeId,
        record: String(epoch),
        field: "capsule",
      },
    });
    const encoded = encodeCapsule(capsule);
    const signature = await sign(
      signerSeed,
      statement(signedRecord, "capsule", "acp_streams", encoded),
    );
    stored.capsule = {
      chatEpoch: 1,
      capsule: encoded,
      signature,
    };
    return { capsule, capsuleKey };
  }
  return { chat, chatKey, worker, sources, statement, publishCapsule };
}

async function sealFrame(
  fixtureChat: AcpChatContext,
  capsule: { capsuleKey: Uint8Array; capsule: { capsuleId: Uint8Array } },
  epoch: number,
  seqFrom: number,
  text: string,
) {
  const envelope = await sealWithCapsule({
    capsuleKey: capsule.capsuleKey,
    capsuleId: capsule.capsule.capsuleId,
    plaintext: utf8(JSON.stringify({ seqTo: seqFrom, kind: "live", ops: JSON.parse(text) })),
    aad: {
      table: "chat_frames",
      workspace: workspaceId,
      parent: fixtureChat.e2eeId,
      record: `${epoch}:${seqFrom}`,
      field: "payload",
    },
    pad: "content",
  });
  return envelope;
}

describe("ACP frame decryption", () => {
  test("authenticates frame payload and routing metadata", async () => {
    const { chat, worker, sources, publishCapsule } = await fixture();
    const epoch = await publishCapsule(1, worker.seed);
    const payload = await sealFrame(chat, epoch, 1, 1, "[1]");
    const row = { seqFrom: 1, seqTo: 1, kind: "live" as const, payload };
    expect((await openAcpFrames(chat, 1, [row], sources))[0].payload).toBe("[1]");
    await expect(openAcpFrames(chat, 1, [{ ...row, seqTo: 99 }], sources)).rejects.toThrow();
    await expect(openAcpFrames(chat, 1, [{ ...row, kind: "history" }], sources)).rejects.toThrow();
    await expect(openAcpFrames(chat, 1, [{ ...row, seqFrom: 2 }], sources)).rejects.toThrow();
    await expect(openAcpFrames(chat, 1, [{ ...row, payload: "[1]" }], sources)).rejects.toThrow();
  });

  test("rejects a capsule not signed by the roster Worker", async () => {
    const { chat, sources, publishCapsule } = await fixture();
    const attacker = await generateSigningKeyPair();
    const epoch = await publishCapsule(1, attacker.seed);
    const payload = await sealFrame(chat, epoch, 1, 1, "[1]");
    await expect(
      openAcpFrames(chat, 1, [{ seqFrom: 1, seqTo: 1, kind: "live", payload }], sources),
    ).rejects.toThrow();
  });

  test("rejects a Worker-signed capsule replayed for another epoch", async () => {
    const { chat, worker, sources, publishCapsule } = await fixture();
    // Signed for epoch 1's location but served as epoch 2's capsule.
    const epoch = await publishCapsule(2, worker.seed, "1");
    const payload = await sealFrame(chat, epoch, 2, 1, "[1]");
    await expect(
      openAcpFrames(chat, 2, [{ seqFrom: 1, seqTo: 1, kind: "live", payload }], sources),
    ).rejects.toThrow();
  });

  test("rejects when the stream has no capsule", async () => {
    const { chat, sources } = await fixture();
    await expect(openAcpFrames(chat, 1, [], sources)).rejects.toThrow();
  });
});

describe("ACP interaction requests", () => {
  /** A sealed request signed by the roster Worker, or by a stranger when `forged`. */
  async function sealedRequest(forged: boolean) {
    const { chat, chatKey, worker, sources, statement } = await fixture();
    const signerSeed = forged ? (await generateSigningKeyPair()).seed : worker.seed;
    const requestKey = "request-1";
    const box = await sealBox({
      recipientPublicKey: chatKey.publicKey,
      plaintext: utf8(JSON.stringify({ kind: "permission", toolCallId: "t", title: "Run" })),
      aad: {
        table: "acp_interactions",
        workspace: workspaceId,
        parent: chat.e2eeId,
        record: requestKey,
        field: "request",
      },
      pad: "content",
    });
    const signature = await sign(
      signerSeed,
      statement(requestKey, "request", "acp_interactions", box),
    );
    return {
      chat,
      sources,
      row: {
        requestKey,
        sealed: {
          epoch: 1,
          box: toBase64Url(box),
          signature: toBase64Url(signature),
        },
      },
    };
  }

  test("shows a request the roster Worker signed", async () => {
    const { chat, row, sources } = await sealedRequest(false);
    expect((await openAcpInteraction(chat, row, sources)).kind).toBe("permission");
  });

  test("refuses a request not signed by the roster Worker", async () => {
    const { chat, row, sources } = await sealedRequest(true);
    await expect(openAcpInteraction(chat, row, sources)).rejects.toThrow();
  });
});
