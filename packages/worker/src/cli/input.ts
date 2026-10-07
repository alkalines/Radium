import { WorkerProtocolError } from "../protocol.js";

const MAX_SETUP_INPUT_BYTES = 16 * 1024;

/** Read a setup code from stdin, bounded in size and never echoed. */
export async function readSetupCodeFromStdin(stream: ReadableStream<Uint8Array>): Promise<string> {
  const bytes = await readBounded(stream);
  return decodeSetupInput(bytes);
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
