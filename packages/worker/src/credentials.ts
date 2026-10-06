import { link, lstat, open, readFile, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  ensurePrivateDirectory,
  ensurePrivateFileMode,
  syncDirectory,
  validatePrivateFile,
  wipeAndUnlinkPrivateFile,
} from "./private-files.js";
import { WorkerProtocolError } from "./protocol.js";

const KEYRING_SERVICE = "Radium Worker";
const CREDENTIAL_FILE_MODE = 0o600;
const MAX_CREDENTIAL_BYTES = 16 * 1024;

export type WorkerCredentialStoreMode = "keyring" | "file";
export type WorkerCredentialStorePreference = "auto" | WorkerCredentialStoreMode;

/**
 * Durable storage for the Worker's P-256 private JWK, addressed by the stable
 * enrollment request ID. Machine JWTs are intentionally never stored here.
 */
export interface WorkerCredentialStore {
  readonly mode: WorkerCredentialStoreMode;
  get(requestId: string): Promise<string | null>;
  set(requestId: string, privateJwk: string): Promise<void>;
  delete(requestId: string): Promise<void>;
}

export interface WorkerCredentialStoreOptions {
  /** Selects storage explicitly. Defaults to keyring. */
  mode?: WorkerCredentialStorePreference;
  /** Native keyring adapter seam for deterministic tests; never used as fallback. */
  keyringEntryFactory?: KeyringEntryFactory;
}

export interface KeyringEntry {
  getPassword(): Promise<string | undefined>;
  setPassword(password: string): Promise<void>;
  deleteCredential(): Promise<boolean>;
}

export type KeyringEntryFactory = (account: string) => Promise<KeyringEntry>;

/** Validate process configuration before choosing the default credential store. */
export function configuredWorkerCredentialStoreMode(): WorkerCredentialStorePreference | undefined {
  const value = process.env.RADIUM_WORKER_CREDENTIAL_STORE;
  if (value !== undefined && value !== "auto" && value !== "keyring" && value !== "file") {
    throw new WorkerProtocolError(
      "RADIUM_WORKER_CREDENTIAL_STORE must be set to auto, keyring, or file",
    );
  }
  return value;
}

/**
 * Build the selected durable store. Production defaults to an OS credential
 * store; the protected-file option is deliberately opt-in for headless hosts.
 */
export function createWorkerCredentialStore(
  stateDirectory: string,
  options: WorkerCredentialStoreOptions = {},
): WorkerCredentialStore {
  const configuredMode = configuredWorkerCredentialStoreMode();
  const mode = options.mode ?? configuredMode ?? "keyring";
  if (mode === "file") return new ProtectedFileCredentialStore(stateDirectory);
  const keyring = new OsCredentialStore(options.keyringEntryFactory ?? nativeKeyringEntry);
  if (mode === "keyring") return keyring;
  return new AutomaticCredentialStore(keyring, new ProtectedFileCredentialStore(stateDirectory));
}

class AutomaticCredentialStore implements WorkerCredentialStore {
  private selected: WorkerCredentialStore;

  constructor(
    private readonly keyring: WorkerCredentialStore,
    private readonly file: WorkerCredentialStore,
  ) {
    this.selected = keyring;
  }

  get mode(): WorkerCredentialStoreMode {
    return this.selected.mode;
  }

  get(requestId: string): Promise<string | null> {
    return this.selected.get(requestId);
  }

  async set(requestId: string, privateJwk: string): Promise<void> {
    try {
      await this.keyring.set(requestId, privateJwk);
      this.selected = this.keyring;
    } catch (error) {
      if (!(error instanceof CredentialStoreUnavailableError)) throw error;
      await this.keyring.delete(requestId).catch(() => undefined);
      await this.file.set(requestId, privateJwk);
      this.selected = this.file;
    }
  }

  async delete(requestId: string): Promise<void> {
    if (this.selected.mode === "file") return this.file.delete(requestId);
    try {
      await this.keyring.delete(requestId);
    } catch (error) {
      if (!(error instanceof CredentialStoreUnavailableError)) throw error;
      // Legacy state has no recorded backend. A failed keyring attempt is safe
      // to follow with removal of a possible interrupted fallback migration.
    }
    await this.file.delete(requestId);
  }
}

class OsCredentialStore implements WorkerCredentialStore {
  readonly mode = "keyring" as const;

  constructor(private readonly entryFactory: KeyringEntryFactory) {}

  async get(requestId: string): Promise<string | null> {
    try {
      return (await (await this.entryFactory(requestId)).getPassword()) ?? null;
    } catch {
      throw unavailableKeyringError("read");
    }
  }

  async set(requestId: string, privateJwk: string): Promise<void> {
    try {
      const entry = await this.entryFactory(requestId);
      const existing = await entry.getPassword();
      if (existing !== undefined && existing !== privateJwk) {
        throw new WorkerProtocolError("A different Worker key already uses this credential entry");
      }
      if (existing === undefined) await entry.setPassword(privateJwk);
    } catch (error) {
      if (error instanceof WorkerProtocolError) throw error;
      throw unavailableKeyringError("write");
    }
  }

