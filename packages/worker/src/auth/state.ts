import { link, lstat, open, readFile, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { exportJWK, generateKeyPair } from "jose";
import {
  encryptionPublicKeyFromSeed,
  equalBytes,
  fromBase64Url,
  signingPublicKeyFromSeed,
  toBase64Url,
} from "radium-crypto";
import {
  configuredWorkerCredentialStoreMode,
  createWorkerCredentialStore,
  e2eeCredentialAccount,
  type KeyringEntryFactory,
  type WorkerCredentialStore,
  type WorkerCredentialStoreMode,
  type WorkerCredentialStorePreference,
} from "./credentials.js";
import { createGatewayKeyStore } from "./gateway.js";
import {
  ensurePrivateDirectory,
  ensurePrivateFileMode,
  syncDirectory,
  validatePrivateFile,
  wipeAndUnlinkPrivateFile,
} from "./private-files.js";
import { deleteTrustMarks, TrustMarks } from "../e2ee/marks.js";
import {
  type PrivateP256Jwk,
  type PublicP256Jwk,
  type StoredWorkerSetup,
  type WorkerIdentity,
  type WorkerOwnerPin,
  type WorkerSetup,
  WorkerProtocolError,
  storedSetup,
  validateOrigin,
  validateOwnerPin,
} from "../protocol.js";

const STATE_FILE_NAME = "worker-state.json";
const STATE_FILE_MODE = 0o600;
const MAX_STATE_BYTES = 32 * 1024;
const PRIVATE_KEY_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Public half of a paired Worker's E2EE key set (Keys.md "Workers") and the owner it pinned from the
 * setup or pairing code. Persisted in the state file; byte fields are unpadded base64url.
 */
export interface WorkerE2eeState {
  keyId: string;
  suite: 1;
  encryptionPublicKey: string;
  signingPublicKey: string;
  owner: WorkerOwnerPin;
}

/** A paired Worker's E2EE keys with their private seeds, hydrated from the credential store. */
export interface WorkerE2eeKeys extends WorkerE2eeState {
  encryptionSeed: Uint8Array;
  signingSeed: Uint8Array;
}

/**
 * Crash-recovery state kept outside future agent workloads.
 * `setup` retains only URLs, selector and expiry, never the one-time token or pairing secret.
 * The private key is hydrated in memory from the selected credential store;
 * state files since version 2 contain its public key and store mode, never the private
 * JWK. The key and requestId are made durable before networking, so a lost
 * completion response can be recovered without creating a second Worker.
 * `identity` is added only after enrollment or recovery succeeds. Machine JWTs
 * are short-lived and are not part of this durable state. Version 3 adds `e2ee` once the Worker
 * is paired; its seeds live in the credential store next to the machine key.
 */
export interface WorkerState {
  version: 3;
  credentialStoreMode: WorkerCredentialStoreMode;
  setup: StoredWorkerSetup;
  requestId: string;
  privateKey: PrivateP256Jwk;
  publicKey: PublicP256Jwk;
  identity?: WorkerIdentity;
  e2ee?: WorkerE2eeKeys;
}

/** Storage configuration and deterministic credential/durability test seams. */
export interface WorkerStateOptions {
  credentialStoreMode?: WorkerCredentialStorePreference;
  credentialStore?: WorkerCredentialStore;
  keyringEntryFactory?: KeyringEntryFactory;
  stateDirectorySync?: (path: string) => Promise<void>;
  /**
   * Read the state without hydrating E2EE seeds (`pair` replaces them, so it must work even
   * when they were lost). Never use the result to act as a paired Worker.
   */
  skipE2eeKeys?: boolean;
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
    version: 3,
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
    await lstat(stateDirectory);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }

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
    await replaceStateContents(stateDirectory, raw, persistedState(migrated));
    return migrated;
  }

  const { e2ee: persistedE2ee, ...persisted } = validated.state;
  const credentialStore = getCredentialStore(
    stateDirectory,
    options,
    persisted.credentialStoreMode,
  );
  const storedKey = await credentialStore.get(persisted.requestId);
  if (storedKey === null) {
    throw new WorkerProtocolError(
      "Worker private key is missing from its configured credential store",
    );
  }
  const privateKey = parseStoredPrivateKey(storedKey);
  assertKeyPair(privateKey, persisted.publicKey);
  const state: WorkerState = { ...persisted, privateKey };
  // Version 2 differs only by lacking E2EE keys; rewrite it as version 3 like the v1 migration.
  if (validated.migrate) {
    await replaceStateContents(stateDirectory, raw, persistedState(state));
  }
  if (persistedE2ee && !options.skipE2eeKeys) {
    state.e2ee = await loadE2eeKeys(credentialStore, persisted.requestId, persistedE2ee);
  }
  return state;
}

