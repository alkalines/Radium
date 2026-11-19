import type { JWK } from "jose";
import type { FunctionReturnType } from "convex/server";
import type { api } from "backend/convex/_generated/api";

const SETUP_PREFIX = "radium-worker-v1.";
const SETUP_V2_PREFIX = "radium-worker-v2.";
const PAIRING_PREFIX = "radium-worker-pair-v1.";
const FINGERPRINT_PATTERN = /^[0-9a-f]{4}( [0-9a-f]{4}){7}$/;
const MAX_SETUP_BYTES = 16 * 1024;
const MAX_RESPONSE_BYTES = 32 * 1024;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

/** Public half of the P-256 key used to identify a Worker. */
export type PublicP256Jwk = JWK & {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
};

/** Private signing key; keep it in the credential store and out of logs/state files. */
export type PrivateP256Jwk = PublicP256Jwk & { d: string };

/**
 * The workspace owner named by a v2 setup code or a pairing code. The Worker pins it: only rosters
 * signed by this key are trusted. `signingPublicKey` is unpadded base64url of the Ed25519 key.
 */
export interface WorkerOwnerPin {
  userId: string;
  keyId: string;
  fingerprint: string;
  signingPublicKey: string;
}

/** Pairing material shared only by the owner's browser and this Worker; never persisted. */
export interface WorkerPairing {
  pairingId: string;
  /** 32-byte pairing secret; MACs the Worker's published keys. */
  secret: Uint8Array;
  owner: WorkerOwnerPin;
}

/**
 * Validated contents of a short-lived, one-time Worker setup code. Version 2 codes (keyed
 * workspaces) add `pairing`; version 1 codes carry none.
 */
export interface WorkerSetup {
  version: 1 | 2;
  backendUrl: string;
  convexUrl: string;
  enrollmentId: string;
  token: string;
  expiresAt: number;
  pairing?: WorkerPairing;
}

/** Persistable setup metadata, deliberately excluding the one-time token and pairing secret. */
export type StoredWorkerSetup = Omit<WorkerSetup, "token" | "pairing">;

/** A pairing code for an already enrolled Worker (`radium-worker pair`). */
export interface WorkerPairingCode {
  workspaceId: string;
  workerId: string;
  expiresAt: number;
  pairing: WorkerPairing;
}

/** Local binding to the server-issued Worker, key, workspace, and identity epoch. */
export interface WorkerIdentity {
  workerId: string;
  keyId: string;
  workspaceId: string;
  identityEpoch: number;
}

/** Shared machine metadata derived from the app's generated subscription contract. */
export type WorkerMetadata = NonNullable<FunctionReturnType<typeof api.workers.current>>;

/** Fetch signature used by authentication requests and their test seam. */
export type WorkerFetch = (input: string | URL, init: RequestInit) => Promise<Response>;

/** Sanitized protocol or validation failure safe to surface without response bodies. */
export class WorkerProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkerProtocolError";
  }
}

/** Authentication endpoint failure that preserves only its HTTP status. */
export class WorkerHttpError extends Error {
  constructor(readonly status: number) {
    super(`Worker authentication endpoint returned HTTP ${status}`);
    this.name = "WorkerHttpError";
  }
}

/**
 * Validate the versioned, base64url-encoded one-time setup code without echoing it.
 * Rejects malformed, expired, oversized, or non-origin endpoint values, and any key not defined
 * for the code's version (`radium-worker-v1.` for keyless workspaces, `radium-worker-v2.` with
 * pairing material for keyed ones).
 *
 * v2 JSON: `{version: 2, backendUrl, convexUrl, enrollmentId, token, expiresAt, pairingId, secret,
 * owner: {userId, keyId, fingerprint, signingPublicKey}}`.
 */
