import type { TelemetryBlobKind } from "./validators";

const encoder = new TextEncoder();

/** Derive a deployment-secret keyed, workspace-isolated fingerprint. */
export async function workspaceHash(workspace: string, domain: string, value: string): Promise<string> {
  const secret = process.env.TELEMETRY_HASH_SECRET;
  if (!secret || !/^[A-Za-z0-9_-]{43}$/.test(secret)) {
    throw new Error("TELEMETRY_HASH_SECRET must be a base64url-encoded 32-byte key.");
  }
  const bytes = Uint8Array.from(atob(secret.replace(/-/g, "+").replace(/_/g, "/") + "="), (c) => c.charCodeAt(0));
  if (bytes.length !== 32) throw new Error("Invalid TELEMETRY_HASH_SECRET.");
  const root = await crypto.subtle.importKey("raw", bytes, "HKDF", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: encoder.encode(workspace), info: encoder.encode("radium/v1/telemetry-hash") },
    root,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(`${domain}\u0000${value}`)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
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
  return workspaceHash(workspace, "blob", `${kind}\u0000${canonical}`);
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
  return workspaceHash(workspace, "node", `${parent ?? ""}\u0000${message}`);
}

/** UTF-8 byte length, used to decide inline versus file-storage blob placement. */
export function utf8Length(text: string): number {
  return encoder.encode(text).byteLength;
}
