import { z } from "zod";
import type { App } from "../app";
import { completeChallenge, createChallenge } from "./identity";

/**
 * Worker machine authentication over HTTP (`docs/Worker/Machine_Authentication.md`), contract
 * unchanged from Convex `src/http/worker.ts`: strict JSON bodies of at most 8 KiB, `no-store`,
 * and every failure, whatever its cause, `401 {"error":"WORKER_AUTH_DENIED"}`. Request material
 * is never logged.
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
const headers = { "Cache-Control": "no-store", Pragma: "no-cache" };

/** Reads a JSON body, bounding the bytes actually streamed (not `Content-Length`). */
async function readBody(request: Request): Promise<unknown> {
  if (!request.headers.get("content-type")?.startsWith("application/json")) {
    throw new Error("Invalid body");
  }
  const reader = request.body?.getReader();
  if (!reader) throw new Error("Missing body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_AUTH_BODY_BYTES) throw new Error("Body too large");
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

/** Mounts `POST /api/worker/auth/challenge` and `/complete`. */
export function mountWorkerAuthRoutes(app: App) {
  app.post("/api/worker/auth/:operation{challenge|complete}", async (c) => {
    try {
      const body = await readBody(c.req.raw);
      const result =
        c.req.param("operation") === "challenge"
          ? await createChallenge(c.var.runtime, challengeRequest.parse(body))
          : await completeChallenge(c.var.runtime, completionRequest.parse(body));
      return Response.json(result, { headers });
    } catch {
      // Selector, key, proof, replay and rate-limit refusals look the same; nothing is logged.
      return Response.json({ error: "WORKER_AUTH_DENIED" }, { status: 401, headers });
    }
  });
}