export function parseSetupCode(input: string, now = Date.now()): WorkerSetup {
  const code = input.trim();
  const version = code.startsWith(SETUP_V2_PREFIX) ? 2 : code.startsWith(SETUP_PREFIX) ? 1 : 0;
  if (version === 0) {
    throw new WorkerProtocolError("Setup code has an unsupported format");
  }
  const value = decodeCodeJson(
    code.slice((version === 2 ? SETUP_V2_PREFIX : SETUP_PREFIX).length),
    "Setup code",
  );

  const expectedKeys = ["version", "backendUrl", "convexUrl", "enrollmentId", "token", "expiresAt"];
  if (version === 2) expectedKeys.push("pairingId", "secret", "owner");
  if (
    !hasExactKeys(value, expectedKeys) ||
    value.version !== version ||
    typeof value.backendUrl !== "string" ||
    typeof value.convexUrl !== "string" ||
    typeof value.enrollmentId !== "string" ||
    typeof value.token !== "string" ||
    typeof value.expiresAt !== "number"
  ) {
    throw new WorkerProtocolError("Setup code has invalid data");
  }

  const enrollmentId = value.enrollmentId;
  if (!isSelector(enrollmentId)) {
    throw new WorkerProtocolError("Setup code has an invalid enrollment selector");
  }

  if (!Number.isSafeInteger(value.expiresAt) || value.expiresAt <= now) {
    throw new WorkerProtocolError("Setup code has expired");
  }

  const tokenBytes = decodeBase64Url(
    value.token,
    "Setup code has an invalid enrollment credential",
  );
  if (tokenBytes.byteLength !== 32) {
    throw new WorkerProtocolError("Setup code has an invalid enrollment credential");
  }

  return {
    version,
    backendUrl: validateOrigin(value.backendUrl, "backendUrl"),
    convexUrl: validateOrigin(value.convexUrl, "convexUrl"),
    enrollmentId,
    token: value.token,
    expiresAt: value.expiresAt,
    ...(version === 2 ? { pairing: parsePairing(value, "Setup code") } : {}),
  };
}

/**
 * Validate a `radium-worker-pair-v1.` code made by the owner's browser for an enrolled Worker:
 * `{version: 1, workspaceId, workerId, pairingId, secret, owner: {userId, keyId, fingerprint,
 * signingPublicKey}, expiresAt}` with exactly these keys. The caller must still check that the
 * code names this Worker and workspace.
 */
export function parsePairingCode(input: string, now = Date.now()): WorkerPairingCode {
  const code = input.trim();
  if (!code.startsWith(PAIRING_PREFIX)) {
    throw new WorkerProtocolError("Pairing code has an unsupported format");
  }
  const value = decodeCodeJson(code.slice(PAIRING_PREFIX.length), "Pairing code");
  if (
    !hasExactKeys(value, [
      "version",
      "workspaceId",
      "workerId",
      "pairingId",
      "secret",
      "owner",
      "expiresAt",
    ]) ||
    value.version !== 1 ||
    !isSelector(value.workspaceId) ||
    !isSelector(value.workerId) ||
    typeof value.expiresAt !== "number"
  ) {
    throw new WorkerProtocolError("Pairing code has invalid data");
  }
  if (!Number.isSafeInteger(value.expiresAt) || value.expiresAt <= now) {
    throw new WorkerProtocolError("Pairing code has expired");
  }
  return {
    workspaceId: value.workspaceId,
    workerId: value.workerId,
    expiresAt: value.expiresAt,
    pairing: parsePairing(value, "Pairing code"),
  };
}

/** Remove the one-time token and pairing secret before setup metadata is persisted. */
export function storedSetup(setup: WorkerSetup): StoredWorkerSetup {
  return {
    version: setup.version,
    backendUrl: setup.backendUrl,
    convexUrl: setup.convexUrl,
    enrollmentId: setup.enrollmentId,
    expiresAt: setup.expiresAt,
  };
}

/** Validate an owner pin (also used for persisted state). */
export function validateOwnerPin(value: unknown, errorMessage: string): WorkerOwnerPin {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["userId", "keyId", "fingerprint", "signingPublicKey"]) ||
    !isSelector(value.userId) ||
    typeof value.keyId !== "string" ||
    typeof value.fingerprint !== "string" ||
    !FINGERPRINT_PATTERN.test(value.fingerprint) ||
    typeof value.signingPublicKey !== "string" ||
    decodeBase64Url(value.keyId, errorMessage).byteLength !== 16 ||
    decodeBase64Url(value.signingPublicKey, errorMessage).byteLength !== 32
  ) {
    throw new WorkerProtocolError(errorMessage);
  }
  return {
    userId: value.userId,
    keyId: value.keyId,
    fingerprint: value.fingerprint,
    signingPublicKey: value.signingPublicKey,
  };
}

