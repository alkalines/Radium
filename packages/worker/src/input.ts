import { lstat, open } from "node:fs/promises";
import { WorkerProtocolError } from "./protocol.js";

const MAX_SETUP_INPUT_BYTES = 16 * 1024;

/** Read a setup code from stdin, bounded in size and never echoed. */
export async function readSetupCodeFromStdin(stream: ReadableStream<Uint8Array>): Promise<string> {
  const bytes = await readBounded(stream);
  return decodeSetupInput(bytes);
}

/** Read only a private, regular file; symbolic links and shared files are rejected. */
export async function readSetupCodeFromFile(path: string): Promise<string> {
  let linkInfo;
  try {
    linkInfo = await lstat(path);
  } catch {
    throw new WorkerProtocolError("Setup file could not be opened");
  }
  if (!linkInfo.isFile() || linkInfo.isSymbolicLink() || linkInfo.nlink !== 1) {
    throw new WorkerProtocolError("Setup file must be a private regular file");
  }

  let handle;
  try {
    handle = await open(path, "r");
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.dev !== linkInfo.dev ||
      info.ino !== linkInfo.ino ||
      (info.mode & 0o077) !== 0 ||
      (info.mode & 0o400) === 0 ||
      (typeof process.getuid === "function" && info.uid !== process.getuid()) ||
      info.size > MAX_SETUP_INPUT_BYTES
    ) {
      throw new WorkerProtocolError(
        "Setup file must be owned by this user and have mode 0600 or stricter",
      );
    }
    const bytes = await handle.readFile();
    if (bytes.byteLength > MAX_SETUP_INPUT_BYTES) {
      throw new WorkerProtocolError("Setup file is too large");
    }
    return decodeSetupInput(bytes);
  } catch (error) {
    if (error instanceof WorkerProtocolError) throw error;
    throw new WorkerProtocolError("Setup file could not be read");
  } finally {
    await handle?.close();
  }
}

async function readBounded(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_SETUP_INPUT_BYTES) {
        await reader.cancel();
        throw new WorkerProtocolError("Setup code is too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function decodeSetupInput(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
  } catch {
    throw new WorkerProtocolError("Setup input must be UTF-8");
  }
}
