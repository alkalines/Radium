import { beforeAll, describe, expect, mock, test } from "bun:test";
import { generateEncryptionKeyPair, openBox, sealBox, utf8 } from "radium-crypto";
import { legacyAad } from "contracts/e2ee/legacy-contract";

type Request = { table: string; record: string; workspace?: string; chatId?: string };

let seed: Uint8Array;
let publicKey: Uint8Array;

// Opens real ciphertext under the same AAD the backend seals with, so a reader that names the wrong
// table, record or workspace fails here exactly as it would against a migrated deployment.
mock.module("./legacy-content", () => ({
  openLegacyContent: async (sealed: { box: ArrayBuffer }, request: Request) => {
    const plaintext = await openBox({
      seed,
      box: new Uint8Array(sealed.box),
      aad: legacyAad(request.table, request.record, request.workspace),
      pad: "content",
    });
    return JSON.parse(new TextDecoder().decode(plaintext));
  },
}));
mock.module("./runtime", () => ({ cryptoClient: () => ({ query: async () => null }) }));

// Static imports are hoisted above `mock.module`, so the module under test loads after the mocks.
const { isHistoricalFrame, openHistoricalAcpFrames, openHistoricalAgentTitle, openHistoricalAcpSession } =
  await import("./legacy-relay");

const context = { workspace: "ws" as never, chatId: "chat" as never };

async function seal(table: string, record: string, value: unknown, workspace = "ws") {
  const box = await sealBox({
    recipientPublicKey: publicKey,
    plaintext: utf8(JSON.stringify(value)),
    aad: legacyAad(table, record, workspace),
    pad: "content",
  });
  return { kind: "chat" as const, keyId: "k", epoch: 1, box: box.slice().buffer };
}

beforeAll(async () => {
  const pair = await generateEncryptionKeyPair();
  seed = pair.seed;
  publicKey = pair.publicKey;
});

describe("historical relay readers (real ciphertext)", () => {
  test("sealed frames decrypt into the original ops and keep their sequence range", async () => {
    const payload = '[{"op":"turn.start","turnId":"t"}]';
    const legacyContent = await seal("chat_frames", "f1", { payload });
    const [opened] = await openHistoricalAcpFrames(
      [{ _id: "f1" as never, seqFrom: 4, seqTo: 5, kind: "live", legacyContent }],
      context,
    );
    expect(opened).toEqual({ seqFrom: 4, seqTo: 5, kind: "live", payload });
  });

  test("a frame cannot be read under another record or workspace", async () => {
    const legacyContent = await seal("chat_frames", "f1", { payload: "[]" });
    const row = { seqFrom: 0, seqTo: 0, kind: "live" as const, legacyContent };
    await expect(openHistoricalAcpFrames([{ ...row, _id: "f2" as never }], context)).rejects.toThrow();
    await expect(
      openHistoricalAcpFrames([{ ...row, _id: "f1" as never }], { ...context, workspace: "other" as never }),
    ).rejects.toThrow();
  });

  test("one unreadable frame fails the batch instead of folding a partial stream", async () => {
    const good = await seal("chat_frames", "f1", { payload: "[]" });
    const bad = await seal("chat_frames", "f2", { payload: { not: "a string" } });
    const base = { seqFrom: 0, seqTo: 0, kind: "live" as const };
    await expect(
      openHistoricalAcpFrames(
        [
          { ...base, _id: "f1" as never, legacyContent: good },
          { ...base, _id: "f2" as never, legacyContent: bad },
        ],
        context,
      ),
    ).rejects.toThrow();
  });

  test("session sidecars return the moved error, config, commands and draft", async () => {
    const moved = {
      error: "agent crashed",
      commands: [{ name: "review", description: "Review the diff" }],
      draft: { config: [{ configId: "model", value: "m" }] },
    };
    const legacyContent = await seal("acp_sessions", "s1", moved);
    expect(await openHistoricalAcpSession({ _id: "s1" as never, legacyContent }, context)).toEqual(moved);
  });

  test("index titles decrypt for the owner workspace and blank titles read as untitled", async () => {
    const titled = await seal("acp_agent_sessions", "a1", { title: "  Fix login  " });
    const blank = await seal("acp_agent_sessions", "a2", { title: "   " });
    expect(await openHistoricalAgentTitle({ _id: "a1" as never, legacyContent: titled }, "ws" as never)).toBe("Fix login");
    expect(await openHistoricalAgentTitle({ _id: "a2" as never, legacyContent: blank }, "ws" as never)).toBeUndefined();
    await expect(
      openHistoricalAgentTitle({ _id: "a1" as never, legacyContent: titled }, "other" as never),
    ).rejects.toThrow();
  });

  test("only rows carrying both identity and a sidecar are historical", async () => {
    const legacyContent = await seal("chat_frames", "f1", { payload: "[]" });
    expect(isHistoricalFrame({ _id: "f" as never, legacyContent })).toBe(true);
    expect(isHistoricalFrame({ legacyContent })).toBe(false);
    expect(isHistoricalFrame({ _id: "f" as never })).toBe(false);
  });
});
