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
 * signing key under a random key ID, publishes the public keys with the Worker's self-signature
 * and the pairing-secret MAC through `workers.publishKeys`, and only then saves the seeds and the
 * owner pin from the code locally. The owner's browser checks the MAC and certifies the Worker in
 * the roster; until then the Worker refuses commands.
 *
 * A refused publish leaves the previous keys (or unpaired state) untouched. A local save that fails
 * after a successful publish leaves the previous keys in the state; pairing again with a new code
 * replaces the published ones. The pairing secret is zeroed and never persisted.
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

  const { token } = await requestMachineToken(state, options);
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
    encryption.seed.fill(0);
    signing.seed.fill(0);
    // Convex errors could echo arguments; report a fixed reason only.
    throw new WorkerProtocolError(
      "The backend refused this Worker's keys (expired or already used pairing code?). Create a new pairing code and run `pair`.",
    );
  }

  try {
    return await saveWorkerE2ee(
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
  } catch (error) {
    const reason = error instanceof WorkerProtocolError ? `${error.message}. ` : "";
    throw new WorkerProtocolError(
      `${reason}The new keys were published but could not be saved locally. Create a new pairing code and run \`pair\` again.`,
    );
  }
}

function buffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}
