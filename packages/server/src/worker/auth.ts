import { and, eq, isNull } from "drizzle-orm";
import { createLocalJWKSet, jwtVerify, type JWK, type JWTVerifyGetKey } from "jose";
import type { Database } from "../drivers/types";
import { workspaces } from "../workspaces/schema";
import { workerKeys, workers } from "./schema";

/**
 * Verification side of Worker machine authentication. Workers prove their own key at
 * `/api/worker/auth/*` and get a short-lived ES256 access token signed with the operator's issuer
 * key (`WORKER_AUTH_PRIVATE_JWK`); every Worker request presents that token. Issuing tokens moves
 * here with the rest of the Worker domain.
 */

/** The JWT audience identifies which service may accept a machine access token. */
export const WORKER_AUDIENCE = "radium-worker";

/** The issuer claim ties access tokens to this backend's machine-auth namespace. */
export function workerIssuer(apiUrl: string) {
  return `${apiUrl}/api/worker`;
}

/**
 * Parses the public issuer key set, rejecting private material, duplicate key ids, and sets
 * larger than five keys so operators can rotate issuer keys safely.
 */
export function publicWorkerJwks(raw: string) {
  let jwks: { keys?: JWK[] };
  try {
    jwks = JSON.parse(raw) as { keys?: JWK[] };
  } catch {
    throw new Error("Invalid Worker public JWKS");
  }
  if (
    !jwks ||
    !Array.isArray(jwks.keys) ||
    jwks.keys.length < 1 ||
    jwks.keys.length > 5 ||
    jwks.keys.some(
      (key) =>
        !key ||
        key.kty !== "EC" ||
        key.crv !== "P-256" ||
        "d" in key ||
        key.alg !== "ES256" ||
        typeof key.kid !== "string" ||
        !key.kid ||
        typeof key.x !== "string" ||
        typeof key.y !== "string",
    ) ||
    new Set(jwks.keys.map((key) => key.kid)).size !== jwks.keys.length
  ) {
    throw new Error("Invalid Worker public JWKS");
  }
  return jwks as { keys: JWK[] };
}

/** Verifies Worker access tokens of one deployment; `null` when `WORKER_AUTH_JWKS` is unset. */
export type WorkerTokenVerifier = { issuer: string; keys: JWTVerifyGetKey };

export function createWorkerTokenVerifier(
  apiUrl: string,
  rawJwks: string | undefined,
): WorkerTokenVerifier | null {
  if (!rawJwks) {
    return null;
  }
  return { issuer: workerIssuer(apiUrl), keys: createLocalJWKSet(publicWorkerJwks(rawJwks)) };
}

/** Server-derived identity of an authenticated Worker. */
export type WorkerScope = {
  workerId: string;
  keyId: string;
  workspaceId: string;
  identityEpoch: number;
};

/**
 * Resolves a Worker access token to its current scope, or `null` for any failure, so callers
 * deny every case the same way.
 *
 * The token's workspace and key ids are selectors, not authority: the key, its Worker and the
 * workspace are re-read on every call, so revocation (a new identity epoch), an archived
 * workspace or a deleted key take effect while the token's signature is still valid.
 */
export async function resolveWorker(
  db: Database,
  verifier: WorkerTokenVerifier | null,
  token: string,
): Promise<WorkerScope | null> {
  if (!verifier) {
    return null;
  }

  let claims;
  try {
    const verified = await jwtVerify(token, verifier.keys, {
      algorithms: ["ES256"],
      issuer: verifier.issuer,
      audience: WORKER_AUDIENCE,
      requiredClaims: ["sub", "iat", "exp"],
    });
    claims = verified.payload;
  } catch {
    return null;
  }
  if (
    claims.kind !== "worker" ||
    typeof claims.sub !== "string" ||
    typeof claims.workspaceId !== "string" ||
    typeof claims.keyId !== "string" ||
    typeof claims.identityEpoch !== "number"
  ) {
    return null;
  }

  const [current] = await db
    .select({ workerId: workers.id, identityEpoch: workers.identityEpoch })
    .from(workerKeys)
    .innerJoin(workers, eq(workers.id, workerKeys.worker))
    .innerJoin(workspaces, eq(workspaces.id, workers.workspace))
    .where(
      and(
        eq(workerKeys.id, claims.keyId),
        eq(workers.workspace, claims.workspaceId),
        eq(workers.status, "active"),
        isNull(workspaces.archivedAt),
      ),
    );
  if (
    !current ||
    current.workerId !== claims.sub ||
    current.identityEpoch !== claims.identityEpoch
  ) {
    return null;
  }

  return {
    workerId: current.workerId,
    keyId: claims.keyId,
    workspaceId: claims.workspaceId,
    identityEpoch: current.identityEpoch,
  };
}
