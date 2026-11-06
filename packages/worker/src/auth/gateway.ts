import { randomUUID } from "node:crypto";
import { lstat, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { WorkerProtocolError } from "../protocol.js";
import {
  ensurePrivateDirectory,
  syncDirectory,
  validatePrivateFile,
  wipeAndUnlinkPrivateFile,
} from "./private-files.js";

export interface GatewayKey {
  keyId: string;
  key: string;
}

export interface GatewayKeyStore {
  get(): Promise<GatewayKey | null>;
  set(value: GatewayKey): Promise<void>;
  delete(): Promise<void>;
}

const MAX_BYTES = 16 * 1024;
const SUBJECT = "Worker Gateway key";

/** A second secret beside the machine identity, never part of Worker state or commands. */
export function createGatewayKeyStore(stateDirectory: string): GatewayKeyStore {
  const path = join(stateDirectory, ".worker-gateway-key.json");
  const store: GatewayKeyStore = {
    async get() {
      await ensurePrivateDirectory(stateDirectory);
      let info;
      try {
        info = await lstat(path);
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "ENOENT"
        )
          return null;
        throw new WorkerProtocolError(`${SUBJECT} file could not be opened`);
      }
      validatePrivateFile(info, MAX_BYTES, SUBJECT);
      try {
        const raw = await readFile(path);
        if (raw.byteLength > MAX_BYTES) throw new Error();
        const value: unknown = JSON.parse(raw.toString("utf8"));
        if (!validKey(value)) throw new Error();
        return value;
      } catch {
        throw new WorkerProtocolError(`${SUBJECT} file is invalid`);
      }
    },
    async set(value) {
      if (!validKey(value)) throw new WorkerProtocolError(`${SUBJECT} is invalid`);
      const raw = JSON.stringify(value);
      if (Buffer.byteLength(raw) > MAX_BYTES)
        throw new WorkerProtocolError(`${SUBJECT} is invalid`);
      await ensurePrivateDirectory(stateDirectory);
      const temporary = join(stateDirectory, `.worker-gateway-${randomUUID()}.tmp`);
      let handle;
      let previous;
      try {
        handle = await open(temporary, "wx", 0o600);
        await handle.chmod(0o600);
        await handle.writeFile(raw, "utf8");
        await handle.sync();
        await handle.close();
        handle = undefined;
        const info = await lstat(path).catch((error: unknown) => {
          if (
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "ENOENT"
          )
            return null;
          throw error;
        });
        if (info) {
          validatePrivateFile(info, MAX_BYTES, SUBJECT, true);
          // Keep the replaced inode open so its secret can be wiped after the atomic swap.
          previous = await open(path, "r+");
        }
        await rename(temporary, path);
        await syncDirectory(stateDirectory);
      } catch (error) {
        await handle?.close();
        await previous?.close();
        const info = await lstat(temporary).catch(() => null);
        if (info) await wipeAndUnlinkPrivateFile(temporary, info, MAX_BYTES, SUBJECT);
        if (error instanceof WorkerProtocolError) throw error;
        throw new WorkerProtocolError(`${SUBJECT} could not be saved`);
      }
      if (!previous) return;
      try {
        const { size } = await previous.stat();
        if (size > 0) {
          const zeros = Buffer.alloc(Math.min(size, MAX_BYTES));
          await previous.write(zeros, 0, zeros.byteLength, 0);
        }
        await previous.truncate(0);
        await previous.sync();
      } catch {
        // The new key is already in place; wiping the unlinked old inode is best effort.
      } finally {
        await previous.close();
      }
    },
    async delete() {
      await ensurePrivateDirectory(stateDirectory);
      let info;
      try {
        info = await lstat(path);
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "ENOENT"
        )
          return;
        throw new WorkerProtocolError(`${SUBJECT} file could not be opened for removal`);
      }
      await wipeAndUnlinkPrivateFile(path, info, MAX_BYTES, SUBJECT);
      await syncDirectory(stateDirectory);
    },
  };
  return store;
}

function validKey(value: unknown): value is GatewayKey {
  return (
    typeof value === "object" &&
    value !== null &&
    "keyId" in value &&
    typeof value.keyId === "string" &&
    value.keyId.length > 0 &&
    "key" in value &&
    typeof value.key === "string" &&
    value.key.length > 0
  );
}
