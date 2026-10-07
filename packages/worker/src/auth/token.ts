import { WorkerProtocolError, postJson } from "../protocol.js";
import type { WorkerState } from "./state.js";
import { type AuthOptions, nowOf, requestChallenge, signChallenge } from "./proof.js";

const TOKEN_REFRESH_SKEW_MS = 30_000;

/** Backend access token returned by a machine-authenticated exchange. */
export interface MachineTokenResponse {
  token: string;
  expiresAt: number;
}

/**
 * Create a `ConvexClient.setAuth` callback for one saved identity.
 * Concurrent SDK refreshes share one proof exchange. Failure drops cached authority
 * and returns `null`; the control connection is responsible for re-arming auth.
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

/**
 * Exchange a fresh key-possession proof for the backend-issued JWT accepted by Convex.
 * Unlike the SDK callback, this diagnostic entry point propagates failures; callers
 * must keep the returned token in memory and never print it in CLI output.
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
