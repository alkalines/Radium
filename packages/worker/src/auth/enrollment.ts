import {
  type WorkerIdentity,
  type WorkerSetup,
  WorkerHttpError,
  WorkerProtocolError,
  parseSetupCode,
  postJson,
} from "../protocol.js";
import {
  assertSetupMatches,
  createPendingState,
  readWorkerState,
  saveWorkerIdentity,
  type WorkerState,
} from "./state.js";
import {
  type AuthOptions,
  type WorkerAuthChallenge,
  nowOf,
  requestChallenge,
  signChallenge,
} from "./proof.js";

/** The backend has no enrollment receipt for a locally pending identity. */
export class EnrollmentNotFoundError extends Error {
  constructor() {
    super("The pending Worker enrollment was not found");
    this.name = "EnrollmentNotFoundError";
  }
}

/** Enroll from a protected setup code, attempting key-bound recovery before creation. */
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

/** Recover a pending enrollment after restart without retaining the one-time setup token. */
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
  let challenge: WorkerAuthChallenge;
  try {
    challenge = await requestChallenge(
      state,
      {
        kind: "recover",
        enrollmentId: state.setup.enrollmentId,
        requestId: state.requestId,
        publicKey: state.publicKey,
      },
      options,
    );
  } catch (error) {
    if (error instanceof WorkerHttpError && isRecoverMiss(error.status)) {
      throw new EnrollmentNotFoundError();
    }
    throw error;
  }
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

function isRecoverMiss(status: number): boolean {
  // The app deliberately collapses recovery authorization failures to 401.
  return status === 401 || status === 404;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
