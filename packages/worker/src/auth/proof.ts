import { importJWK, SignJWT } from "jose";
import { type WorkerFetch, WorkerProtocolError, postJson } from "../protocol.js";
import type { WorkerState } from "./state.js";

const PROOF_TYPE = "radium-worker-proof+jwt";
const PROOF_LIFETIME_SECONDS = 60;

/** Optional network and clock seams shared by Worker authentication operations. */
export interface AuthOptions {
  fetchImpl?: WorkerFetch;
  now?: () => number;
  timeoutMs?: number;
}

/** Backend-issued, short-lived selector that the Worker proves key possession for. */
export interface WorkerAuthChallenge {
  challengeId: string;
  expiresAt: number;
  audience: string;
}

/**
 * Request a backend challenge and validate that it is bound to the configured origin.
 * HTTP failures are left to the enrollment or token lifecycle to interpret.
 */
export async function requestChallenge(
  state: WorkerState,
  body: Record<string, unknown>,
  options: AuthOptions,
): Promise<WorkerAuthChallenge> {
  const result = await postJson<unknown>(
    `${state.setup.backendUrl}/api/worker/auth/challenge`,
    body,
    options,
  );

  if (
    !isRecord(result) ||
    typeof result.challengeId !== "string" ||
    result.challengeId.length < 1 ||
    result.challengeId.length > 1024 ||
    typeof result.expiresAt !== "number" ||
    !Number.isSafeInteger(result.expiresAt) ||
    typeof result.audience !== "string" ||
    result.audience !== state.setup.backendUrl
  ) {
    throw new WorkerProtocolError("Worker authentication challenge is invalid");
  }

  if (result.expiresAt <= nowOf(options)) {
    throw new WorkerProtocolError("Worker authentication challenge has expired");
  }
  return {
    challengeId: result.challengeId,
    expiresAt: result.expiresAt,
    audience: result.audience,
  };
}

/**
 * Sign the backend's immutable challenge selector with this Worker's key.
 * The proof audience is the backend origin and its lifetime is at most sixty seconds;
 * it contains neither the setup credential nor a Convex access token.
 */
export async function signChallenge(
  state: WorkerState,
  challenge: WorkerAuthChallenge,
  options: AuthOptions,
): Promise<string> {
  const issuedAt = Math.floor(nowOf(options) / 1000);
  const expiresAt = Math.min(
    issuedAt + PROOF_LIFETIME_SECONDS,
    Math.floor(challenge.expiresAt / 1000),
  );
  if (expiresAt <= issuedAt) {
    throw new WorkerProtocolError("Worker authentication challenge has expired");
  }

  const key = await importJWK(state.privateKey, "ES256");
  return new SignJWT({ challengeId: challenge.challengeId, aud: challenge.audience })
    .setProtectedHeader({ alg: "ES256", typ: PROOF_TYPE })
    .setIssuedAt(issuedAt)
    .setExpirationTime(expiresAt)
    .sign(key);
}

/** Read the injected clock when present, otherwise use the system clock. */
export function nowOf(options: AuthOptions): number {
  return options.now?.() ?? Date.now();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