/**
 * Durably replaces the Worker's E2EE keys and owner pin (`setup` with a v2 code, or `pair`). The
 * new seeds are saved under their own credential entry before the state names them, and the
 * previous entry is removed only afterwards, so a crash never leaves the state pointing at
 * missing seeds.
 */
export async function saveWorkerE2ee(
  stateDirectory: string,
  state: WorkerState,
  keys: WorkerE2eeKeys,
  options: WorkerStateOptions = {},
): Promise<WorkerState> {
  const credentialStore = getCredentialStore(stateDirectory, options, state.credentialStoreMode);
  const account = e2eeCredentialAccount(state.requestId, keys.keyId);
  // Record the account before writing its secret so forget can clean up after a crash or failed
  // replacement, even when the state file never came to reference this key.
  const marks = await TrustMarks.open(stateDirectory);
  await marks.pin(`credential:${keys.keyId}`, keys.keyId);
  await credentialStore.set(
    account,
    JSON.stringify({
      v: 1,
      encryptionSeed: toBase64Url(keys.encryptionSeed),
      signingSeed: toBase64Url(keys.signingSeed),
    }),
  );

  const path = join(stateDirectory, STATE_FILE_NAME);
  const next: WorkerState = { ...state, e2ee: keys };
  let previousKeyId: string | undefined;
  try {
    const raw = await readFile(path);
    const current = validatePersistedState(JSON.parse(raw.toString("utf8")));
    if (
      current.kind !== "external" ||
      current.state.requestId !== state.requestId ||
      current.state.credentialStoreMode !== state.credentialStoreMode ||
      current.state.publicKey.x !== state.publicKey.x ||
      current.state.publicKey.y !== state.publicKey.y ||
      !current.state.identity ||
      !state.identity ||
      !sameIdentity(current.state.identity, state.identity)
    ) {
      throw new WorkerProtocolError("Worker state changed while pairing; refusing to replace it");
    }
    previousKeyId = current.state.e2ee?.keyId;
    await replaceStateContents(stateDirectory, raw, persistedState(next));
  } catch (error) {
    // A failed directory sync can follow a successful rename; never orphan the state's seeds.
    if (!(await stateNamesE2eeKey(path, keys.keyId))) {
      await credentialStore.delete(account).catch(() => undefined);
    }
    if (error instanceof WorkerProtocolError) throw error;
    throw new WorkerProtocolError("Worker state could not be updated");
  }
  if (previousKeyId && previousKeyId !== keys.keyId) {
    await credentialStore
      .delete(e2eeCredentialAccount(state.requestId, previousKeyId))
      .catch(() => undefined);
  }
  return next;
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
    await lstat(stateDirectory);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }

  try {
    await ensurePrivateDirectory(stateDirectory);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  await createGatewayKeyStore(stateDirectory).delete();
  const marks = await TrustMarks.open(stateDirectory);

  const path = join(stateDirectory, STATE_FILE_NAME);
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (isMissing(error)) {
      await deleteTrustMarks(stateDirectory);
      return;
    }
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
    (parsed.version !== 1 && parsed.version !== 2 && parsed.version !== 3) ||
    typeof parsed.requestId !== "string" ||
    !PRIVATE_KEY_ID_PATTERN.test(parsed.requestId)
  ) {
    throw new WorkerProtocolError("Worker state is invalid");
  }

  const mode = storedCredentialStoreMode(parsed);
  if (parsed.version !== 1 && !mode) throw new WorkerProtocolError("Worker state is invalid");
  const e2eeKeyId =
    isRecord(parsed.e2ee) && typeof parsed.e2ee.keyId === "string" ? parsed.e2ee.keyId : undefined;
  if ((Number(info.mode) & 0o777) !== STATE_FILE_MODE) {
    await ensurePrivateFileMode(path, "Worker state");
  }
  const credentialStore = options.credentialStore
    ? getCredentialStore(stateDirectory, options, mode)
    : createWorkerCredentialStore(stateDirectory, {
        mode: mode ?? options.credentialStoreMode ?? configuredWorkerCredentialStoreMode(),
        keyringEntryFactory: options.keyringEntryFactory,
      });
  const keyIds = new Set(marks.credentialKeyIds());
  if (e2eeKeyId) keyIds.add(e2eeKeyId);
  for (const keyId of keyIds) {
    await credentialStore.delete(e2eeCredentialAccount(parsed.requestId, keyId));
  }
  await credentialStore.delete(parsed.requestId);
  await wipeAndUnlinkPrivateFile(path, info, MAX_STATE_BYTES, "Worker state");
  await deleteTrustMarks(stateDirectory);
  await syncDirectory(stateDirectory);
}

