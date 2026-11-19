import { expect, test } from "vitest";
import {
  decodeCapsule,
  generateEncryptionKeyPair,
  openBox,
  openCapsule,
  openWithCapsule,
  randomBytes,
  sealSym,
  utf8,
  toBase64Url,
} from "radium-crypto";
import {
  openFileBytes,
  parseFileFragment,
  sealChatMessages,
  sealChatTitle,
  validatePlaintextAttachments,
} from "./sealing";
import { storedFileUrls } from "./files";

const workspace = "workspace";
const e2eeId = toBase64Url(new Uint8Array(16).fill(3));

test("a turn uses one capsule and only seals changed positions and the response", async () => {
  const key = await generateEncryptionKeyPair();
  const messages = [
    { id: "u1", role: "user", parts: [{ type: "text", text: "secret" }] },
    { id: "a1", role: "assistant", parts: [] },
  ];
  const target = { workspace, e2eeId, epoch: 1, publicKey: key.publicKey };
  const writes = await sealChatMessages({
    ...target,
    messages,
    heads: [
      { position: 0, messageId: "u1", revision: 4 },
      { position: 1, messageId: "a1", revision: 2 },
    ],
    revisions: { u1: 4, a1: 2 },
    responseMessageId: "a1",
    fileUrls: [],
  });
  expect(writes.rows.map(({ position, revision }) => ({ position, revision }))).toEqual([
    { position: 1, revision: 3 },
  ]);
  const capsule = decodeCapsule(new Uint8Array(writes.capsule.capsule));
  const capsuleKey = await openCapsule({
    seed: key.seed,
    capsule,
    aad: { workspace, table: "e2ee_capsules", parent: e2eeId, record: "1", field: "capsule" },
  });
  const plaintext = await openWithCapsule({
    capsuleKey,
    envelope: new Uint8Array(writes.rows[0]!.envelope),
    pad: "content",
    aad: { workspace, table: "chat_messages", parent: e2eeId, record: "a1", field: "message" },
  });
  expect(JSON.parse(new TextDecoder().decode(plaintext))).toEqual(messages[1]);
  await expect(
    openWithCapsule({
      capsuleKey,
      envelope: new Uint8Array(writes.rows[0]!.envelope),
      pad: "content",
      aad: { workspace, table: "chat_messages", parent: "other", record: "a1", field: "message" },
    }),
  ).rejects.toThrow();
  const title = { title: "Private title", emoji: "🔒" };
  const sealedTitle = await sealChatTitle(target, title);
  expect(
    JSON.parse(
      new TextDecoder().decode(
        await openBox({
          seed: key.seed,
          box: new Uint8Array(sealedTitle.box),
          pad: "short",
          aad: { workspace, table: "aisdk_chats", parent: e2eeId, record: "1", field: "title" },
        }),
      ),
    ),
  ).toEqual(title);
});

test("missing IDs are assigned before sealing and a revision mismatch rewrites", async () => {
  const key = await generateEncryptionKeyPair();
  const writes = await sealChatMessages({
    workspace,
    e2eeId,
    epoch: 1,
    publicKey: key.publicKey,
    messages: [{}, { id: "changed" }],
    heads: [{ position: 1, messageId: "changed", revision: 3 }],
    revisions: { changed: 2 },
    fileUrls: [],
  });
  expect(writes.rows[0]!.messageId).toBeTruthy();
  expect(writes.rows[1]!.revision).toBe(4);
});

test("file URLs drop fragments at storage boundaries and malformed keys fail closed", async () => {
  const fileId = toBase64Url(new Uint8Array(16).fill(4));
  const url = `https://example.invalid/file#rf1.${fileId}.${e2eeId}.${toBase64Url(randomBytes(32))}`;
  expect([...storedFileUrls([{ parts: [{ type: "file", url }] }])]).toEqual([
    "https://example.invalid/file",
  ]);
  expect(parseFileFragment(url)?.fileId).toBe(fileId);
  expect(() => parseFileFragment(url.replace(/\.[^.]+$/, ".bad"))).toThrow();
  await expect(openFileBytes(workspace, url, new Uint8Array(50))).rejects.toThrow();
});

test("attachment fragments open only the bound file and never enter plaintext writes", async () => {
  const fileId = toBase64Url(randomBytes(16));
  const objectKey = randomBytes(32);
  const url = `https://example.invalid/file#rf1.${fileId}.${e2eeId}.${toBase64Url(objectKey)}`;
  const envelope = await sealSym({
    key: objectKey,
    keyRef: randomBytes(16),
    kind: "capsule",
    plaintext: utf8("file contents"),
    pad: "content",
    aad: { workspace, table: "chat_files", parent: e2eeId, record: fileId, field: "bytes" },
  });
  expect(new TextDecoder().decode(await openFileBytes(workspace, url, envelope))).toBe(
    "file contents",
  );
  await expect(openFileBytes("other", url, envelope)).rejects.toThrow();
  expect(() => validatePlaintextAttachments([{ type: "file", url }])).toThrow();
});
