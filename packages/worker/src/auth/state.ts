import { link, lstat, open, readFile, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { exportJWK, generateKeyPair } from "jose";
import {
  configuredWorkerCredentialStoreMode,
  createWorkerCredentialStore,
  type KeyringEntryFactory,
  type WorkerCredentialStore,
  type WorkerCredentialStoreMode,
  type WorkerCredentialStorePreference,
} from "./credentials.js";
import {
  ensurePrivateDirectory,
  ensurePrivateFileMode,
  syncDirectory,
  validatePrivateFile,
  wipeAndUnlinkPrivateFile,
} from "./private-files.js";
import {
  type PrivateP256Jwk,
  type PublicP256Jwk,
  type StoredWorkerSetup,
  type WorkerIdentity,
  type WorkerSetup,
  WorkerProtocolError,
  storedSetup,
  validateOrigin,
} from "../protocol.js";

const STATE_FILE_NAME = "worker-state.json";
const STATE_FILE_MODE = 0o600;
const MAX_STATE_BYTES = 32 * 1024;
const PRIVATE_KEY_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Crash-recovery state kept outside future agent workloads.
 * `setup` retains only URLs, selector and expiry, never the one-time token.
 * The private key is hydrated in memory from the selected credential store;
 * version-2 state files contain its public key and store mode, never the private
 * JWK. The key and requestId are made durable before networking, so a lost
 * completion response can be recovered without creating a second Worker.
 * `identity` is added only after enrollment or recovery succeeds. Machine JWTs
 * are short-lived and are not part of this durable state.
 */
export interface WorkerState {
  version: 2;
  credentialStoreMode: WorkerCredentialStoreMode;
  setup: StoredWorkerSetup;
  requestId: string;
  privateKey: PrivateP256Jwk;
  publicKey: PublicP256Jwk;
  identity?: WorkerIdentity;
}

/** Storage configuration and deterministic credential/durability test seams. */
export interface WorkerStateOptions {
  credentialStoreMode?: WorkerCredentialStorePreference;
  credentialStore?: WorkerCredentialStore;
  keyringEntryFactory?: KeyringEntryFactory;
  stateDirectorySync?: (path: string) => Promise<void>;
}

/** Return the conventional per-user directory for Worker identity state. */
export function defaultStateDirectory(): string {
  return join(homedir(), ".radium-worker");
}

/** Create and durably save an identity key before any network request is made. */
export async function createPendingState(
  stateDirectory: string,
  setup: WorkerSetup,
  options: WorkerStateOptions = {},
): Promise<WorkerState> {
  const pair = await generateKeyPair("ES256", { extractable: true });
  const requestId = randomUUID();
  const privateKey = (await exportJWK(pair.privateKey)) as PrivateP256Jwk;
  const publicKey = (await exportJWK(pair.publicKey)) as PublicP256Jwk;

  const credentialStore = getCredentialStore(stateDirectory, options);
  await credentialStore.set(requestId, serializePrivateKey(privateKey));

  // Automatic storage selection settles only after the key has been saved.
  const state: WorkerState = {
    version: 2,
    credentialStoreMode: credentialStore.mode,
    setup: storedSetup(setup),
    requestId,
    privateKey,
    publicKey,
  };

  try {
    await writeNewState(stateDirectory, state, options);
  } catch (error) {
    if (!(error instanceof PublishedWorkerStateError)) {
      await credentialStore.delete(state.requestId).catch(() => undefined);
    }
    throw error;
  }
  return state;
}

/** Read or locally migrate a state file without making a network request. */
export async function readWorkerState(
  stateDirectory: string,
  options: WorkerStateOptions = {},
): Promise<WorkerState | null> {
  try {
    await ensurePrivateDirectory(stateDirectory);
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
  validatePrivateFile(info, MAX_STATE_BYTES, "Worker state");
  if ((Number(info.mode) & 0o777) !== STATE_FILE_MODE) {
    await ensurePrivateFileMode(path, "Worker state");
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
  const validated = validatePersistedState(parsed);
  if (validated.kind === "legacy") {
    const credentialStore = getCredentialStore(stateDirectory, options);
    await credentialStore.set(validated.state.requestId, serializePrivateKey(validated.privateKey));
    const migrated: WorkerState = {
      ...validated.state,
      credentialStoreMode: credentialStore.mode,
      privateKey: validated.privateKey,
    };
    await replaceLegacyState(stateDirectory, raw, persistedState(migrated));
    return migrated;
  }

  const credentialStore = getCredentialStore(
    stateDirectory,
    options,
    validated.state.credentialStoreMode,
  );
  const storedKey = await credentialStore.get(validated.state.requestId);
  if (storedKey === null) {
    throw new WorkerProtocolError(
      "Worker private key is missing from its configured credential store",
    );
  }
  const privateKey = parseStoredPrivateKey(storedKey);
  assertKeyPair(privateKey, validated.state.publicKey);
  return { ...validated.state, privateKey };
}

/** Save the completed identity while preserving the original key and request ID. */
export async function saveWorkerIdentity(
  stateDirectory: string,
  state: WorkerState,
  identity: WorkerIdentity,
  options: WorkerStateOptions = {},
): Promise<WorkerState> {
  const completed: WorkerState = { ...state, identity };
  await replaceState(stateDirectory, completed, state, options);
  return completed;
}

/** Report the backend selected for this state without returning credential material. */
export async function credentialStorage(
  stateDirectory: string,
  options: WorkerStateOptions = {},
): Promise<WorkerCredentialStoreMode | null> {
  const state = await readWorkerState(stateDirectory, options);
  return state?.credentialStoreMode ?? null;
}

/**
 * Remove the selected OS/file credential and state. Local private-key and state
 * files are overwritten and synced before unlinking as a best-effort wipe.
 */
export async function forgetWorkerState(
  stateDirectory: string,
  options: WorkerStateOptions = {},
): Promise<void> {
  try {
    await ensurePrivateDirectory(stateDirectory);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }

  const path = join(stateDirectory, STATE_FILE_NAME);
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (isMissing(error)) return;
    throw new WorkerProtocolError("Worker state could not be opened for removal");
  }
  validatePrivateFile(info, MAX_STATE_BYTES, "Worker state", true);
  let raw: Buffer;
  try {
    raw = await readFile(path);
  } catch {
    throw new WorkerProtocolError("Worker state could not be read for removal");
  }
  if (raw.byteLength > MAX_STATE_BYTES) throw new WorkerProtocolError("Worker state is invalid");

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new WorkerProtocolError("Worker state is invalid");
  }
  if (
    !isRecord(parsed) ||
    (parsed.version !== 1 && parsed.version !== 2) ||
    typeof parsed.requestId !== "string" ||
    !PRIVATE_KEY_ID_PATTERN.test(parsed.requestId)
  ) {
    throw new WorkerProtocolError("Worker state is invalid");
  }

  const mode = storedCredentialStoreMode(parsed);
  if (parsed.version === 2 && !mode) throw new WorkerProtocolError("Worker state is invalid");
  if ((Number(info.mode) & 0o777) !== STATE_FILE_MODE) {
    await ensurePrivateFileMode(path, "Worker state");
  }
  const credentialStore = options.credentialStore
    ? getCredentialStore(stateDirectory, options, mode)
    : createWorkerCredentialStore(stateDirectory, {
        mode: mode ?? options.credentialStoreMode ?? configuredWorkerCredentialStoreMode(),
        keyringEntryFactory: options.keyringEntryFactory,
      });
  await credentialStore.delete(parsed.requestId);
  await wipeAndUnlinkPrivateFile(path, info, MAX_STATE_BYTES, "Worker state");
  await syncDirectory(stateDirectory);
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

async function writeNewState(
  stateDirectory: string,
  state: WorkerState,
  options: WorkerStateOptions,
): Promise<void> {
  await ensurePrivateDirectory(stateDirectory);
  const path = join(stateDirectory, STATE_FILE_NAME);
  const temporaryPath = join(stateDirectory, `.worker-state-${randomUUID()}.tmp`);
  let handle;
  let temporaryCreated = false;
  let statePublished = false;
  try {
    handle = await open(temporaryPath, "wx", STATE_FILE_MODE);
    temporaryCreated = true;
    await handle.chmod(STATE_FILE_MODE);
    await writeAndSync(handle, persistedState(state));
    await handle.close();
    handle = undefined;
    // link() atomically creates the final name without replacing pre-existing state.
    await link(temporaryPath, path);
    statePublished = true;
    await unlink(temporaryPath);
    await (options.stateDirectorySync ?? syncDirectory)(stateDirectory);
  } catch (error) {
    await handle?.close();
    if (temporaryCreated) await unlink(temporaryPath).catch(() => undefined);
    if (statePublished) {
      throw new PublishedWorkerStateError(
        "Worker state was published but its directory could not be durably synced; its credential was retained for recovery",
      );
    }
    if (isAlreadyExists(error)) {
      throw new WorkerProtocolError("Worker state already exists; refusing to overwrite it");
    }
    if (error instanceof WorkerProtocolError) throw error;
    throw new WorkerProtocolError("Worker state could not be created");
  }
}

class PublishedWorkerStateError extends WorkerProtocolError {}

async function replaceState(
  stateDirectory: string,
  nextState: WorkerState,
  expectedState: WorkerState,
  options: WorkerStateOptions,
): Promise<void> {
  await ensurePrivateDirectory(stateDirectory);
  const path = join(stateDirectory, STATE_FILE_NAME);
  const current = await readWorkerState(stateDirectory, options);
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
    await writeAndSync(handle, persistedState(nextState));
    await handle.close();
    handle = undefined;

    const latest = await readWorkerState(stateDirectory, options);
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

async function replaceLegacyState(
  stateDirectory: string,
  expectedContents: Buffer,
  nextState: PersistedWorkerState,
): Promise<void> {
  const path = join(stateDirectory, STATE_FILE_NAME);
  const temporaryPath = join(stateDirectory, `.worker-state-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporaryPath, "wx", STATE_FILE_MODE);
    await handle.chmod(STATE_FILE_MODE);
    await writeAndSync(handle, nextState);
    await handle.close();
    handle = undefined;
    const current = await readFile(path);
    if (!current.equals(expectedContents)) {
      throw new WorkerProtocolError("Worker state changed while migrating its private key");
    }
    await rename(temporaryPath, path);
    await syncDirectory(stateDirectory);
  } catch (error) {
    await handle?.close();
    await unlink(temporaryPath).catch(() => undefined);
    if (error instanceof WorkerProtocolError) throw error;
    throw new WorkerProtocolError("Legacy Worker state could not be migrated");
  }
}

interface PersistedWorkerState {
  version: 2;
  credentialStoreMode: WorkerCredentialStoreMode;
  setup: StoredWorkerSetup;
  requestId: string;
  publicKey: PublicP256Jwk;
  identity?: WorkerIdentity;
}

type ValidatedPersistedState =
  | {
      kind: "legacy";
      state: Omit<WorkerState, "credentialStoreMode" | "privateKey">;
      privateKey: PrivateP256Jwk;
    }
  | { kind: "external"; state: Omit<WorkerState, "privateKey"> };

function validatePersistedState(value: unknown): ValidatedPersistedState {
  if (!isRecord(value) || !isRecord(value.setup) || (value.version !== 1 && value.version !== 2)) {
    throw new WorkerProtocolError("Worker state is invalid");
  }

  const setup = validateStoredSetup(value.setup);
  if (typeof value.requestId !== "string" || !PRIVATE_KEY_ID_PATTERN.test(value.requestId)) {
    throw new WorkerProtocolError("Worker state is invalid");
  }
  const publicKey = validatePublicKey(value.publicKey);
  const identity = value.identity === undefined ? undefined : validateIdentity(value.identity);

  if (value.version === 1) {
    const privateKey = validatePrivateKey(value.privateKey);
    assertKeyPair(privateKey, publicKey);
    const state: Omit<WorkerState, "credentialStoreMode" | "privateKey"> = {
      version: 2,
      setup,
      requestId: value.requestId,
      publicKey,
      ...(identity ? { identity } : {}),
    };
    return { kind: "legacy", state, privateKey };
  }

  if (
    "privateKey" in value ||
    (value.credentialStoreMode !== "keyring" && value.credentialStoreMode !== "file")
  ) {
    throw new WorkerProtocolError("Worker state is invalid");
  }
  const state: Omit<WorkerState, "privateKey"> = {
    version: 2,
    credentialStoreMode: value.credentialStoreMode,
    setup,
    requestId: value.requestId,
    publicKey,
    ...(identity ? { identity } : {}),
  };
  return { kind: "external", state };
}

function validateStoredSetup(value: Record<string, unknown>): StoredWorkerSetup {
  if (
    Object.keys(value).length !== 5 ||
    value.version !== 1 ||
    typeof value.backendUrl !== "string" ||
    typeof value.convexUrl !== "string" ||
    typeof value.enrollmentId !== "string" ||
    typeof value.expiresAt !== "number" ||
    !Number.isSafeInteger(value.expiresAt) ||
    value.enrollmentId.length < 1 ||
    value.enrollmentId.length > 1024 ||
    /[\u0000-\u001f\u007f]/.test(value.enrollmentId)
  ) {
    throw new WorkerProtocolError("Worker state is invalid");
  }
  return {
    version: 1,
    backendUrl: validateOrigin(value.backendUrl, "backendUrl"),
    convexUrl: validateOrigin(value.convexUrl, "convexUrl"),
    enrollmentId: value.enrollmentId,
    expiresAt: value.expiresAt,
  };
}

function storedCredentialStoreMode(
  value: Record<string, unknown>,
): WorkerCredentialStoreMode | undefined {
  return value.version === 2 &&
    (value.credentialStoreMode === "keyring" || value.credentialStoreMode === "file")
    ? value.credentialStoreMode
    : undefined;
}

function persistedState(state: WorkerState): PersistedWorkerState {
  return {
    version: 2,
    credentialStoreMode: state.credentialStoreMode,
    setup: state.setup,
    requestId: state.requestId,
    publicKey: state.publicKey,
    ...(state.identity ? { identity: state.identity } : {}),
  };
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
    left.credentialStoreMode === right.credentialStoreMode &&
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
  state: PersistedWorkerState,
): Promise<void> {
  const contents = Buffer.from(`${JSON.stringify(state)}\n`, "utf8");
  if (contents.byteLength > MAX_STATE_BYTES)
    throw new WorkerProtocolError("Worker state is invalid");
  await handle.writeFile(contents);
  await handle.sync();
}

function getCredentialStore(
  stateDirectory: string,
  options: WorkerStateOptions,
  storedMode?: WorkerCredentialStoreMode,
): WorkerCredentialStore {
  const environmentMode = configuredWorkerCredentialStoreMode();
  const configuredMode =
    options.credentialStoreMode ?? (options.credentialStore ? undefined : environmentMode);
  if (storedMode && configuredMode && configuredMode !== "auto" && configuredMode !== storedMode) {
    throw new WorkerProtocolError(
      `Worker credentials use the ${storedMode} store; RADIUM_WORKER_CREDENTIAL_STORE is configured as ${configuredMode}`,
    );
  }
  if (options.credentialStore) {
    if (storedMode && options.credentialStore.mode !== storedMode) {
      throw new WorkerProtocolError("Injected Worker credential store does not match saved state");
    }
    return options.credentialStore;
  }
  return createWorkerCredentialStore(stateDirectory, {
    mode: storedMode ?? options.credentialStoreMode,
    keyringEntryFactory: options.keyringEntryFactory,
  });
}

function serializePrivateKey(privateKey: PrivateP256Jwk): string {
  return JSON.stringify(privateKey);
}

function parseStoredPrivateKey(value: string): PrivateP256Jwk {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new WorkerProtocolError("Worker private key credential is invalid");
  }
  return validatePrivateKey(parsed);
}

function assertKeyPair(privateKey: PrivateP256Jwk, publicKey: PublicP256Jwk): void {
  if (
    privateKey.kty !== publicKey.kty ||
    privateKey.crv !== publicKey.crv ||
    privateKey.x !== publicKey.x ||
    privateKey.y !== publicKey.y
  ) {
    throw new WorkerProtocolError("Worker state key pair is invalid");
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
