import { importJWK, SignJWT } from "jose";
import {
  type WorkerIdentity,
  type WorkerFetch,
  type WorkerSetup,
  WorkerHttpError,
  WorkerProtocolError,
  parseSetupCode,
  postJson,
} from "./protocol.js";
import {
  assertSetupMatches,
  createPendingState,
  readWorkerState,
  saveWorkerIdentity,
  type WorkerState,
} from "./state.js";

/**
 * Worker-side authentication lifecycle.
 * Setup code -> persist a local key -> recover an existing receipt or enroll.
 * Saved identity -> sign a new backend challenge -> obtain a Convex access JWT.
 *
 * This module owns the Worker's private key, not the backend's issuer key.
 * A proof JWT is signed by the Worker and accepted by the HTTP auth endpoint.
 * The returned access JWT is signed by the backend and accepted by Convex.
 * The setup token is needed only to create the first enrollment; it is not saved.
 */

const PROOF_TYPE = "radium-worker-proof+jwt";
const PROOF_LIFETIME_SECONDS = 60;
const TOKEN_REFRESH_SKEW_MS = 30_000;

interface ChallengeResponse {
  challengeId: string;
  expiresAt: number;
  audience: string;
}

export interface MachineTokenResponse {
  token: string;
  expiresAt: number;
}

export interface AuthOptions {
  fetchImpl?: WorkerFetch;
  now?: () => number;
  timeoutMs?: number;
}

/** The only recover failure that permits a fresh enrollment attempt. */
export class EnrollmentNotFoundError extends Error {
  constructor() {
    super("The pending Worker enrollment was not found");
    this.name = "EnrollmentNotFoundError";
  }
}

/** Enroll from a protected setup code, always attempting key-bound recovery first. */
export async function setupWorker(
  stateDirectory: string,
  setupCode: string,
  options: AuthOptions = {},
): Promise<WorkerIdentity> {
  const setup = parseSetupCode(setupCode, nowOf(options));
  const state = await getOrCreatePendingState(stateDirectory, setup);
  if (state.identity) {
    throw new WorkerProtocolError("This Worker already has an identity; refusing to overwrite it");
  }

  try {
    const identity = await recoverIdentity(state, options);
    await saveWorkerIdentity(stateDirectory, state, identity);
    return identity;
  } catch (error) {
    if (!(error instanceof EnrollmentNotFoundError)) throw error;
  }

  const identity = await enrollIdentity(state, setup, options);
  await saveWorkerIdentity(stateDirectory, state, identity);
  return identity;
}

/** Recover a pending enrollment on process restart without needing the one-time token. */
export async function recoverPendingIdentity(
  stateDirectory: string,
  state: WorkerState,
  options: AuthOptions = {},
): Promise<WorkerState> {
  if (state.identity) return state;
  try {
    const identity = await recoverIdentity(state, options);
    return await saveWorkerIdentity(stateDirectory, state, identity);
  } catch (error) {
    if (error instanceof EnrollmentNotFoundError) {
      throw new WorkerProtocolError(
        "Pending enrollment was not completed; provide its setup code again",
      );
    }
    throw error;
  }
}

/**
 * Create the callback supplied to ConvexClient.setAuth for one saved identity.
 * Cache unexpired access tokens with a thirty-second refresh margin. Concurrent
 * SDK requests share one exchange to avoid duplicate refreshes.
 * On failure return null and drop cached authority; control.ts re-arms auth with
 * backoff because Convex stops its refresh cycle after a null result.
 */
export function createMachineTokenFetcher(
  state: WorkerState,
  options: AuthOptions = {},
): (args: { forceRefreshToken: boolean }) => Promise<string | null> {
  if (!state.identity) throw new WorkerProtocolError("Worker identity is not enrolled");

  let currentToken: string | null = null;
  let currentExpiresAt = 0;
  let refreshPromise: Promise<string | null> | undefined;

  return async ({ forceRefreshToken }) => {
    const now = nowOf(options);
    if (!forceRefreshToken && currentToken && currentExpiresAt > now + TOKEN_REFRESH_SKEW_MS) {
      return currentToken;
    }
    if (refreshPromise) return refreshPromise;

    currentToken = null;
    currentExpiresAt = 0;
    const pending = requestMachineToken(state, options)
      .then((response) => {
        if (response.expiresAt <= nowOf(options)) return null;
        currentToken = response.token;
        currentExpiresAt = response.expiresAt;
        return currentToken;
      })
      .catch(() => null);
    refreshPromise = pending;
    try {
      return await pending;
    } finally {
      if (refreshPromise === pending) refreshPromise = undefined;
    }
  };
}

async function getOrCreatePendingState(
  stateDirectory: string,
  setup: WorkerSetup,
): Promise<WorkerState> {
  const existing = await readWorkerState(stateDirectory);
  if (existing) {
    assertSetupMatches(existing, setup);
    return existing;
  }

  try {
    return await createPendingState(stateDirectory, setup);
  } catch (error) {
    const raced = await readWorkerState(stateDirectory);
    if (raced) {
      assertSetupMatches(raced, setup);
      return raced;
    }
    throw error;
  }
}

