import type { Hono } from "hono";
import { ACP_APPEND_BODY_BYTES, epochFence, parseAppendFrames } from "../acp/live";
import { chatAccess } from "../chatroom/access";
import { disableIdleTimeout } from "../gateway/http";
import type { Runtime } from "../runtime";
import { resolveWorker } from "../worker/auth";
import { workspaceAccess } from "../workspaces/access";
import { isStreamPath } from "./server";

type StreamApp = Hono<{ Variables: { runtime: Runtime } }>;

/** Reader parameters of the protocol; nothing else reaches the stream server. */
const READ_PARAMETERS = ["offset", "live", "cursor"] as const;

/** Response headers that describe the proxied body as `fetch` received it, not as we send it. */
const DROPPED_RESPONSE_HEADERS = [
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  // Authorized, per-user content: never cacheable by a shared cache (set below).
  "cache-control",
  "etag",
];

/** An ACP epoch stream path: `c/<chat>/acp/<epoch>`. */
const EPOCH_PATH = /^c\/([A-Za-z0-9_-]{1,128})\/acp\/([1-9][0-9]{0,14})$/;

/** Producer response headers a Worker needs to drive its idempotent producer. */
const PRODUCER_RESPONSE_HEADERS = [
  "producer-epoch",
  "producer-seq",
  "producer-expected-seq",
  "producer-received-seq",
  "stream-next-offset",
  "stream-closed",
];

/**
 * The request body as text, or `null` past `maxBytes`: the declared length is checked first and
 * the read stops as soon as the bound is crossed, so an oversized body is never buffered.
 */
async function boundedText(request: Request, maxBytes: number): Promise<string | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (!Number.isFinite(declared) || declared > maxBytes) return null;
  if (!request.body) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of request.body) {
    size += chunk.byteLength;
    if (size > maxBytes) return null;
    chunks.push(chunk);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/**
 * Who may read `path`, decided by one check per stream kind (`docs/Backend_Migration/Live_Data.md`,
 * Stream Proxy). Every read and reconnect passes here again, so lost access applies within one
 * SSE recycle interval.
 *
 * - `u/<user>/events/*`: that user's session;
 * - `w/<workspace>/events/*`: the owner or a direct member (`workspaceProcedure`'s check);
 * - `c/<chat>/runs|acp/*`: whoever the Chatroom access function lets see the chat;
 * - `k/<worker>/inbox/*`: that Worker's access token, with revocation and identity epoch checked.
 *
 * Chat signal streams (`c/<chat>/signals/*`) are read by backend handlers only.
 *
 * @returns `"unauthenticated"` without a session or token, otherwise whether access is granted.
 */
async function canRead(runtime: Runtime, request: Request, path: string): Promise<boolean | "unauthenticated"> {
  const [kind, id, name] = path.split("/") as [string, string, string];
  const { db } = runtime.drivers;

  if (kind === "k" && name === "inbox") {
    const authorization = request.headers.get("authorization");
    if (!authorization?.startsWith("Bearer ")) return "unauthenticated";
    const worker = await resolveWorker(db, runtime.workerTokens, authorization.slice("Bearer ".length));
    if (!worker) return "unauthenticated";
    return worker.workerId === id;
  }

  const readable =
    (kind === "u" && name === "events") ||
    (kind === "w" && name === "events") ||
    (kind === "c" && (name === "runs" || name === "acp"));
  if (!readable) return false;

  const session = await runtime.auth.api.getSession({ headers: request.headers });
  if (!session) return "unauthenticated";
  const userId = session.user.id;
  if (kind === "u") return userId === id;
  if (kind === "w") return (await workspaceAccess(db, userId, id)) !== null;
  return (await chatAccess(db, userId, id)) !== null;
}

/**
 * Copies the stream server's response, minus headers that no longer describe it. Its permissive
 * CORS headers are dropped too: these routes serve the same origin only.
 */
function relay(upstream: Response): Response {
  const headers = new Headers(upstream.headers);
  for (const name of DROPPED_RESPONSE_HEADERS) headers.delete(name);
  for (const name of [...headers.keys()]) {
    if (name.startsWith("access-control-")) headers.delete(name);
  }
  headers.set("cache-control", "no-store");
  headers.set("cross-origin-resource-policy", "same-origin");
  return new Response(upstream.body, { status: upstream.status, headers });
}

/**
 * `POST /api/streams/c/<chat>/acp/<epoch>`: the one append path open to a client, for the chat's
 * bound Worker only (`docs/Backend_Migration/Live_Data.md`, Stream Proxy). Checks, in order: the
 * Worker token, the append fence (bound Worker, current open epoch; refusals of other callers look
 * like a missing stream), JSON content, the body bound, idempotent-producer headers with
 * `Producer-Id` `<worker>:<epoch>`, and the frames (`parseAppendFrames`). The validated frames are
 * re-serialized, so nothing else reaches the stream; status and producer headers come back.
 */
async function appendEpochFrames(runtime: Runtime, request: Request, chat: string, epoch: number): Promise<Response> {
  const refuse = (status: number, error: string) => Response.json({ error }, { status });
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return refuse(401, "Unauthorized");
  const worker = await resolveWorker(runtime.drivers.db, runtime.workerTokens, authorization.slice("Bearer ".length));
  if (!worker) return refuse(401, "Unauthorized");
  const fence = await epochFence(runtime, chat, epoch);
  // Anyone but the bound Worker sees no stream at all; the bound Worker learns its epoch closed.
  if (fence?.worker !== worker.workerId) return refuse(404, "Not found");
  if (fence.epoch !== epoch) return refuse(409, "ACP_STALE_EPOCH");

  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    return refuse(415, "Unsupported Media Type");
  }
  const producerEpoch = request.headers.get("producer-epoch") ?? "";
  const producerSeq = request.headers.get("producer-seq") ?? "";
  if (
    request.headers.get("producer-id") !== `${worker.workerId}:${epoch}` ||
    !/^[0-9]{1,15}$/.test(producerEpoch) ||
    !/^[0-9]{1,15}$/.test(producerSeq)
  ) {
    return refuse(400, "ACP_PRODUCER_REQUIRED");
  }
  const text = await boundedText(request, ACP_APPEND_BODY_BYTES);
  if (text === null) return refuse(413, "ACP_FRAME_TOO_LARGE");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return refuse(400, "ACP_INVALID_FRAMES");
  }
  const frames = parseAppendFrames(body);
  if (typeof frames === "string") return refuse(frames === "ACP_FRAME_TOO_LARGE" ? 413 : 400, frames);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Producer-Id": `${worker.workerId}:${epoch}`,
    "Producer-Epoch": producerEpoch,
    "Producer-Seq": producerSeq,
  };
  if (request.headers.get("stream-closed")?.toLowerCase() === "true") headers["Stream-Closed"] = "true";
  const upstream = await runtime.streams.forward(`c/${chat}/acp/${epoch}`, {
    method: "POST",
    query: new URLSearchParams(),
    headers,
    body: new Blob([JSON.stringify(frames)]).stream(),
    signal: request.signal,
  });
  await upstream.body?.cancel();
  const relayed = new Headers({ "cache-control": "no-store" });
  for (const name of PRODUCER_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value !== null) relayed.set(name, value);
  }
  return new Response(null, { status: upstream.status, headers: relayed });
}

