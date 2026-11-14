import { describe, expect, test } from "bun:test";
import {
  generateEncryptionKeyPair,
  generateSigningKeyPair,
  randomBytes,
  sign,
  toBase64Url,
  workerKeysStatement,
  workerPairingMac,
} from "radium-crypto";
import { verifiedWorkerKeys, type WorkerKeyRow } from "./workers";

async function publishedRow(secret: Uint8Array): Promise<WorkerKeyRow> {
  const encryption = await generateEncryptionKeyPair();
  const signing = await generateSigningKeyPair();
  const keyId = toBase64Url(randomBytes(16));
  const statement = workerKeysStatement({
    workspaceId: "workspace",
    workerId: "worker",
    keyId,
    suite: 1,
    encryptionPublicKey: encryption.publicKey,
    signingPublicKey: signing.publicKey,
  });
  return {
    workerId: "worker",
    keyId,
    suite: 1,
    encryptionPublicKey: encryption.publicKey.slice().buffer,
    signingPublicKey: signing.publicKey.slice().buffer,
    selfSignature: (await sign(signing.seed, statement)).slice().buffer,
    pairingMac: (await workerPairingMac(secret, statement)).slice().buffer,
    pairingId: toBase64Url(randomBytes(16)),
  };
}

describe("Worker certification", () => {
  test("refuses a key row whose pairing MAC was made with another secret", async () => {
    const secret = randomBytes(32);
    const row = await publishedRow(secret);
    const keys = await verifiedWorkerKeys({ workspaceId: "workspace", row, pairingSecret: secret });
    expect(keys.keyId).toBe(row.keyId);

    // A backend that substitutes its own keys can sign them, but only with another secret's MAC.
    const substituted = await publishedRow(randomBytes(32));
    await expect(
      verifiedWorkerKeys({ workspaceId: "workspace", row: substituted, pairingSecret: secret }),
    ).rejects.toThrow("pairing proof");
    // The MAC also binds the workspace and Worker the keys were published for.
    await expect(
      verifiedWorkerKeys({ workspaceId: "other", row, pairingSecret: secret }),
    ).rejects.toThrow();
  });
});
