import type { JWK } from "jose";

const SETUP_PREFIX = "radium-worker-v1.";
const MAX_SETUP_BYTES = 16 * 1024;
const MAX_RESPONSE_BYTES = 32 * 1024;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export type PublicP256Jwk = JWK & {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
};

export type PrivateP256Jwk = PublicP256Jwk & { d: string };

export interface WorkerSetup {
  version: 1;
  backendUrl: string;
  convexUrl: string;
  enrollmentId: string;
  token: string;
  expiresAt: number;
}

export type StoredWorkerSetup = Omit<WorkerSetup, "token">;

export interface WorkerIdentity {
  workerId: string;
  keyId: string;
  workspaceId: string;
  identityEpoch: number;
}

export interface WorkerMetadata {
  workerId: string;
  workspaceId: string;
  name: string;
  capabilities: string[];
  status: "active" | "revoked";
  identityEpoch: number;
}

export type WorkerFetch = (input: string | URL, init: RequestInit) => Promise<Response>;

export class WorkerProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkerProtocolError";
  }
}

export class WorkerHttpError extends Error {
  constructor(readonly status: number) {
    super(`Worker authentication endpoint returned HTTP ${status}`);
    this.name = "WorkerHttpError";
  }
}

/** Parse the versioned, base64url-encoded one-time setup code without echoing it. */
export function parseSetupCode(input: string, now = Date.now()): WorkerSetup {
  const code = input.trim();
  if (!code.startsWith(SETUP_PREFIX)) {
    throw new WorkerProtocolError("Setup code has an unsupported format");
  }

  const encoded = code.slice(SETUP_PREFIX.length);
  if (!encoded || encoded.length > MAX_SETUP_BYTES || !BASE64URL_PATTERN.test(encoded)) {
    throw new WorkerProtocolError("Setup code has an unsupported format");
  }

  const bytes = decodeBase64Url(encoded, "Setup code has an unsupported format");
  if (bytes.byteLength > MAX_SETUP_BYTES) {
    throw new WorkerProtocolError("Setup code is too large");
  }

  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new WorkerProtocolError("Setup code has invalid data");
  }

  if (!isRecord(value)) throw new WorkerProtocolError("Setup code has invalid data");
  const expectedKeys = ["version", "backendUrl", "convexUrl", "enrollmentId", "token", "expiresAt"];
  if (
    Object.keys(value).length !== expectedKeys.length ||
    expectedKeys.some((key) => !(key in value)) ||
    value.version !== 1 ||
    typeof value.backendUrl !== "string" ||
    typeof value.convexUrl !== "string" ||
    typeof value.enrollmentId !== "string" ||
    typeof value.token !== "string" ||
    typeof value.expiresAt !== "number"
  ) {
    throw new WorkerProtocolError("Setup code has invalid data");
  }

  const enrollmentId = value.enrollmentId;
  if (
    enrollmentId.length < 1 ||
    enrollmentId.length > 1024 ||
    /[\u0000-\u001f\u007f]/.test(enrollmentId)
  ) {
    throw new WorkerProtocolError("Setup code has an invalid enrollment selector");
  }

  if (!Number.isSafeInteger(value.expiresAt) || value.expiresAt <= now) {
    throw new WorkerProtocolError("Setup code has expired");
  }

  if (!BASE64URL_PATTERN.test(value.token)) {
    throw new WorkerProtocolError("Setup code has an invalid enrollment credential");
  }
  const tokenBytes = decodeBase64Url(
    value.token,
    "Setup code has an invalid enrollment credential",
  );
  if (tokenBytes.byteLength !== 32) {
    throw new WorkerProtocolError("Setup code has an invalid enrollment credential");
  }

  return {
    version: 1,
    backendUrl: validateOrigin(value.backendUrl, "backendUrl"),
    convexUrl: validateOrigin(value.convexUrl, "convexUrl"),
    enrollmentId,
    token: value.token,
    expiresAt: value.expiresAt,
  };
}

export function storedSetup(setup: WorkerSetup): StoredWorkerSetup {
  return {
    version: 1,
    backendUrl: setup.backendUrl,
    convexUrl: setup.convexUrl,
    enrollmentId: setup.enrollmentId,
    expiresAt: setup.expiresAt,
  };
}

/** Validate and normalize a Convex HTTP or client origin. */
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
    if (bytes.toString("base64url") !== encoded) throw new Error();
    return bytes;
  } catch {
    throw new WorkerProtocolError(errorMessage);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
