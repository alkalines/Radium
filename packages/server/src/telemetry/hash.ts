import type { TelemetryBlobKind } from "contracts/telemetry/validators";

const encoder = new TextEncoder();

/**
 * Keyed, workspace-isolated fingerprint (hex HMAC-SHA-256). The key is derived with HKDF from the
 * deployment's `TELEMETRY_HASH_SECRET` (base64url of 32 bytes, validated by `src/config.ts`) and
 * salted with the workspace id, so equal values in two workspaces never share a fingerprint.
 * `domain` separates uses (`blob`, `node`, `routing-session`). Unchanged from the Convex backend,
 * so imported fingerprints keep matching.
 */
export async function workspaceHash(
  secret: string,
  workspace: string,
  domain: string,
  value: string,
): Promise<string> {
  // Decoded as Convex did (`atob` of the base64url text), so any secret it accepted still works.
  const secretBytes = Uint8Array.from(
    atob(`${secret.replaceAll("-", "+").replaceAll("_", "/")}=`),
    (char) => char.charCodeAt(0),
  );
  const root = await crypto.subtle.importKey("raw", secretBytes, "HKDF", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: encoder.encode(workspace),
      info: encoder.encode("radium/v1/telemetry-hash"),
    },
    root,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(`${domain}\u0000${value}`)),
  );
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Fingerprint of canonical JSON content of one blob kind within one workspace. The kind keeps,
 * for example, an empty params object distinct from empty headers.
 */
export function blobHash(
  secret: string,
  workspace: string,
  kind: TelemetryBlobKind,
  canonical: string,
): Promise<string> {
  return workspaceHash(secret, workspace, "blob", `${kind}\u0000${canonical}`);
}

/**
 * Fingerprint of a conversation position: the message blob at the end of the chain identified
 * by `parent`. Equal hashes mean the same message sequence from the root, so a shared prefix
 * across requests (or branches) resolves to the same nodes.
 */
export function nodeHash(
  secret: string,
  workspace: string,
  parent: string | undefined,
  message: string,
): Promise<string> {
  return workspaceHash(secret, workspace, "node", `${parent ?? ""}\u0000${message}`);
}

/** UTF-8 byte length of `text`: the stored size of a blob's canonical JSON. */
export function utf8Length(text: string): number {
  return encoder.encode(text).byteLength;
}