async function enrollIdentity(
  state: WorkerState,
  setup: WorkerSetup,
  options: AuthOptions,
): Promise<WorkerIdentity> {
  const challenge = await requestChallenge(
    state,
    {
      kind: "enroll",
      enrollmentId: setup.enrollmentId,
      requestId: state.requestId,
      publicKey: state.publicKey,
    },
    options,
  );
  const proof = await signChallenge(state, challenge, options);
  const result = await postJson<unknown>(
    `${setup.backendUrl}/api/worker/auth/complete`,
    { challengeId: challenge.challengeId, proof, token: setup.token },
    options,
  );
  return validateIdentity(result);
}

async function recoverIdentity(state: WorkerState, options: AuthOptions): Promise<WorkerIdentity> {
  const challenge = await requestChallenge(
    state,
    {
      kind: "recover",
      enrollmentId: state.setup.enrollmentId,
      requestId: state.requestId,
      publicKey: state.publicKey,
    },
    options,
  );
  const proof = await signChallenge(state, challenge, options);
  let result: unknown;
  try {
    result = await postJson<unknown>(
      `${state.setup.backendUrl}/api/worker/auth/complete`,
      { challengeId: challenge.challengeId, proof },
      options,
    );
  } catch (error) {
    if (error instanceof WorkerHttpError && isRecoverMiss(error.status)) {
      throw new EnrollmentNotFoundError();
    }
    throw error;
  }
  return validateIdentity(result);
}

/**
 * Exchange a fresh key-possession proof for the backend-issued JWT used by Convex.
 * Unlike the SDK auth callback, this diagnostic entry point propagates failures.
 * Callers must keep the returned token in memory and never print it in CLI output.
 */
export async function requestMachineToken(
  state: WorkerState,
  options: AuthOptions = {},
): Promise<MachineTokenResponse> {
  if (!state.identity) throw new WorkerProtocolError("Worker identity is not enrolled");
  const challenge = await requestChallenge(
    state,
    {
      kind: "token",
      workspaceId: state.identity.workspaceId,
      workerId: state.identity.workerId,
      keyId: state.identity.keyId,
    },
    options,
  );

  const proof = await signChallenge(state, challenge, options);
  const result = await postJson<unknown>(
    `${state.setup.backendUrl}/api/worker/auth/complete`,
    { challengeId: challenge.challengeId, proof },
    options,
  );
  return validateMachineToken(result, nowOf(options));
}

async function requestChallenge(
  state: WorkerState,
  body: Record<string, unknown>,
  options: AuthOptions,
): Promise<ChallengeResponse> {
  let result: unknown;
  try {
    result = await postJson<unknown>(
      `${state.setup.backendUrl}/api/worker/auth/challenge`,
      body,
      options,
    );
  } catch (error) {
    if (
      body.kind === "recover" &&
      error instanceof WorkerHttpError &&
      isRecoverMiss(error.status)
    ) {
      throw new EnrollmentNotFoundError();
    }
    throw error;
  }

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
 * The exact backend origin is the proof's audience; the shorter of our sixty-second
 * proof window and the backend deadline determines expiration. This signature is
 * not itself a Convex access token, and never includes the setup credential.
 */
async function signChallenge(
  state: WorkerState,
  challenge: ChallengeResponse,
  options: AuthOptions,
): Promise<string> {
  const iat = Math.floor(nowOf(options) / 1000);
  const exp = Math.min(iat + PROOF_LIFETIME_SECONDS, Math.floor(challenge.expiresAt / 1000));
  if (exp <= iat) throw new WorkerProtocolError("Worker authentication challenge has expired");

  const key = await importJWK(state.privateKey, "ES256");
  return new SignJWT({ challengeId: challenge.challengeId, aud: challenge.audience })
    .setProtectedHeader({ alg: "ES256", typ: PROOF_TYPE })
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(key);
}

function validateIdentity(value: unknown): WorkerIdentity {
  if (
    !isRecord(value) ||
    typeof value.workerId !== "string" ||
    !value.workerId ||
    typeof value.keyId !== "string" ||
    !value.keyId ||
    typeof value.workspaceId !== "string" ||
    !value.workspaceId ||
    typeof value.identityEpoch !== "number" ||
    !Number.isSafeInteger(value.identityEpoch) ||
    value.identityEpoch < 1
  ) {
    throw new WorkerProtocolError("Worker authentication endpoint returned an invalid identity");
  }
  return {
    workerId: value.workerId,
    keyId: value.keyId,
    workspaceId: value.workspaceId,
    identityEpoch: value.identityEpoch,
  };
}

function validateMachineToken(value: unknown, now: number): MachineTokenResponse {
  if (
    !isRecord(value) ||
    typeof value.token !== "string" ||
    value.token.length < 1 ||
    value.token.length > 16 * 1024 ||
    /\s/.test(value.token) ||
    typeof value.expiresAt !== "number" ||
    !Number.isSafeInteger(value.expiresAt) ||
    value.expiresAt <= now
  ) {
    throw new WorkerProtocolError("Worker authentication endpoint returned an invalid token");
  }
  return { token: value.token, expiresAt: value.expiresAt };
}

function nowOf(options: AuthOptions): number {
  return options.now?.() ?? Date.now();
}

function isRecoverMiss(status: number): boolean {
  // The app deliberately collapses recovery authorization failures to 401.
  return status === 401 || status === 404;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