/** Refuse a different setup code when a pending or completed identity already exists. */
export function assertSetupMatches(state: WorkerState, setup: WorkerSetup): void {
  if (
    state.setup.version !== setup.version ||
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

/** Atomically replace the state file only if it still holds `expectedContents`. */
async function replaceStateContents(
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
      throw new WorkerProtocolError("Worker state changed while it was being updated");
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

async function stateNamesE2eeKey(path: string, keyId: string): Promise<boolean> {
  try {
    const current = validatePersistedState(JSON.parse((await readFile(path)).toString("utf8")));
    return current.kind === "external" && current.state.e2ee?.keyId === keyId;
  } catch {
    return false;
  }
}

interface PersistedWorkerState {
  version: 3;
  credentialStoreMode: WorkerCredentialStoreMode;
  setup: StoredWorkerSetup;
  requestId: string;
  publicKey: PublicP256Jwk;
  identity?: WorkerIdentity;
  e2ee?: WorkerE2eeState;
}

type ValidatedPersistedState =
  | {
      kind: "legacy";
      state: Omit<WorkerState, "credentialStoreMode" | "privateKey" | "e2ee">;
      privateKey: PrivateP256Jwk;
    }
  | {
      kind: "external";
      state: PersistedWorkerState;
      /** Version 2 file: rewrite as version 3. */
      migrate: boolean;
    };

function validatePersistedState(value: unknown): ValidatedPersistedState {
  if (
    !isRecord(value) ||
    !isRecord(value.setup) ||
    (value.version !== 1 && value.version !== 2 && value.version !== 3)
  ) {
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
    const state: Omit<WorkerState, "credentialStoreMode" | "privateKey" | "e2ee"> = {
      version: 3,
      setup,
      requestId: value.requestId,
      publicKey,
      ...(identity ? { identity } : {}),
    };
    return { kind: "legacy", state, privateKey };
  }

  if (
    "privateKey" in value ||
    (value.credentialStoreMode !== "keyring" && value.credentialStoreMode !== "file") ||
    (value.version === 2 && value.e2ee !== undefined)
  ) {
    throw new WorkerProtocolError("Worker state is invalid");
  }
  // E2EE keys belong to an enrolled identity; a pending enrollment cannot be paired.
  const e2ee = value.e2ee === undefined ? undefined : validateE2eeState(value.e2ee);
  if (e2ee && !identity) throw new WorkerProtocolError("Worker state is invalid");
  return {
    kind: "external",
    state: {
      version: 3,
      credentialStoreMode: value.credentialStoreMode,
      setup,
      requestId: value.requestId,
      publicKey,
      ...(identity ? { identity } : {}),
      ...(e2ee ? { e2ee } : {}),
    },
    migrate: value.version === 2,
  };
}

function validateE2eeState(value: unknown): WorkerE2eeState {
  const invalid = "Worker E2EE state is invalid";
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 5 ||
    value.suite !== 1 ||
    typeof value.keyId !== "string" ||
    typeof value.encryptionPublicKey !== "string" ||
    typeof value.signingPublicKey !== "string"
  ) {
    throw new WorkerProtocolError(invalid);
  }
  try {
    if (
      fromBase64Url(value.keyId).length !== 16 ||
      fromBase64Url(value.encryptionPublicKey).length !== 1216 ||
      fromBase64Url(value.signingPublicKey).length !== 32
    ) {
      throw new Error();
    }
  } catch {
    throw new WorkerProtocolError(invalid);
  }
  return {
    keyId: value.keyId,
    suite: 1,
    encryptionPublicKey: value.encryptionPublicKey,
    signingPublicKey: value.signingPublicKey,
    owner: validateOwnerPin(value.owner, invalid),
  };
}

/** Hydrate E2EE seeds and check they derive the persisted public keys. */
async function loadE2eeKeys(
  credentialStore: WorkerCredentialStore,
  requestId: string,
  e2ee: WorkerE2eeState,
): Promise<WorkerE2eeKeys> {
  const stored = await credentialStore.get(e2eeCredentialAccount(requestId, e2ee.keyId));
  if (stored === null) {
    throw new WorkerProtocolError(
      "Worker E2EE keys are missing from the credential store; run `pair` with a new pairing code",
    );
  }
  let encryptionSeed: Uint8Array;
  let signingSeed: Uint8Array;
  try {
    const parsed: unknown = JSON.parse(stored);
    if (
      !isRecord(parsed) ||
      parsed.v !== 1 ||
      typeof parsed.encryptionSeed !== "string" ||
      typeof parsed.signingSeed !== "string"
    ) {
      throw new Error();
    }
    encryptionSeed = fromBase64Url(parsed.encryptionSeed);
    signingSeed = fromBase64Url(parsed.signingSeed);
    if (encryptionSeed.length !== 32 || signingSeed.length !== 32) throw new Error();
  } catch {
    throw new WorkerProtocolError("Worker E2EE key credential is invalid");
  }
  if (
    !equalBytes(
      await encryptionPublicKeyFromSeed(encryptionSeed),
      fromBase64Url(e2ee.encryptionPublicKey),
    ) ||
    !equalBytes(await signingPublicKeyFromSeed(signingSeed), fromBase64Url(e2ee.signingPublicKey))
  ) {
    throw new WorkerProtocolError("Worker E2EE keys do not match the saved state");
  }
  return { ...e2ee, encryptionSeed, signingSeed };
}

function validateStoredSetup(value: Record<string, unknown>): StoredWorkerSetup {
  if (
    Object.keys(value).length !== 5 ||
    (value.version !== 1 && value.version !== 2) ||
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
    version: value.version === 2 ? 2 : 1,
    backendUrl: validateOrigin(value.backendUrl, "backendUrl"),
    convexUrl: validateOrigin(value.convexUrl, "convexUrl"),
    enrollmentId: value.enrollmentId,
    expiresAt: value.expiresAt,
  };
}

function storedCredentialStoreMode(
  value: Record<string, unknown>,
): WorkerCredentialStoreMode | undefined {
  return (value.version === 2 || value.version === 3) &&
    (value.credentialStoreMode === "keyring" || value.credentialStoreMode === "file")
    ? value.credentialStoreMode
    : undefined;
}

function persistedState(state: WorkerState): PersistedWorkerState {
  return {
    version: 3,
    credentialStoreMode: state.credentialStoreMode,
    setup: state.setup,
    requestId: state.requestId,
    publicKey: state.publicKey,
    ...(state.identity ? { identity: state.identity } : {}),
    ...(state.e2ee
      ? {
          e2ee: {
            keyId: state.e2ee.keyId,
            suite: state.e2ee.suite,
            encryptionPublicKey: state.e2ee.encryptionPublicKey,
            signingPublicKey: state.e2ee.signingPublicKey,
            owner: state.e2ee.owner,
          },
        }
      : {}),
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
