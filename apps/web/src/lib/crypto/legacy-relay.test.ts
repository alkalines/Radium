import { afterAll, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import { generateEncryptionKeyPair, openBox, sealBox, utf8 } from "radium-crypto";
import { legacyAad } from "contracts/e2ee/legacy-contract";
import * as legacyContent from "./legacy-content";
import {
  openHistoricalAcpSession,
  openHistoricalAgentTitle,
} from "./legacy-relay";

type Request = { table: string; record: string; workspace?: string; chatId?: string };

let seed: Uint8Array;
let publicKey: Uint8Array;

// Opens real ciphertext under the same AAD the backend seals with, so a reader that names the wrong
// table, record or workspace fails here exactly as it would against a migrated deployment. A spy,
// not a module mock: `mock.module` would stay in place for the other test files of this process.
function openWithTestSeed() {
  spyOn(legacyContent, "openLegacyContent").mockImplementation((async (
    sealed: { box: ArrayBuffer },
    request: Request,
  ) => {
    const plaintext = await openBox({
      seed,
      box: new Uint8Array(sealed.box),
      aad: legacyAad(request.table, request.record, request.workspace),
      pad: "content",
    });
    return JSON.parse(new TextDecoder().decode(plaintext));
  }) as never);
}

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
  openWithTestSeed();
});
afterAll(() => mock.restore());

describe("historical relay readers (real ciphertext)", () => {
  test("session sidecars return the moved error, config and commands", async () => {
    const moved = {
      error: "agent crashed",
      commands: [{ name: "review", description: "Review the diff" }],
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
});
