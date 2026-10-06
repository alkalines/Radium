import { z } from "zod";
import { internal } from "../../convex/_generated/api";
import type { ActionCtx } from "../../convex/_generated/server";
import {
  backendOrigin,
  issueMachineToken,
  machineSigningKey,
  normalizeWorkerKey,
  tokenDigest,
  verifyWorkerProof,
} from "../worker/auth";

/**
 * HTTP machine-auth boundary on the Convex site origin.
 * POST /challenge stores operation scope and returns a challenge selector.
 * POST /complete verifies the Worker's signature, admits the challenge through
 * an internal mutation, then returns either its identity or a Convex access JWT.
 * Request fields never serve as evidence that a key was already verified.
 */

const selector = z.string().min(1).max(256);
const challengeRequest = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("enroll"),
      enrollmentId: selector,
      requestId: selector,
      publicKey: z.unknown(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("recover"),
      enrollmentId: selector,
      requestId: selector,
      publicKey: z.unknown(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("token"),
      workspaceId: selector,
      workerId: selector,
      keyId: selector,
    })
    .strict(),
]);
const completionRequest = z
  .object({
    challengeId: selector,
    proof: z.string().min(1).max(4096),
    token: z.string().max(128).optional(),
  })
  .strict();

const MAX_AUTH_BODY_BYTES = 8 * 1024;

/** Bound actual streamed input independently of Content-Length before parsing credentials. */
async function readBody(request: Request): Promise<unknown> {
  if (!request.headers.get("content-type")?.startsWith("application/json")) {
    throw new Error("Invalid body");
  }
  const reader = request.body?.getReader();
  if (!reader) {
    throw new Error("Missing body");
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      size += value.byteLength;
      if (size > MAX_AUTH_BODY_BYTES) {
        throw new Error("Body too large");
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
}

/**
 * Handle setup/recovery/token exchanges without a human session or deployment key.
 * Only initial enrollment sends the setup token. Other exchanges prove possession
 * of the Worker's private key. The backend issuer's private key is never returned.
 */
export async function handleWorkerAuth(
  ctx: ActionCtx,
  request: Request,
  operation: "challenge" | "complete",
) {
  const headers = { "Cache-Control": "no-store", Pragma: "no-cache" };
  try {
    const audience = backendOrigin(process.env.CONVEX_SITE_URL);
    // Check issuer configuration before creating a challenge that cannot be completed.
    await machineSigningKey();
    const body = await readBody(request);

    if (operation === "challenge") {
      const parsed = challengeRequest.parse(body);
      const args =
        parsed.kind === "token"
          ? parsed
          : { ...parsed, publicKey: await normalizeWorkerKey(parsed.publicKey) };
      const challenge = await ctx.runMutation(internal.workers.createChallenge, args);
      return Response.json({ ...challenge, audience }, { headers });
    }
    const parsed = completionRequest.parse(body);
    const challenge = await ctx.runQuery(internal.workers.getChallenge, {
      challengeId: parsed.challengeId,
    });
    if (!challenge) {
      throw new Error("Invalid challenge");
    }

    // Verify against the key stored in the challenge, not a completion-body key.
    await verifyWorkerProof(parsed.proof, parsed.challengeId, challenge.material, audience);
    if ((challenge.kind === "enroll") !== (parsed.token !== undefined)) {
      throw new Error("Invalid token context");
    }
    const identity = await ctx.runMutation(internal.workers.admitProof, {
      challengeId: parsed.challengeId,
      ...(parsed.token !== undefined ? { tokenHash: await tokenDigest(parsed.token) } : {}),
    });
    // Admission is the durable boundary. Signing/delivery can fail afterward;
    // the Worker retries token auth with a fresh challenge, or recovers enrollment.
    return Response.json(
      challenge.kind === "token" ? await issueMachineToken(identity, audience) : identity,
      { headers },
    );
  } catch {
    // Collapse selector/key/replay errors and never log authentication request material.
    return Response.json({ error: "WORKER_AUTH_DENIED" }, { status: 401, headers });
  }
}
