import type { TelemetryBlobKind } from "./validators";

const encoder = new TextEncoder();

async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
  let hex = "";
  for (const byte of digest) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/**
 * Fingerprint of canonical JSON content of one blob kind within one workspace. The workspace ID
 * is part of the hashed input, so identical content in two workspaces never shares a fingerprint
 * or a row; the kind keeps, for example, an empty params object distinct from empty headers.
 */
export function blobHash(
  workspace: string,
  kind: TelemetryBlobKind,
  canonical: string,
): Promise<string> {
  return sha256Hex(`blob\u0000${workspace}\u0000${kind}\u0000${canonical}`);
}

/**
 * Fingerprint of a conversation position: the message blob at the end of the chain identified
 * by `parent`. Equal hashes mean the same message sequence from the root, so a shared prefix
 * across requests (or branches) resolves to the same nodes.
 */
export function nodeHash(
  workspace: string,
  parent: string | undefined,
  message: string,
): Promise<string> {
  return sha256Hex(`node\u0000${workspace}\u0000${parent ?? ""}\u0000${message}`);
}

/** UTF-8 byte length, used to decide inline versus file-storage blob placement. */
export function utf8Length(text: string): number {
  return encoder.encode(text).byteLength;
}