  async delete(requestId: string): Promise<void> {
    try {
      await (await this.entryFactory(requestId)).deleteCredential();
    } catch {
      throw unavailableKeyringError("remove");
    }
  }
}

class ProtectedFileCredentialStore implements WorkerCredentialStore {
  readonly mode = "file" as const;

  constructor(private readonly stateDirectory: string) {}

  async get(requestId: string): Promise<string | null> {
    await ensurePrivateDirectory(this.stateDirectory);
    const path = credentialPath(this.stateDirectory, requestId);
    let info;
    try {
      info = await lstat(path);
    } catch (error) {
      if (isMissing(error)) return null;
      throw new WorkerProtocolError("Worker private key file could not be opened");
    }
    validatePrivateFile(info, MAX_CREDENTIAL_BYTES, "Worker private key");
    if ((Number(info.mode) & 0o777) !== CREDENTIAL_FILE_MODE) {
      await ensurePrivateFileMode(path, "Worker private key");
    }

    let secret: Buffer;
    try {
      secret = await readFile(path);
    } catch {
      throw new WorkerProtocolError("Worker private key file could not be read");
    }
    if (secret.byteLength > MAX_CREDENTIAL_BYTES) {
      throw new WorkerProtocolError("Worker private key file is invalid");
    }
    return secret.toString("utf8");
  }

  async set(requestId: string, privateJwk: string): Promise<void> {
    if (Buffer.byteLength(privateJwk, "utf8") > MAX_CREDENTIAL_BYTES) {
      throw new WorkerProtocolError("Worker private key is invalid");
    }
    await ensurePrivateDirectory(this.stateDirectory);
    const path = credentialPath(this.stateDirectory, requestId);
    const existing = await this.get(requestId);
    if (existing !== null) {
      if (existing !== privateJwk) {
        throw new WorkerProtocolError("A different Worker key already uses this credential file");
      }
      return;
    }

    const temporaryPath = join(this.stateDirectory, `.worker-credential-${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(temporaryPath, "wx", CREDENTIAL_FILE_MODE);
      await handle.chmod(CREDENTIAL_FILE_MODE);
      await handle.writeFile(privateJwk, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await link(temporaryPath, path);
      await unlink(temporaryPath);
      await syncDirectory(this.stateDirectory);
    } catch (error) {
      await handle?.close();
      await unlink(temporaryPath).catch(() => undefined);
      if (isAlreadyExists(error)) {
        const raced = await this.get(requestId);
        if (raced === privateJwk) return;
        throw new WorkerProtocolError("A different Worker key already uses this credential file");
      }
      if (error instanceof WorkerProtocolError) throw error;
      throw new WorkerProtocolError("Worker private key could not be saved to the protected file");
    }
  }

  async delete(requestId: string): Promise<void> {
    await ensurePrivateDirectory(this.stateDirectory);
    const path = credentialPath(this.stateDirectory, requestId);
    let info;
    try {
      info = await lstat(path);
    } catch (error) {
      if (isMissing(error)) return;
      throw new WorkerProtocolError("Worker private key file could not be opened for removal");
    }
    await wipeAndUnlinkPrivateFile(path, info, MAX_CREDENTIAL_BYTES, "Worker private key");
  }
}

async function nativeKeyringEntry(account: string): Promise<KeyringEntry> {
  const { AsyncEntry } = await import("@napi-rs/keyring");
  const options =
    process.platform === "linux" ? { linux: { store: "secret-service" as const } } : undefined;
  return new AsyncEntry(KEYRING_SERVICE, account, options);
}

function credentialPath(stateDirectory: string, requestId: string): string {
  if (!isRequestId(requestId)) throw new WorkerProtocolError("Worker state is invalid");
  return join(stateDirectory, `.worker-credential-${requestId}.json`);
}

class CredentialStoreUnavailableError extends WorkerProtocolError {}

function unavailableKeyringError(
  operation: "read" | "write" | "remove",
): CredentialStoreUnavailableError {
  if (operation === "write") {
    return new CredentialStoreUnavailableError(
      "Worker OS credential store could not save the private key; set RADIUM_WORKER_CREDENTIAL_STORE=file or auto to explicitly permit the protected-file fallback",
    );
  }
  const action = operation === "read" ? "read" : "removed";
  const recovery =
    operation === "read"
      ? "Unlock or restore the saved OS credential store and retry; an existing Worker identity never downgrades to file storage"
      : "Unlock or restore the saved OS credential store and retry forgetting; existing Worker identities never downgrade to file storage";
  return new CredentialStoreUnavailableError(
    `Worker OS credential could not be ${action}. ${recovery}`,
  );
}

function isRequestId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isMissing(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return isRecord(error) && error.code === "EEXIST";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
