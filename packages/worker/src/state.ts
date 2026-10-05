import { chmod, link, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { exportJWK, generateKeyPair } from "jose";
import {
  type PrivateP256Jwk,
  type PublicP256Jwk,
  type StoredWorkerSetup,
  type WorkerIdentity,
  type WorkerSetup,
  WorkerProtocolError,
  storedSetup,
  validateOrigin,
} from "./protocol.js";

const STATE_FILE_NAME = "worker-state.json";
const STATE_FILE_MODE = 0o600;
const STATE_DIRECTORY_MODE = 0o700;
const MAX_STATE_BYTES = 32 * 1024;

/**
 * Crash-recovery state kept outside future agent workloads.
 * `setup` retains only URLs, selector and expiry, never the one-time token.
 * The key and requestId are written before networking, so a lost completion
 * response can be recovered with the original key instead of creating a second
 * Worker. `identity` is added only after enrollment or recovery succeeds.
 */
export interface WorkerState {
  version: 1;
  setup: StoredWorkerSetup;
  requestId: string;
  privateKey: PrivateP256Jwk;
  publicKey: PublicP256Jwk;
  identity?: WorkerIdentity;
}

export function defaultStateDirectory(): string {
  return join(homedir(), ".radium-worker");
}

/** Create and durably save an identity key before any network request is made. */
export async function createPendingState(
  stateDirectory: string,
  setup: WorkerSetup,
): Promise<WorkerState> {
  const pair = await generateKeyPair("ES256", { extractable: true });
  const state: WorkerState = {
    version: 1,
    setup: storedSetup(setup),
    requestId: randomUUID(),
    privateKey: (await exportJWK(pair.privateKey)) as PrivateP256Jwk,
    publicKey: (await exportJWK(pair.publicKey)) as PublicP256Jwk,
  };

  await writeNewState(stateDirectory, state);
  return state;
}

/** Read a state file only from a private, non-symlink directory and file. */
export async function readWorkerState(stateDirectory: string): Promise<WorkerState | null> {
  try {
    await ensureProtectedDirectory(stateDirectory);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }

  const path = join(stateDirectory, STATE_FILE_NAME);
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  validateProtectedFile(info);
  if ((Number(info.mode) & 0o777) !== STATE_FILE_MODE) {
    try {
      await chmod(path, STATE_FILE_MODE);
    } catch {
      throw new WorkerProtocolError("Worker state file permissions could not be secured");
    }
  }

  let raw: Buffer;
  try {
    raw = await readFile(path);
  } catch {
    throw new WorkerProtocolError("Worker state could not be read");
  }
  if (raw.byteLength > MAX_STATE_BYTES) throw new WorkerProtocolError("Worker state is invalid");

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new WorkerProtocolError("Worker state is invalid");
  }
  return validateState(parsed);
}

/** Save the completed identity while preserving the original key and request ID. */
export async function saveWorkerIdentity(
  stateDirectory: string,
  state: WorkerState,
  identity: WorkerIdentity,
): Promise<WorkerState> {
  const completed: WorkerState = { ...state, identity };
  await replaceState(stateDirectory, completed, state);
  return completed;
}

/** Refuse a different setup code when a pending or completed identity already exists. */
export function assertSetupMatches(state: WorkerState, setup: WorkerSetup): void {
  if (
    state.setup.version !== 1 ||
    state.setup.backendUrl !== setup.backendUrl ||
    state.setup.convexUrl !== setup.convexUrl ||
    state.setup.enrollmentId !== setup.enrollmentId ||
    state.setup.expiresAt !== setup.expiresAt
  ) {
    throw new WorkerProtocolError(
      "Existing Worker state belongs to a different setup; refusing to overwrite it",
    );
  }
}