/**
 * `GET /api/streams/<path>`: the authorizing read proxy in front of the internal stream server.
 * Refusals look like a missing stream (`404`), so paths cannot be probed. Long-poll and SSE
 * responses are piped through with the idle timeout off, since the server sends no keepalives.
 * `POST` appends to ACP epoch streams only ({@link appendEpochFrames}).
 */
export function mountStreamRoutes(app: StreamApp) {
  app.get("/api/streams/*", async (c) => {
    const runtime = c.var.runtime;
    const request = c.req.raw;
    const path = decodeURIComponent(new URL(request.url).pathname.slice("/api/streams/".length));
    if (!isStreamPath(path)) return c.json({ error: "Not found" }, 404);

    const allowed = await canRead(runtime, request, path);
    if (allowed === "unauthenticated") return c.json({ error: "Unauthorized" }, 401);
    if (!allowed) return c.json({ error: "Not found" }, 404);

    const incoming = new URL(request.url).searchParams;
    const query = new URLSearchParams();
    for (const name of READ_PARAMETERS) {
      const value = incoming.get(name);
      if (value !== null && value.length <= 256) query.set(name, value);
    }

    disableIdleTimeout(request);
    const upstream = await runtime.streams.forward(path, { method: "GET", query, signal: request.signal });
    return relay(upstream);
  });

  app.post("/api/streams/*", async (c) => {
    const path = decodeURIComponent(new URL(c.req.url).pathname.slice("/api/streams/".length));
    const match = EPOCH_PATH.exec(path);
    if (!match) return c.json({ error: "Not found" }, 404);
    return await appendEpochFrames(c.var.runtime, c.req.raw, match[1]!, Number(match[2]));
  });
}
