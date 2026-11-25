import { calculateJwkThumbprint, exportJWK, importJWK, jwtVerify, SignJWT, type JWK } from "jose";
import { publicWorkerJwks, WORKER_AUDIENCE, workerIssuer } from "./auth";

/**
 * Cryptography of Worker machine authentication (Convex `src/worker/auth.ts`). Two independent
 * key pairs:
 * - each Worker's own proof key, whose public half is stored at enrollment and verifies the
 *   Worker's challenge proofs;
 * - the operator's issuer key (`WORKER_AUTH_PRIVATE_JWK`), which signs short-lived access tokens
 *   that `resolveWorker` verifies with the public `WORKER_AUTH_JWKS`.
 * Nothing here authorizes or consumes anything; `machine-auth.ts` does.
 */

/** Distinguishes Worker-signed challenge proofs from backend-signed access tokens. */
export const PROOF_TYPE = "radium-worker-proof+jwt";
/** A proof must arrive before its challenge expires. */
export const CHALLENGE_TTL_MS = 60_000;
/** Access tokens are bearer credentials, valid for five minutes before refresh. */
export const TOKEN_TTL_MS = 5 * 60_000;
/** A displayed setup code can start one enrollment for ten minutes. */
export const ENROLLMENT_TTL_MS = 10 * 60_000;

const COORDINATE = /^[A-Za-z0-9_-]{43}$/;

/** The operator's private issuer key, validated at startup (`config.ts`). */
export type WorkerSigningKey = {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
  d: string;
  kid: string;
};

/**
 * Parses `WORKER_AUTH_PRIVATE_JWK`. Error messages describe the expected shape only: a JSON
 * parser's diagnostics could quote fragments of the secret.
 */
export function parseWorkerSigningKey(raw: string): WorkerSigningKey {
  let key: JWK | null;
  try {
    key = JSON.parse(raw) as JWK | null;
  } catch {
    throw new Error("must be a JSON private JWK");
  }
  if (
    !key ||
    typeof key !== "object" ||
    key.kty !== "EC" ||
    key.crv !== "P-256" ||
    typeof key.x !== "string" ||
    typeof key.y !== "string" ||
    typeof key.d !== "string" ||
    !COORDINATE.test(key.x) ||
    !COORDINATE.test(key.y) ||
    !COORDINATE.test(key.d) ||
    typeof key.kid !== "string" ||
    !key.kid ||
    key.kid.length > 128
  ) {
    throw new Error("must be an ES256 (P-256) private JWK with a kid");
  }
  return { kty: "EC", crv: "P-256", x: key.x, y: key.y, d: key.d, kid: key.kid };
}

/**
 * Whether the public JWKS lists the signing key's public half under its `kid` (Convex
 * `machineSigningKey`: same `kid`, same thumbprint; equal coordinates are an equal thumbprint).
 */
export function workerSigningKeyMatches(key: WorkerSigningKey, rawJwks: string | undefined) {
  if (!rawJwks) return false;
  let jwks;
  try {
    jwks = publicWorkerJwks(rawJwks);
  } catch {
    return false;
  }
  const published = jwks.keys.find((candidate) => candidate.kid === key.kid);
  return published?.x === key.x && published.y === key.y;
}

/**
 * Validates a Worker's public proof key and returns its stored form. Re-exporting canonicalizes
 * the coordinates, so alternative encodings of one key cannot become two identities; the
 * thumbprint is a stable digest of the public key, not a secret.
 */
export async function normalizeWorkerKey(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid key");
  const key = value as JWK;
  if (
    key.kty !== "EC" ||
    key.crv !== "P-256" ||
    "d" in key ||
    typeof key.x !== "string" ||
    typeof key.y !== "string" ||
    !COORDINATE.test(key.x) ||
    !COORDINATE.test(key.y)
  ) {
    throw new Error("Invalid key");
  }
  const imported = await importJWK({ kty: "EC", crv: "P-256", x: key.x, y: key.y }, "ES256");
  const exported = await exportJWK(imported);
  const canonical = { kty: "EC", crv: "P-256", x: exported.x!, y: exported.y! };
  return {
    algorithm: "ES256",
    material: JSON.stringify(canonical),
    thumbprint: await calculateJwkThumbprint(canonical),
  };
}

/** Hex SHA-256 of the exact setup-token text; only this digest is stored. */
export async function tokenDigest(token: string) {
  if (!COORDINATE.test(token)) throw new Error("Invalid token");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** 32 random bytes, base64url: setup tokens and challenge ids. */
export function randomToken() {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
}

/**
 * Checks that the caller holds the private key of a stored challenge: signature, type, audience,
 * challenge id and a lifetime of at most sixty seconds. JWT times are seconds.
 */
export async function verifyWorkerProof(
  proof: string,
  challengeId: string,
  material: string,
  audience: string,
) {
  if (proof.length > 4096) throw new Error("Invalid proof");
  const key = await importJWK(JSON.parse(material) as JWK, "ES256");
  const { payload } = await jwtVerify(proof, key, {
    algorithms: ["ES256"],
    typ: PROOF_TYPE,
    audience,
    requiredClaims: ["iat", "exp", "challengeId"],
    maxTokenAge: "60s",
    clockTolerance: 5,
  });
  const now = Math.floor(Date.now() / 1000);
  if (
    payload.challengeId !== challengeId ||
    typeof payload.iat !== "number" ||
    typeof payload.exp !== "number" ||
    payload.iat > now + 5 ||
    payload.exp <= payload.iat ||
    payload.exp - payload.iat > 60
  ) {
    throw new Error("Invalid proof");
  }
}

/** A Worker identity admitted by machine authentication. */
export type WorkerIdentity = {
  workerId: string;
  keyId: string;
  workspaceId: string;
  identityEpoch: number;
};

/**
 * Signs a five-minute access token for an admitted identity (Convex `issueMachineToken`). The
 * subject is the Worker; workspace, key and epoch are its scope. The epoch is a revocation
 * version: `resolveWorker` compares it with current state on every call.
 */
export async function issueWorkerToken(
  identity: WorkerIdentity,
  signingKey: WorkerSigningKey,
  apiUrl: string,
) {
  const key = await importJWK(signingKey, "ES256");
  const now = Math.floor(Date.now() / 1000);
  const exp = now + TOKEN_TTL_MS / 1000;
  const token = await new SignJWT({
    kind: "worker",
    workspaceId: identity.workspaceId,
    keyId: identity.keyId,
    identityEpoch: identity.identityEpoch,
  })
    .setProtectedHeader({ alg: "ES256", typ: "JWT", kid: signingKey.kid })
    .setIssuer(workerIssuer(apiUrl))
    .setAudience(WORKER_AUDIENCE)
    .setSubject(identity.workerId)
    .setIssuedAt(now)
    .setExpirationTime(exp)
    .sign(key);
  return { token, expiresAt: exp * 1000 };
}
