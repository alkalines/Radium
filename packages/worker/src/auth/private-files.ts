import { chmod, lstat, mkdir, open, unlink } from "node:fs/promises";
import { WorkerProtocolError } from "../protocol.js";

const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIRECTORY_MODE = 0o700;

/** Establish the private directory boundary shared by Worker state and credentials. */
export async function ensurePrivateDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  } catch {
    throw new WorkerProtocolError("Worker state directory could not be created");
  }

  let info;
  try {
    info = await lstat(path);
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
    await chmod(path, PRIVATE_DIRECTORY_MODE);
  } catch {
    throw new WorkerProtocolError("Worker state directory permissions could not be secured");
  }
}

/** Validate private-file ownership, link count, size, and optionally private mode. */
export function validatePrivateFile(
  info: Awaited<ReturnType<typeof lstat>>,
  maxBytes: number,
  subject: string,
  allowBroadPermissions = false,
): void {
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
    throw new WorkerProtocolError(`${subject} file must be a private regular file`);
  }
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new WorkerProtocolError(`${subject} file is owned by a different user`);
  }
  if (!allowBroadPermissions && (Number(info.mode) & 0o077) !== 0) {
    throw new WorkerProtocolError(`${subject} file permissions are too broad`);
  }
  if (info.size > maxBytes) throw new WorkerProtocolError(`${subject} file is invalid`);
}

/** Restrict an already validated file to owner-only access. */
export async function ensurePrivateFileMode(path: string, subject: string): Promise<void> {
  try {
    await chmod(path, PRIVATE_FILE_MODE);
  } catch {
    throw new WorkerProtocolError(`${subject} file permissions could not be secured`);
  }
}

/** Best-effort overwrite, sync, truncate, and unlink after relaxed-mode validation. */
export async function wipeAndUnlinkPrivateFile(
  path: string,
  info: Awaited<ReturnType<typeof lstat>>,
  maxBytes: number,
  subject: string,
): Promise<void> {
  validatePrivateFile(info, maxBytes, subject, true);
  if ((Number(info.mode) & 0o777) !== PRIVATE_FILE_MODE) {
    await ensurePrivateFileMode(path, subject);
  }

  let handle;
  try {
    handle = await open(path, "r+");
    const size = Number(info.size);
    if (size > 0) {
      const zeros = Buffer.alloc(Math.min(size, maxBytes));
      await handle.write(zeros, 0, zeros.byteLength, 0);
      await handle.sync();
    }
    await handle.truncate(0);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await unlink(path);
  } catch {
    await handle?.close();
    throw new WorkerProtocolError(`${subject} file could not be securely removed`);
  }
}

/** Persist directory-entry changes made by state and protected-file operations. */
export async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