function parsePairing(value: Record<string, unknown>, label: string): WorkerPairing {
  const message = `${label} has invalid pairing data`;
  if (typeof value.pairingId !== "string" || typeof value.secret !== "string") {
    throw new WorkerProtocolError(message);
  }
  if (decodeBase64Url(value.pairingId, message).byteLength !== 16) {
    throw new WorkerProtocolError(message);
  }
  const secret = decodeBase64Url(value.secret, message);
  if (secret.byteLength !== 32) throw new WorkerProtocolError(message);
  return {
    pairingId: value.pairingId,
    secret: new Uint8Array(secret),
    owner: validateOwnerPin(value.owner, message),
  };
}

function decodeCodeJson(encoded: string, label: string): Record<string, unknown> {
  if (!encoded || encoded.length > MAX_SETUP_BYTES || !BASE64URL_PATTERN.test(encoded)) {
    throw new WorkerProtocolError(`${label} has an unsupported format`);
  }
  const bytes = decodeBase64Url(encoded, `${label} has an unsupported format`);
  if (bytes.byteLength > MAX_SETUP_BYTES) {
    throw new WorkerProtocolError(`${label} is too large`);
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new WorkerProtocolError(`${label} has invalid data`);
  }
  if (!isRecord(value)) throw new WorkerProtocolError(`${label} has invalid data`);
  return value;
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => key in value);
}

/** Opaque server identifier: 1–1024 characters without control characters. */
function isSelector(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 1024 &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

/** Validate and normalize an HTTPS origin or an HTTP loopback origin. */
export function validateOrigin(input: string, field = "URL"): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new WorkerProtocolError(`${field} must be an HTTP(S) origin`);
  }

  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    (url.href !== `${url.origin}/` && url.href !== url.origin)
  ) {
    throw new WorkerProtocolError(
      `${field} must be an origin without credentials, path, query, or fragment`,
    );
  }

  const isHttps = url.protocol === "https:";
  const hostname = url.hostname.toLowerCase();
  const isLoopbackHttp =
    url.protocol === "http:" &&
    (hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "[::1]" ||
      hostname === "::1");
  if (!isHttps && !isLoopbackHttp) {
    throw new WorkerProtocolError(`${field} must use HTTPS or HTTP on loopback`);
  }

  return url.origin;
}

/**
 * POST JSON with redirects disabled and a bounded, timed response read.
 * Fetch and JSON-decoding failures are sanitized; response-stream errors may propagate.
 * Non-2xx responses with readable, bounded bodies retain only their HTTP status.
 */
export async function postJson<T>(
  url: string,
  body: unknown,
  options: { fetchImpl?: WorkerFetch; timeoutMs?: number } = {},
): Promise<T> {
  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    });
  } catch {
    throw new WorkerProtocolError("Worker authentication request failed");
  }

  const bytes = await readBoundedBody(response);
  if (!response.ok) throw new WorkerHttpError(response.status);

  let result: unknown;
  try {
    result = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new WorkerProtocolError("Worker authentication endpoint returned invalid JSON");
  }
  return result as T;
}

async function readBoundedBody(response: Response): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new WorkerProtocolError("Worker authentication response is too large");
  }

  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    // Content-Length is only an early rejection; enforce the same bound while streaming.
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new WorkerProtocolError("Worker authentication response is too large");
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

function decodeBase64Url(encoded: string, errorMessage: string): Uint8Array {
  try {
    if (!BASE64URL_PATTERN.test(encoded)) throw new Error();
    const bytes = Buffer.from(encoded, "base64url");
    // Buffer decoding is permissive; accept only the canonical encoding we were given.
    if (bytes.toString("base64url") !== encoded) throw new Error();
    return bytes;
  } catch {
    throw new WorkerProtocolError(errorMessage);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
