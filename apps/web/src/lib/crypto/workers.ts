import {
  CryptoError,
  equalBytes,
  fingerprint,
  fromBase64Url,
  openBox,
  randomBytes,
  sealBox,
  sign,
  toBase64Url,
  utf8,
  verify,
  workerKeysStatement,
  workerPairingMac,
  type AadParts,
  type RosterWorker,
} from "radium-crypto";
import { keyManager } from "./key-manager";
import { currentUserId, newKeyId } from "./runtime";
import { trpcClient } from "@/lib/trpc-client";
import { trust, workerPinKey } from "./trust-store";
import { keyedWorkspaceClaim, publishRosterWorkers, verifyWorkspaceState } from "./workspace-keys";

/** A Worker's public E2EE keys after verification. */
export type TrustedWorkerKeys = {
  keyId: string;
  encryptionPublicKey: Uint8Array;
  signingPublicKey: Uint8Array;
};

/** One `e2ee.workerKeys` row (public data served by the backend; verify before use). */
export type WorkerKeyRow = {
  workerId: string;
  keyId: string;
  suite: number;
  encryptionPublicKey: string;
  signingPublicKey: string;
  selfSignature: string;
  pairingMac: string;
  pairingId: string;
};

/** Per-Worker pairing state for the Workers page. */
export type WorkerPairingState = "paired" | "unpaired" | "failed";

/** The Worker is not certified by the verified roster, or its served keys do not match it. */
export class WorkerNotPairedError extends Error {
  constructor(readonly workerId: string) {
    super("This Worker is not paired; pair it from the Workers page");
    this.name = "WorkerNotPairedError";
  }
}

/**
 * Keys of a Worker the workspace owner certified: listed in the verified roster, with a served key
 * row of the same keyId and fingerprint and a valid self-signature. Throws `WorkerNotPairedError`.
 */
export async function trustedWorker(
  workspaceId: string,
  workerId: string,
): Promise<TrustedWorkerKeys> {
  const state = await verifyWorkspaceState(workspaceId);
  const listed = state.verifiedRoster.workers.find((worker) => worker.workerId === workerId);
  if (!listed) throw new WorkerNotPairedError(workerId);
  const rows = await trpcClient().e2ee.workerKeys.query({ workspace: workspaceId });
  const row = rows.find((entry) => entry.workerId === workerId && entry.keyId === listed.keyId);
  const keys = row ? await verifiedWorkerKeys({ workspaceId, row }).catch(() => null) : null;
  if (!keys || keys.fingerprint !== listed.fingerprint) throw new WorkerNotPairedError(workerId);
  return {
    keyId: keys.keyId,
    encryptionPublicKey: keys.encryptionPublicKey,
    signingPublicKey: keys.signingPublicKey,
  };
}

/** Signs `message` with the unlocked identity. Throws `KeysLockedError` when locked. */
export function signAsUser(
  message: Uint8Array,
): Promise<{ signature: Uint8Array; signerKeyId: string }> {
  return keyManager.useAmk(async (_, identity) => ({
    signature: await sign(identity.signing.seed, message),
    signerKeyId: toBase64Url(identity.keyId),
  }));
}

/**
 * Checks a served Worker key row: sizes, the Worker's self-signature and, when `pairingSecret` is
 * given, the pairing MAC that binds the keys to the holder of the setup or pairing code. Returns
 * the keys with their fingerprint; throws `CryptoError` otherwise.
 */
export async function verifiedWorkerKeys(input: {
  workspaceId: string;
  row: WorkerKeyRow;
  pairingSecret?: Uint8Array;
}): Promise<TrustedWorkerKeys & { fingerprint: string }> {
  const { row } = input;
  const encryptionPublicKey = fromBase64Url(row.encryptionPublicKey);
  const signingPublicKey = fromBase64Url(row.signingPublicKey);
  if (row.suite !== 1 || fromBase64Url(row.keyId).length !== 16) {
    throw new CryptoError("BAD_ENVELOPE", "Invalid Worker keys");
  }
  const statement = workerKeysStatement({
    workspaceId: input.workspaceId,
    workerId: row.workerId,
    keyId: row.keyId,
    suite: row.suite,
    encryptionPublicKey,
    signingPublicKey,
  });
  if (!(await verify(signingPublicKey, statement, fromBase64Url(row.selfSignature)))) {
    throw new CryptoError("DECRYPT_FAILED", "Worker self-signature failed");
  }
  if (
    input.pairingSecret &&
    !equalBytes(await workerPairingMac(input.pairingSecret, statement), fromBase64Url(row.pairingMac))
  ) {
    throw new CryptoError("DECRYPT_FAILED", "Worker pairing proof failed");
  }
  return {
    keyId: row.keyId,
    encryptionPublicKey,
    signingPublicKey,
    fingerprint: await fingerprint({ encryptionPublicKey, signingPublicKey }),
  };
}

