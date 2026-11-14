import { randomUUID } from "node:crypto";
import { lstat, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  ensurePrivateDirectory,
  ensurePrivateFileMode,
  syncDirectory,
  validatePrivateFile,
  wipeAndUnlinkPrivateFile,
} from "../auth/private-files.js";
import { WorkerProtocolError } from "../protocol.js";

const FILE_NAME = "e2ee-marks.json";
const FILE_MODE = 0o600;
const SUBJECT = "Worker trust marks";
/** Pins and high-water marks are per chat; one-shot claims expire. Refuse rather than grow unbounded. */
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_NAME_LENGTH = 256;
const MAX_PIN_LENGTH = 1024;

type Marks = {
  v: 1;
  highWater: Record<string, number>;
  pins: Record<string, string>;
  /** One-shot claims: name → expiry (ms epoch). Expired entries are pruned on every write. */
  once: Record<string, number>;
};

/**
 * Local, monotonic trust marks of a paired Worker (`e2ee-marks.json` in the state directory): the
 * roster high-water, per-chat signed-record high-water marks, and first-write-wins pins. They are
 * not secret, but only this machine can detect a backend rollback, so they must survive restarts.
 * Every change is written atomically before the in-memory value moves; writes are serialized.
 * One Worker process per state directory is assumed.
 */
export class TrustMarks {
  private writes: Promise<void> = Promise.resolve();

  private constructor(
    private readonly stateDirectory: string,
    private marks: Marks,
  ) {}

  /** Read the marks, or start empty when the file does not exist yet. */
  static async open(stateDirectory: string): Promise<TrustMarks> {
    await ensurePrivateDirectory(stateDirectory);
    const path = join(stateDirectory, FILE_NAME);
    let info;
    try {
      info = await lstat(path);
    } catch (error) {
      if (isMissing(error)) {
        return new TrustMarks(stateDirectory, { v: 1, highWater: {}, pins: {}, once: {} });
      }
      throw new WorkerProtocolError(`${SUBJECT} could not be opened`);
    }
    validatePrivateFile(info, MAX_BYTES, SUBJECT);
    if ((Number(info.mode) & 0o777) !== FILE_MODE) await ensurePrivateFileMode(path, SUBJECT);
    try {
      const raw = await readFile(path);
      if (raw.byteLength > MAX_BYTES) throw new Error();
      return new TrustMarks(stateDirectory, validateMarks(JSON.parse(raw.toString("utf8"))));
    } catch {
      throw new WorkerProtocolError(`${SUBJECT} file is invalid`);
    }
  }

  /** Highest value recorded for `name`, or 0. */
  highWater(name: string): number {
    return this.marks.highWater[name] ?? 0;
  }

  /** Persist `value` for `name` if it is higher than the recorded mark; never lowers it. */
  advanceHighWater(name: string, value: number): Promise<void> {
    assertName(name);
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new WorkerProtocolError(`${SUBJECT} value is invalid`);
    }
    return this.update((marks) => {
      if (value <= (marks.highWater[name] ?? 0)) return null;
      return { ...marks, highWater: { ...marks.highWater, [name]: value } };
    });
  }

  /** Store `value` under `name` if unset; true iff the stored value equals `value`. Never overwrites. */
  async pin(name: string, value: string): Promise<boolean> {
    assertName(name);
    if (value.length < 1 || value.length > MAX_PIN_LENGTH) {
      throw new WorkerProtocolError(`${SUBJECT} value is invalid`);
    }
    await this.update((marks) => {
      if (marks.pins[name] !== undefined) return null;
      return { ...marks, pins: { ...marks.pins, [name]: value } };
    });
    return this.marks.pins[name] === value;
  }

  /** Key IDs ever written to the credential store, including interrupted replacements. */
  credentialKeyIds(): string[] {
    return Object.entries(this.marks.pins)
      .filter(([name, value]) => name === `credential:${value}`)
      .map(([, value]) => value);
  }

  /**
   * One-shot replay guard: records `name` until `expiresAt` (ms epoch) and returns true when it was
   * absent or expired; false when an unexpired claim exists. Expired claims are pruned on every write.
   */
  async claimOnce(name: string, expiresAt: number): Promise<boolean> {
    assertName(name);
    if (!Number.isSafeInteger(expiresAt) || expiresAt < 0) {
      throw new WorkerProtocolError(`${SUBJECT} value is invalid`);
    }
    let claimed = false;
    await this.update((marks) => {
      const now = Date.now();
      if ((marks.once[name] ?? 0) > now) return null;
      const once: Record<string, number> = {};
      for (const [entry, expiry] of Object.entries(marks.once)) {
        if (expiry > now) once[entry] = expiry;
      }
      once[name] = expiresAt;
      claimed = true;
      return { ...marks, once };
    });
    return claimed;
  }
  private update(change: (marks: Marks) => Marks | null): Promise<void> {
    const write = this.writes.then(async () => {
      const next = change(this.marks);
      if (!next) return;
      await writeMarks(this.stateDirectory, next);
      this.marks = next;
    });
    // A failed write must not poison later writes; the caller still sees its own failure.
    this.writes = write.catch(() => undefined);
    return write;
  }
}

/** Remove the marks file (part of `forget`). */
export async function deleteTrustMarks(stateDirectory: string): Promise<void> {
  const path = join(stateDirectory, FILE_NAME);
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (isMissing(error)) return;
    throw new WorkerProtocolError(`${SUBJECT} could not be opened for removal`);
  }
  await wipeAndUnlinkPrivateFile(path, info, MAX_BYTES, SUBJECT);
  await syncDirectory(stateDirectory);
}

async function writeMarks(stateDirectory: string, marks: Marks): Promise<void> {
  const contents = Buffer.from(JSON.stringify(marks), "utf8");
  if (contents.byteLength > MAX_BYTES) throw new WorkerProtocolError(`${SUBJECT} are full`);
  const temporary = join(stateDirectory, `.e2ee-marks-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, "wx", FILE_MODE);
    await handle.chmod(FILE_MODE);
    await handle.writeFile(contents);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, join(stateDirectory, FILE_NAME));
    await syncDirectory(stateDirectory);
  } catch (error) {
    await handle?.close();
    await unlink(temporary).catch(() => undefined);
    if (error instanceof WorkerProtocolError) throw error;
    throw new WorkerProtocolError(`${SUBJECT} could not be saved`);
  }
}

function validateMarks(value: unknown): Marks {
  if (!isRecord(value) || value.v !== 1 || !isRecord(value.highWater) || !isRecord(value.pins)) {
    throw new Error();
  }
  // Files written before one-shot claims existed have no `once` map.
  const once = value.once === undefined ? {} : value.once;
  if (!isRecord(once)) throw new Error();
  for (const marks of [value.highWater, once]) {
    for (const [name, mark] of Object.entries(marks)) {
      assertName(name);
      if (typeof mark !== "number" || !Number.isSafeInteger(mark) || mark < 0) throw new Error();
    }
  }
  for (const [name, pin] of Object.entries(value.pins)) {
    assertName(name);
    if (typeof pin !== "string" || pin.length < 1 || pin.length > MAX_PIN_LENGTH) {
      throw new Error();
    }
  }
  return { ...(value as Omit<Marks, "once">), once: once as Record<string, number> };
}

function assertName(name: string): void {
  if (name.length < 1 || name.length > MAX_NAME_LENGTH || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new WorkerProtocolError(`${SUBJECT} name is invalid`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}
