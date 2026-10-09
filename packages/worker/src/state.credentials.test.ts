import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportJWK, generateKeyPair } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  configuredWorkerCredentialStoreMode,
  createWorkerCredentialStore,
  type KeyringEntryFactory,
  type WorkerCredentialStore,
} from "./auth/credentials.js";
import {
  WorkerProtocolError,
  type PrivateP256Jwk,
  type PublicP256Jwk,
  type WorkerSetup,
} from "./protocol.js";
import {
  createPendingState,
  credentialStorage,
  forgetWorkerState,
  readWorkerState,
  saveWorkerIdentity,
  type WorkerState,
} from "./auth/state.js";

const directories: string[] = [];
const requestId = "2f1dd46c-d9ee-4614-8f12-1ce8c9bec056";

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

beforeEach(() => {
  vi.stubEnv("RADIUM_WORKER_CREDENTIAL_STORE", "file");
});

describe("Worker credential persistence", () => {
  it("does not create a missing state directory when reading or forgetting state", async () => {
    const directory = await newStateDirectory();

    await expect(readWorkerState(directory)).resolves.toBeNull();
    await expect(readdir(directory)).rejects.toMatchObject({ code: "ENOENT" });

    await expect(forgetWorkerState(directory)).resolves.toBeUndefined();
    await expect(readdir(directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([null, undefined])(
    "can save, forget, and re-enroll when native missing entries return %s",
    async (missing) => {
      const directory = await newStateDirectory();
      const values = new Map<string, string>();
      const keyringEntryFactory: KeyringEntryFactory = async (account) => ({
        async getPassword() {
          return values.get(account) ?? missing;
        },
        async setPassword(password) {
          values.set(account, password);
        },
        async deleteCredential() {
          return values.delete(account);
        },
      });
      const options = { credentialStoreMode: "keyring" as const, keyringEntryFactory };

      const first = await createPendingState(directory, makeSetup(), options);
      expect((await readWorkerState(directory, options))?.privateKey).toEqual(first.privateKey);
      expect(values.size).toBe(1);

      // Re-saving the same credential is idempotent; a genuine conflict remains denied.
      const store = createWorkerCredentialStore(directory, {
        mode: "keyring",
        keyringEntryFactory,
      });
      await store.set(first.requestId, JSON.stringify(first.privateKey));
      await expect(store.set(first.requestId, "different-private-key")).rejects.toThrow(
        "A different Worker key already uses this credential entry",
      );
      expect(values.get(first.requestId)).toBe(JSON.stringify(first.privateKey));

      await saveWorkerIdentity(
        directory,
        first,
        {
          workerId: "previous-worker-id",
          keyId: "previous-key-id",
          workspaceId: "workspace-id",
          identityEpoch: 1,
        },
        options,
      );

      await forgetWorkerState(directory, options);
      expect(values.size).toBe(0);
      await expect(readWorkerState(directory, options)).resolves.toBeNull();

      const second = await createPendingState(directory, makeSetup(), options);
      expect(second.requestId).not.toBe(first.requestId);
      expect(second.privateKey.d).not.toBe(first.privateKey.d);
      expect((await readWorkerState(directory, options))?.privateKey).toEqual(second.privateKey);
      expect(values.size).toBe(1);

      await forgetWorkerState(directory, options);
      expect(values.size).toBe(0);
    },
  );

  it("honors keyring mode under Vitest when a deterministic adapter is injected", async () => {
    vi.stubEnv("VITEST", "true");
    vi.stubEnv("VITEST_WORKER_ID", "1");
    vi.stubEnv("RADIUM_WORKER_CREDENTIAL_STORE", "keyring");
    const directory = await newStateDirectory();
    const values = new Map<string, string>();
    const keyringEntryFactory: KeyringEntryFactory = async (account) => ({
      async getPassword() {
        return values.get(account);
      },
      async setPassword(password) {
        values.set(account, password);
      },
      async deleteCredential() {
        return values.delete(account);
      },
    });
    const store = createWorkerCredentialStore(directory, { keyringEntryFactory });

    expect(configuredWorkerCredentialStoreMode()).toBe("keyring");
    expect(store.mode).toBe("keyring");
    await store.set(requestId, "mock-private-key");
    expect(values.get(requestId)).toBe("mock-private-key");
    await expect(readdir(directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("treats saved-key read and removal failures as keyring recovery, not fallback", async () => {
    const directory = await newStateDirectory();
    const store = createWorkerCredentialStore(directory, {
      mode: "keyring",
      keyringEntryFactory: async () => {
        throw new Error("simulated locked credential store");
      },
    });

    await expect(store.get(requestId)).rejects.toThrow(
      "Unlock or restore the saved OS credential store and retry",
    );
    await expect(store.delete(requestId)).rejects.toThrow(
      "Unlock or restore the saved OS credential store and retry forgetting",
    );
    await expect(readdir(directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("stores the private JWK in the injected keyring, not the state file", async () => {
    const directory = await newStateDirectory();
    const store = memoryCredentialStore("keyring");
    const state = await createPendingState(directory, makeSetup(), { credentialStore: store });
    const restored = await readWorkerState(directory, { credentialStore: store });
    const persistedText = await readFile(join(directory, "worker-state.json"), "utf8");

    expect(state.credentialStoreMode).toBe("keyring");
    expect(restored?.privateKey).toEqual(state.privateKey);
    expect(await credentialStorage(directory, { credentialStore: store })).toBe("keyring");
    expect(persistedText).not.toContain(state.privateKey.d);
    expect(JSON.parse(persistedText)).not.toHaveProperty("privateKey");
  });

  it("keeps the credential if state publication succeeds but directory sync fails", async () => {
    const directory = await newStateDirectory();

    await expect(
      createPendingState(directory, makeSetup(), {
        credentialStoreMode: "file",
        stateDirectorySync: async () => {
          throw new Error("simulated post-publication sync failure");
        },
      }),
    ).rejects.toThrow("credential was retained for recovery");

    const published = JSON.parse(await readFile(join(directory, "worker-state.json"), "utf8"));
    const credentialPath = join(directory, `.worker-credential-${published.requestId}.json`);
    expect(await readFile(credentialPath, "utf8")).toContain('"d"');
    const restored = await readWorkerState(directory);
    expect(restored?.requestId).toBe(published.requestId);
    expect(restored?.privateKey.d).toBeDefined();
  });

  it("migrates a legacy private-key state without changing its recovery identity", async () => {
    const directory = await newStateDirectory();
    const legacy = await makeLegacyState();
    const statePath = join(directory, "worker-state.json");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(statePath, `${JSON.stringify(legacy)}\n`, { mode: 0o600 });
    const store = memoryCredentialStore("keyring");

    const migrated = await readWorkerState(directory, { credentialStore: store });
    const storedText = await readFile(statePath, "utf8");

    expect(migrated).toMatchObject({
      requestId: legacy.requestId,
      setup: legacy.setup,
      publicKey: legacy.publicKey,
      identity: legacy.identity,
      privateKey: legacy.privateKey,
      credentialStoreMode: "keyring",
    });
    expect(store.values.get(legacy.requestId)).toBe(JSON.stringify(legacy.privateKey));
    expect(JSON.parse(storedText)).toMatchObject({ version: 2, credentialStoreMode: "keyring" });
    expect(JSON.parse(storedText)).not.toHaveProperty("privateKey");
  });

  it("allows auto fallback visibly while an explicitly selected missing keyring fails closed", async () => {
    const fallbackDirectory = await newStateDirectory();
    const keyringEntryFactory: KeyringEntryFactory = async () => {
      throw new Error("simulated unavailable keyring");
    };
    const fallbackState = await createPendingState(fallbackDirectory, makeSetup(), {
      credentialStoreMode: "auto",
      keyringEntryFactory,
    });

    expect(fallbackState.credentialStoreMode).toBe("file");
    expect(await credentialStorage(fallbackDirectory)).toBe("file");

    const legacyDirectory = await newStateDirectory();
    const legacy = await makeLegacyState();
    await mkdir(legacyDirectory, { recursive: true, mode: 0o700 });
    await writeFile(join(legacyDirectory, "worker-state.json"), JSON.stringify(legacy), {
      mode: 0o600,
    });
    const migrated = await readWorkerState(legacyDirectory, {
      credentialStoreMode: "auto",
      keyringEntryFactory,
    });
    expect(migrated?.requestId).toBe(legacy.requestId);
    expect(migrated?.credentialStoreMode).toBe("file");
    expect(
      JSON.parse(await readFile(join(legacyDirectory, "worker-state.json"), "utf8")),
    ).toMatchObject({
      version: 2,
      credentialStoreMode: "file",
    });

    const strictDirectory = await newStateDirectory();
    await expect(
      createPendingState(strictDirectory, makeSetup(), {
        credentialStoreMode: "keyring",
        keyringEntryFactory,
      }),
    ).rejects.toThrow("OS credential store could not save the private key");
    await expect(readWorkerState(strictDirectory)).resolves.toBeNull();
    await expect(readdir(strictDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a selected keyring's failure instead of reading the local fallback", async () => {
    const directory = await newStateDirectory();
    const state = await createPendingState(directory, makeSetup(), { credentialStoreMode: "file" });

    await expect(
      readWorkerState(directory, {
        credentialStoreMode: "keyring",
        keyringEntryFactory: async () => {
          throw new Error("simulated unavailable keyring");
        },
      }),
    ).rejects.toThrow("configured as keyring");
    expect(state.credentialStoreMode).toBe("file");
  });

  it("forgets both the persisted state and protected-file credential", async () => {
    const directory = await newStateDirectory();
    const state = await createPendingState(directory, makeSetup(), { credentialStoreMode: "file" });
    const statePath = join(directory, "worker-state.json");
    const credentialPath = join(directory, `.worker-credential-${state.requestId}.json`);
    expect((await lstat(credentialPath)).mode & 0o777).toBe(0o600);
    await chmod(statePath, 0o644);
    await chmod(credentialPath, 0o644);

    await forgetWorkerState(directory);

    await expect(readFile(statePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(credentialPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readWorkerState(directory)).resolves.toBeNull();
  });

  it("preserves unknown state versions without deleting an injected credential", async () => {
    const directory = await newStateDirectory();
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const statePath = join(directory, "worker-state.json");
    const contents = `${JSON.stringify({ version: 3, requestId })}\n`;
    await writeFile(statePath, contents, { mode: 0o600 });
    const values = new Map([[requestId, "credential-sentinel"]]);
    let deleteCalls = 0;
    const store: WorkerCredentialStore = {
      mode: "keyring",
      async get(id) {
        return values.get(id) ?? null;
      },
      async set(id, secret) {
        values.set(id, secret);
      },
      async delete(id) {
        deleteCalls += 1;
        values.delete(id);
      },
    };

    await expect(forgetWorkerState(directory, { credentialStore: store })).rejects.toThrow(
      "Worker state is invalid",
    );

    expect(await readFile(statePath, "utf8")).toBe(contents);
    expect(deleteCalls).toBe(0);
    expect(values.get(requestId)).toBe("credential-sentinel");
  });
});

function memoryCredentialStore(mode: "keyring" | "file"): WorkerCredentialStore & {
  values: Map<string, string>;
} {
  const values = new Map<string, string>();
  return {
    mode,
    values,
    async get(id) {
      return values.get(id) ?? null;
    },
    async set(id, secret) {
      const current = values.get(id);
      if (current !== undefined && current !== secret) {
        throw new WorkerProtocolError("conflicting test credential");
      }
      values.set(id, secret);
    },
    async delete(id) {
      values.delete(id);
    },
  };
}

async function makeLegacyState(): Promise<{
  version: 1;
  setup: WorkerState["setup"];
  requestId: string;
  privateKey: PrivateP256Jwk;
  publicKey: PublicP256Jwk;
  identity: NonNullable<WorkerState["identity"]>;
}> {
  const pair = await generateKeyPair("ES256", { extractable: true });
  return {
    version: 1,
    setup: {
      version: 1,
      backendUrl: "https://radium.example.convex.site",
      convexUrl: "https://radium.example.convex.cloud",
      enrollmentId: "legacy-enrollment-id",
      expiresAt: 2_000_000_600_000,
    },
    requestId,
    privateKey: (await exportJWK(pair.privateKey)) as PrivateP256Jwk,
    publicKey: (await exportJWK(pair.publicKey)) as PublicP256Jwk,
    identity: {
      workerId: "legacy-worker-id",
      keyId: "legacy-key-id",
      workspaceId: "legacy-workspace-id",
      identityEpoch: 3,
    },
  };
}

function makeSetup(): WorkerSetup {
  return {
    version: 1,
    backendUrl: "https://radium.example.convex.site",
    convexUrl: "https://radium.example.convex.cloud",
    enrollmentId: "opaque-enrollment-selector",
    token: Buffer.alloc(32, 7).toString("base64url"),
    expiresAt: 2_000_000_600_000,
  };
}

async function newStateDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "radium-worker-credentials-test-"));
  directories.push(directory);
  return join(directory, "state");
}