const pairingAad = (workspaceId: string, ownerUserId: string, pairingId: string): AadParts => ({
  table: "e2ee_worker_pairings",
  workspace: workspaceId,
  parent: ownerUserId,
  record: pairingId,
  field: "secret",
});

/**
 * Creates a pairing secret, stores the owner's sealed copy (to the owner's own identity key) and
 * returns the fields every code carries. The owner must be the roster's signer, so the Worker pins
 * the key that actually signs rosters.
 */
async function newPairing(
  workspaceId: string,
  target: { kind: "enrollment"; enrollmentId: string } | { kind: "worker"; workerId: string },
) {
  const state = await verifyWorkspaceState(workspaceId);
  const owner = state.verifiedRoster.owner;
  if (state.role !== "owner" || owner.userId !== currentUserId()) {
    throw new CryptoError("DECRYPT_FAILED", "Only the workspace owner pairs Workers");
  }
  const pairingId = newKeyId();
  const secret = randomBytes(32);
  try {
    const { sealedSecret, signingPublicKey } = await keyManager.useAmk(async (_, identity) => {
      if (toBase64Url(identity.keyId) !== owner.keyId) {
        throw new CryptoError("DECRYPT_FAILED", "Owner identity differs from the roster");
      }
      return {
        sealedSecret: await sealBox({
          recipientPublicKey: identity.encryption.publicKey,
          plaintext: secret,
          aad: pairingAad(workspaceId, owner.userId, pairingId),
          pad: "none",
        }),
        signingPublicKey: identity.signing.publicKey,
      };
    });
    const { expiresAt } = await trpcClient().e2ee.createWorkerPairing.mutate({
      workspace: workspaceId,
      pairingId,
      sealedSecret: toBase64Url(sealedSecret),
      target,
    });
    return {
      expiresAt,
      fields: {
        pairingId,
        secret: toBase64Url(secret),
        owner: { ...owner, signingPublicKey: toBase64Url(signingPublicKey) },
      },
    };
  } finally {
    secret.fill(0);
  }
}

const encodeCode = (prefix: string, value: unknown) =>
  `${prefix}${toBase64Url(utf8(JSON.stringify(value)))}`;

/**
 * Creates a Worker setup code. Keyless workspaces get the server's `radium-worker-v1.` code; keyed
 * ones a `radium-worker-v2.` code that adds the pairing secret and owner pin, built here so the
 * secret never reaches the backend. A workspace this device verified as keyed never gets a v1 code
 * (`KeylessDowngradeError`). The returned code is secret: keep it out of logs.
 */
export async function createWorkerSetupCode(
  workspaceId: string,
  name: string,
): Promise<{ code: string; enrollmentId: string; expiresAt: number }> {
  const state = await trpcClient().e2ee.workspaceKeyState.query({ workspace: workspaceId });
  const keyed = keyedWorkspaceClaim(workspaceId, state.keyEpoch != null);
  const enrollment = await trpcClient().workers.createEnrollment.mutate({
    workspace: workspaceId,
    name,
  });
  if (!keyed) {
    return {
      code: enrollment.code,
      enrollmentId: enrollment.enrollmentId,
      expiresAt: enrollment.expiresAt,
    };
  }
  const pairing = await newPairing(workspaceId, {
    kind: "enrollment",
    enrollmentId: enrollment.enrollmentId,
  });
  const expiresAt = Math.min(enrollment.expiresAt, pairing.expiresAt);
  return {
    code: encodeCode("radium-worker-v2.", { ...enrollment.bundle, version: 2, ...pairing.fields }),
    enrollmentId: enrollment.enrollmentId,
    expiresAt,
  };
}

/**
 * Creates a `radium-worker-pair-v1.` code for an enrolled Worker of a keyed workspace
 * (`radium-worker pair`). The returned code is secret: keep it out of logs.
 */
export async function createWorkerPairingCode(
  workspaceId: string,
  workerId: string,
): Promise<{ code: string; expiresAt: number }> {
  const pairing = await newPairing(workspaceId, { kind: "worker", workerId });
  return {
    code: encodeCode("radium-worker-pair-v1.", {
      version: 1,
      workspaceId,
      workerId,
      ...pairing.fields,
      expiresAt: pairing.expiresAt,
    }),
    expiresAt: pairing.expiresAt,
  };
}

