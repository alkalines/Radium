import { ConvexHttpClient } from "convex/browser";
import { api } from "backend/convex/_generated/api";
import {
  generateEncryptionKeyPair,
  generateSigningKeyPair,
  randomBytes,
  sign,
  SUITE_1,
  toBase64Url,
  workerKeysStatement,
  workerPairingMac,
} from "radium-crypto";
import type { AuthOptions } from "../auth/proof.js";
import { saveWorkerE2ee, type WorkerState, type WorkerStateOptions } from "../auth/state.js";
import { requestMachineToken } from "../auth/token.js";
import { type WorkerPairing, WorkerProtocolError } from "../protocol.js";

/**
 * Pairs an enrolled Worker (Keys.md "Workers"): generates a new X-Wing encryption key and Ed25519
 * signing key under a random key ID, saves the seeds and the owner pin from the code locally
 * before anything is published, then publishes the public keys with the Worker's self-signature
 * and the pairing-secret MAC through `workers.publishKeys`. The owner's browser checks the MAC and
 * certifies the Worker in the roster; until then the Worker refuses commands.
 *
 * A failed publish leaves the Worker locally paired but uncertified; pairing again with a new code
 * replaces the keys. The pairing secret is zeroed and never persisted.
 */
export async function pairWorker(
  stateDirectory: string,
  state: WorkerState,
  pairing: WorkerPairing,
  options: AuthOptions & WorkerStateOptions = {},
): Promise<WorkerState> {
  const identity = state.identity;
  if (!identity) throw new WorkerProtocolError("Worker identity is not enrolled");

  const encryption = await generateEncryptionKeyPair();
  const signing = await generateSigningKeyPair();
  const keyId = toBase64Url(randomBytes(16));
  const statement = workerKeysStatement({
    workspaceId: identity.workspaceId,
    workerId: identity.workerId,
    keyId,
    suite: SUITE_1,
    encryptionPublicKey: encryption.publicKey,
    signingPublicKey: signing.publicKey,
  });
  let pairingMac: Uint8Array;
  try {
    pairingMac = await workerPairingMac(pairing.secret, statement);
  } finally {
    pairing.secret.fill(0);
  }
  const selfSignature = await sign(signing.seed, statement);

  const paired = await saveWorkerE2ee(
    stateDirectory,
    state,
    {
      keyId,
      suite: 1,
      encryptionPublicKey: toBase64Url(encryption.publicKey),
      signingPublicKey: toBase64Url(signing.publicKey),
      owner: pairing.owner,
      encryptionSeed: encryption.seed,
      signingSeed: signing.seed,
    },
    options,
  );

  const { token } = await requestMachineToken(paired, options);
  const client = new ConvexHttpClient(state.setup.convexUrl);
  client.setAuth(token);
  try {
    await client.mutation(api.workers.publishKeys, {
      pairingId: pairing.pairingId,
      keyId,
      suite: SUITE_1,
      encryptionPublicKey: buffer(encryption.publicKey),
      signingPublicKey: buffer(signing.publicKey),
      selfSignature: buffer(selfSignature),
      pairingMac: buffer(pairingMac),
    });
  } catch {
    // Convex errors could echo arguments; report a fixed reason only.
    throw new WorkerProtocolError(
      "The backend refused this Worker's keys (expired or already used pairing code?). Create a new pairing code and run `pair`.",
    );
  }
  return paired;
}

function buffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}