async function writeNewState(stateDirectory: string, state: WorkerState): Promise<void> {
  await ensureProtectedDirectory(stateDirectory);
  const path = join(stateDirectory, STATE_FILE_NAME);
  const temporaryPath = join(stateDirectory, `.worker-state-${randomUUID()}.tmp`);
  let handle;
  let temporaryCreated = false;
  try {
    handle = await open(temporaryPath, "wx", STATE_FILE_MODE);
    temporaryCreated = true;
    await handle.chmod(STATE_FILE_MODE);
    await writeAndSync(handle, state);
    await handle.close();
    handle = undefined;
    // link() atomically creates the final name without replacing pre-existing state.
    await link(temporaryPath, path);
    await unlink(temporaryPath);
    await syncDirectory(stateDirectory);
  } catch (error) {
    await handle?.close();
    if (temporaryCreated) await unlink(temporaryPath).catch(() => undefined);
    if (isAlreadyExists(error)) {
      throw new WorkerProtocolError("Worker state already exists; refusing to overwrite it");
    }
    if (error instanceof WorkerProtocolError) throw error;
    throw new WorkerProtocolError("Worker state could not be created");
  }
}

async function replaceState(
  stateDirectory: string,
  nextState: WorkerState,
  expectedState: WorkerState,
): Promise<void> {
  await ensureProtectedDirectory(stateDirectory);
  const path = join(stateDirectory, STATE_FILE_NAME);
  const current = await readWorkerState(stateDirectory);
  if (!current || !sameKey(current, expectedState)) {
    throw new WorkerProtocolError(
      "Worker state changed while authenticating; refusing to replace it",
    );
  }

  const temporaryPath = join(stateDirectory, `.worker-state-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporaryPath, "wx", STATE_FILE_MODE);
    await handle.chmod(STATE_FILE_MODE);
    await writeAndSync(handle, nextState);
    await handle.close();
    handle = undefined;

    const latest = await readWorkerState(stateDirectory);
    if (!latest || !sameKey(latest, expectedState)) {
      throw new WorkerProtocolError(
        "Worker state changed while authenticating; refusing to replace it",
      );
    }
    if (latest.identity) {
      if (!nextState.identity || !sameIdentity(latest.identity, nextState.identity)) {
        throw new WorkerProtocolError("Worker identity already exists; refusing to replace it");
      }
      await unlink(temporaryPath).catch(() => undefined);
      return;
    }
    await rename(temporaryPath, path);
    await syncDirectory(stateDirectory);
  } catch (error) {
    await handle?.close();
    await unlink(temporaryPath).catch(() => undefined);
    if (error instanceof WorkerProtocolError) throw error;
    throw new WorkerProtocolError("Worker state could not be updated");
  }
}

async function ensureProtectedDirectory(stateDirectory: string): Promise<void> {
  try {
    await mkdir(stateDirectory, { recursive: true, mode: STATE_DIRECTORY_MODE });
  } catch {
    throw new WorkerProtocolError("Worker state directory could not be created");
  }

  let info;
  try {
    info = await lstat(stateDirectory);
  } catch {
    throw new WorkerProtocolError("Worker state directory could not be opened");
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new WorkerProtocolError("Worker state directory must be a real directory");
  }
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new WorkerProtocolError("Worker state directory is owned by a different user");
  }

  try {
    await chmod(stateDirectory, STATE_DIRECTORY_MODE);
  } catch {
    throw new WorkerProtocolError("Worker state directory permissions could not be secured");
  }
}

function validateProtectedFile(info: Awaited<ReturnType<typeof lstat>>): void {
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
    throw new WorkerProtocolError("Worker state file must be a private regular file");
  }
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new WorkerProtocolError("Worker state file is owned by a different user");
  }
  if ((Number(info.mode) & 0o077) !== 0) {
    throw new WorkerProtocolError("Worker state file permissions are too broad");
  }
  if (info.size > MAX_STATE_BYTES) throw new WorkerProtocolError("Worker state is invalid");
}

function validateState(value: unknown): WorkerState {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.setup)) {
    throw new WorkerProtocolError("Worker state is invalid");
  }

  const setup = value.setup;
  if (
    Object.keys(setup).length !== 5 ||
    setup.version !== 1 ||
    typeof setup.backendUrl !== "string" ||
    typeof setup.convexUrl !== "string" ||
    typeof setup.enrollmentId !== "string" ||
    typeof setup.expiresAt !== "number" ||
    !Number.isSafeInteger(setup.expiresAt) ||
    setup.enrollmentId.length < 1 ||
    setup.enrollmentId.length > 1024 ||
    /[\u0000-\u001f\u007f]/.test(setup.enrollmentId)
  ) {
    throw new WorkerProtocolError("Worker state is invalid");
  }

  if (
    typeof value.requestId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.requestId)
  ) {
    throw new WorkerProtocolError("Worker state is invalid");
  }

  const privateKey = validatePrivateKey(value.privateKey);
  const publicKey = validatePublicKey(value.publicKey);
  if (
    privateKey.kty !== publicKey.kty ||
    privateKey.crv !== publicKey.crv ||
    privateKey.x !== publicKey.x ||
    privateKey.y !== publicKey.y
  ) {
    throw new WorkerProtocolError("Worker state key pair is invalid");
  }

  const result: WorkerState = {
    version: 1,
    setup: {
      version: 1,
      backendUrl: validateOrigin(setup.backendUrl, "backendUrl"),
      convexUrl: validateOrigin(setup.convexUrl, "convexUrl"),
      enrollmentId: setup.enrollmentId,
      expiresAt: setup.expiresAt,
    },
    requestId: value.requestId,
    privateKey,
    publicKey,
  };

  if (value.identity !== undefined) result.identity = validateIdentity(value.identity);
  return result;
}

function validatePrivateKey(value: unknown): PrivateP256Jwk {
  if (
    !isRecord(value) ||
    value.kty !== "EC" ||
    value.crv !== "P-256" ||
    !isP256Coordinate(value.x) ||
    !isP256Coordinate(value.y) ||
    !isP256Coordinate(value.d)
  ) {
    throw new WorkerProtocolError("Worker state private key is invalid");
  }
  return value as unknown as PrivateP256Jwk;
}

function validatePublicKey(value: unknown): PublicP256Jwk {
  if (
    !isRecord(value) ||
    value.kty !== "EC" ||
    value.crv !== "P-256" ||
    !isP256Coordinate(value.x) ||
    !isP256Coordinate(value.y) ||
    "d" in value
  ) {
    throw new WorkerProtocolError("Worker state public key is invalid");
  }
  return value as unknown as PublicP256Jwk;
}

function validateIdentity(value: unknown): WorkerIdentity {
  if (
    !isRecord(value) ||
    typeof value.workerId !== "string" ||
    value.workerId.length < 1 ||
    value.workerId.length > 1024 ||
    typeof value.keyId !== "string" ||
    value.keyId.length < 1 ||
    value.keyId.length > 1024 ||
    typeof value.workspaceId !== "string" ||
    value.workspaceId.length < 1 ||
    value.workspaceId.length > 1024 ||
    !Number.isSafeInteger(value.identityEpoch) ||
    Number(value.identityEpoch) < 1
  ) {
    throw new WorkerProtocolError("Worker identity state is invalid");
  }
  return {
    workerId: value.workerId,
    keyId: value.keyId,
    workspaceId: value.workspaceId,
    identityEpoch: Number(value.identityEpoch),
  };
}

function sameKey(left: WorkerState, right: WorkerState): boolean {
  return (
    left.requestId === right.requestId &&
    left.privateKey.x === right.privateKey.x &&
    left.privateKey.y === right.privateKey.y &&
    left.privateKey.d === right.privateKey.d
  );
}

function sameIdentity(left: WorkerIdentity, right: WorkerIdentity): boolean {
  return (
    left.workerId === right.workerId &&
    left.keyId === right.keyId &&
    left.workspaceId === right.workspaceId &&
    left.identityEpoch === right.identityEpoch
  );
}

function isP256Coordinate(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}

async function writeAndSync(
  handle: Awaited<ReturnType<typeof open>>,
  state: WorkerState,
): Promise<void> {
  const contents = Buffer.from(`${JSON.stringify(state)}\n`, "utf8");
  if (contents.byteLength > MAX_STATE_BYTES)
    throw new WorkerProtocolError("Worker state is invalid");
  await handle.writeFile(contents);
  await handle.sync();
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return isRecord(error) && error.code === "EEXIST";
}