type WorkerAssessment = {
  states: Map<string, WorkerPairingState>;
  /** Roster entries for every certifiable active Worker: already listed or newly verified. */
  certified: RosterWorker[];
  /** Newly verified key sets, to pin before they are listed. */
  verified: (TrustedWorkerKeys & { workerId: string; suite: number; fingerprint: string })[];
};

/** Read-only: classifies each active Worker and verifies newly published keys with their MAC. */
async function assessWorkers(workspaceId: string): Promise<WorkerAssessment | null> {
  const state = await verifyWorkspaceState(workspaceId);
  if (state.role !== "owner" || !state.keyEpoch) return null;
  const [rows, pairings, workers] = await Promise.all([
    trpcClient().e2ee.workerKeys.query({ workspace: workspaceId }),
    trpcClient().e2ee.workerPairings.query({ workspace: workspaceId }),
    trpcClient().workers.list.query({ workspace: workspaceId }),
  ]);
  const assessment: WorkerAssessment = { states: new Map(), certified: [], verified: [] };
  const active = new Set(
    workers.filter((worker) => worker.status === "active").map((worker) => worker.workerId),
  );
  for (const workerId of active) assessment.states.set(workerId, "unpaired");

  for (const row of rows) {
    if (!active.has(row.workerId)) continue;
    const listed = state.verifiedRoster.workers.find(
      (worker) => worker.workerId === row.workerId && worker.keyId === row.keyId,
    );
    if (listed) {
      const keys = await verifiedWorkerKeys({ workspaceId, row }).catch(() => null);
      if (keys?.fingerprint === listed.fingerprint) {
        assessment.certified.push(listed);
        assessment.states.set(row.workerId, "paired");
      } else {
        assessment.states.set(row.workerId, "failed");
      }
      continue;
    }
    const pairing = pairings.find((entry) => entry.pairingId === row.pairingId);
    // Without the owner's copy of the secret (expired, or created elsewhere) there is nothing to check.
    if (!pairing || (pairing.workerId !== null && pairing.workerId !== row.workerId)) continue;

    const keys = await keyManager
      .useAmk(async (_, identity) => {
        const secret = await openBox({
          seed: identity.encryption.seed,
          box: fromBase64Url(pairing.sealedSecret),
          aad: pairingAad(workspaceId, state.ownerId, pairing.pairingId),
          pad: "none",
        });
        try {
          return await verifiedWorkerKeys({ workspaceId, row, pairingSecret: secret });
        } finally {
          secret.fill(0);
        }
      })
      .catch((error: unknown) => {
        if (error instanceof CryptoError) return null;
        throw error;
      });
    if (!keys) {
      // A backend that swapped the Worker's keys cannot produce the MAC: never certify.
      assessment.states.set(row.workerId, "failed");
      continue;
    }
    assessment.verified.push({ ...keys, workerId: row.workerId, suite: row.suite });
    assessment.certified.push({
      workerId: row.workerId,
      keyId: keys.keyId,
      fingerprint: keys.fingerprint,
    });
    assessment.states.set(row.workerId, "paired");
  }
  return assessment;
}

/**
 * Owner-only, unlocked, read-only: each active Worker's pairing state (`paired` when certified or
 * certifiable now, `failed` when its published keys fail the pairing MAC). Empty for non-owners.
 */
export async function workerPairingStates(
  workspaceId: string,
): Promise<Map<string, WorkerPairingState>> {
  return (await assessWorkers(workspaceId))?.states ?? new Map();
}

/**
 * Owner-only, unlocked: certifies Workers whose published keys carry a valid pairing MAC (pinning
 * each as `verified`), keeps already certified ones, drops revoked or re-keyed ones, and publishes
 * the roster when its Worker list changed. Runs in the regular key sync. Resolves whether a roster
 * was published.
 */
export async function syncWorkerCertificates(workspaceId: string): Promise<boolean> {
  const assessment = await assessWorkers(workspaceId);
  if (!assessment) return false;
  for (const keys of assessment.verified) {
    const pinKey = workerPinKey(keys.workerId);
    const identity = { ...keys, userId: pinKey };
    if ((await trust.check(pinKey, identity)) !== "verified") {
      await trust.pin(pinKey, identity, "verified");
    }
  }
  return publishRosterWorkers(workspaceId, assessment.certified);
}
