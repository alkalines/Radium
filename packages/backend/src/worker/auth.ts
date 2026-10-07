import { calculateJwkThumbprint, exportJWK, importJWK, jwtVerify, SignJWT, type JWK } from "jose";

/**
 * Cryptographic helpers for the app-owned Worker authentication boundary.
 *
 * There are two independent key pairs:
 * - Each Worker generates a key to prove its own identity. The component stores
 *   only that Worker's public key, which verifies incoming challenge proofs.
 * - The backend has an issuer key configured by the operator. Its private JWK
 *   signs short-lived access tokens; its public JWKS lets Convex verify them.
 *
 * A JWK is a key encoded as JSON; a JWKS is `{ keys: [publicJwk, ...] }`.
 * These helpers do not authorize database operations or consume challenges:
 * `identity.ts` admits proofs transactionally; the `workerQuery` and
 * `workerMutation` builders in `machine.ts` authorize machine access.
 */

/** The JWT audience identifies which service may accept a machine access token. */
export const WORKER_AUDIENCE = "radium-worker";
/** Distinguish Worker-signed challenge proofs from backend-signed access tokens. */
export const PROOF_TYPE = "radium-worker-proof+jwt";
/** A proof must be admitted before its stored challenge expires. */
export const CHALLENGE_TTL = 60_000;
/** Access tokens are bearer credentials, valid for five minutes before refresh. */
export const TOKEN_TTL = 5 * 60_000;
/** The displayed setup credential can start a new enrollment for ten minutes. */
export const ENROLLMENT_TTL = 10 * 60_000;

/**
 * Validate a Worker's public key and produce the component's storage format.
 * P-256 is the supported elliptic curve; ES256 is its JWT signature algorithm.
 * Re-exporting canonicalizes the coordinates so alternative JSON/base64
 * representations cannot produce different identities for one key.
 * The thumbprint is a stable digest of public key material, not a secret.
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
    !/^[A-Za-z0-9_-]{43}$/.test(key.x) ||
    !/^[A-Za-z0-9_-]{43}$/.test(key.y)
  )
    throw new Error("Invalid key");
  const jwk = { kty: "EC", crv: "P-256", x: key.x, y: key.y };
  const imported = await importJWK(jwk, "ES256");
  const exported = await exportJWK(imported);
  const canonical = { kty: "EC", crv: "P-256", x: exported.x!, y: exported.y! };
  return {
    algorithm: "ES256",
    material: JSON.stringify(canonical),
    thumbprint: await calculateJwkThumbprint(canonical),
  };
}

/** Hash the exact setup-token text; only this digest reaches persistence mutations. */
export async function tokenDigest(token: string) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("Invalid token");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Generate the secret delivered once in the setup code, using 32 random bytes. */
export function randomToken() {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

/** The issuer claim ties access tokens to this backend's machine-auth namespace. */
export function workerIssuer(backendUrl: string) {
  return `${backendUrl}/api/worker`;
}

/**
 * Accept an HTTPS origin, or HTTP loopback for local development, and reject
 * credentials, paths, queries, and fragments. URL.origin removes a trailing slash.
 */
export function backendOrigin(value: string | undefined) {
  if (!value) throw new Error("Worker authentication is not configured");
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    !(
      url.protocol === "https:" ||
      (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    )
  ) {
    throw new Error("Invalid Worker backend origin");
  }
  return url.origin;
}

/**
 * Verify that the caller possesses the private key for a stored challenge.
 * The signature, audience, challenge selector and short lifetime must all match.
 * This does not mark the challenge used: HTTP verification happens before the
 * admission mutation, which rechecks expiry/revocation and consumes it atomically.
 * JWT timestamps are seconds; database deadlines elsewhere are milliseconds.
 */
export async function verifyWorkerProof(
  proof: string,
  challengeId: string,
  material: string,
  audience: string,
) {
  if (proof.length > 4096) throw new Error("Invalid proof");
  const key = await importJWK(JSON.parse(material), "ES256");
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
  )
    throw new Error("Invalid proof");
}

/**
 * Parse the public issuer key set, rejecting private material, duplicate key IDs,
 * and sets larger than five keys so operators can rotate issuer keys safely.
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

/**
 * Load the backend issuer's private key and check the configured public half.
 * Matching `kid` selects a key; matching thumbprints confirms the same key pair.
 * Configuration is checked before issuing setup codes as well as access tokens,
 * avoiding enrollments that cannot subsequently authenticate to Convex.
 */
export async function machineSigningKey() {
  let privateJwk: JWK | null;
  try {
    privateJwk = JSON.parse(process.env.WORKER_AUTH_PRIVATE_JWK ?? "null") as JWK | null;
  } catch {
    // JSON parser diagnostics may include raw issuer-secret fragments.
    throw new Error("Invalid Worker private issuer configuration");
  }
  const jwks = publicWorkerJwks(process.env.WORKER_AUTH_JWKS ?? "null");
  if (
    !privateJwk ||
    privateJwk.kty !== "EC" ||
    privateJwk.crv !== "P-256" ||
    !privateJwk.d ||
    typeof privateJwk.kid !== "string" ||
    !privateJwk.kid ||
    !jwks?.keys?.length
  )
    throw new Error("Worker authentication is not configured");
  const publicJwk = jwks.keys.find((key) => key.kid === privateJwk.kid);
  if (
    !publicJwk ||
    "d" in publicJwk ||
    publicJwk.alg !== "ES256" ||
    (await calculateJwkThumbprint(publicJwk)) !== (await calculateJwkThumbprint(privateJwk))
  ) {
    throw new Error("Worker authentication signing key mismatch");
  }
  return { key: await importJWK(privateJwk, "ES256"), kid: privateJwk.kid };
}

/**
 * Sign a short-lived Convex access token for an already admitted Worker identity.
 * The subject identifies the Worker; workspace/key/epoch claims carry its scope.
 * The epoch is a revocation version, not an expiry time. App functions still
 * compare it to current component state, even when the JWT signature is valid.
 */
export async function issueMachineToken(
  identity: { workerId: string; keyId: string; workspaceId: string; identityEpoch: number },
  backendUrl: string,
) {
  const { key, kid } = await machineSigningKey();
  const now = Math.floor(Date.now() / 1000);
  const exp = now + TOKEN_TTL / 1000;
  const token = await new SignJWT({
    kind: "worker",
    workspaceId: identity.workspaceId,
    keyId: identity.keyId,
    identityEpoch: identity.identityEpoch,
  })
    .setProtectedHeader({ alg: "ES256", typ: "JWT", kid })
    .setIssuer(workerIssuer(backendUrl))
    .setAudience(WORKER_AUDIENCE)
    .setSubject(identity.workerId)
    .setIssuedAt(now)
    .setExpirationTime(exp)
    .sign(key);
  return { token, expiresAt: exp * 1000 };
}
