import type { Hono } from "hono";
import { ObjectTooLargeError } from "../drivers/types";
import { legacyStorageInput, legacyStorageKey } from "../e2ee/legacy-storage";
import { AppError } from "../errors";
import { kvGet } from "../kv";
import type { Runtime } from "../runtime";
import {
  authorizeFileDownload,
  isFileId,
  MAX_ENCRYPTED_CHAT_FILE_BYTES,
  resolveLegacyDownload,
  uploadKey,
} from "./files";

type FilesApp = Hono<{ Variables: { runtime: Runtime } }>;

const PRESIGNED_GET_SECONDS = 60;

const unauthorized = () => Response.json({ error: "Unauthorized" }, { status: 401 });
const notFound = () => Response.json({ error: "Not found" }, { status: 404 });

async function sessionUserId(runtime: Runtime, request: Request) {
  const session = await runtime.auth.api.getSession({ headers: request.headers });
  return session?.user.id ?? null;
}

/**
 * Streams or redirects to an object the caller is already authorized for. Local disk serves the
 * bytes (opaque, never rendered); S3 redirects to a short-lived presigned URL.
 */
async function downloadResponse(runtime: Runtime, key: string): Promise<Response> {
  const headers = { "cache-control": "private, no-store", "x-content-type-options": "nosniff" };
  const presigned = runtime.drivers.objects.presignGet(key, {
    expiresInSeconds: PRESIGNED_GET_SECONDS,
  });
  if (presigned) {
    return new Response(null, { status: 302, headers: { ...headers, location: presigned } });
  }
  const bytes = await runtime.drivers.objects.get(key);
  if (!bytes) return notFound();
  return new Response(bytes, {
    headers: { ...headers, "content-type": "application/octet-stream" },
  });
}

/**
 * `/api/files`: the local-disk upload route and downloads. Every route needs a session; unknown
 * and unauthorized objects answer alike (`404`).
 */
export function mountFileRoutes(app: FilesApp) {
  // Local disk only: S3 uploads go straight to the presigned URL.
  app.put("/api/files/upload/:id", async (c) => {
    const runtime = c.var.runtime;
    const userId = await sessionUserId(runtime, c.req.raw);
    if (!userId) return unauthorized();
    const id = c.req.param("id");
    const key = isFileId(id) ? uploadKey(id) : null;
    if (
      !key ||
      runtime.drivers.objects.presignPut(key, { expiresInSeconds: 1 }) !== null ||
      !(await kvGet(runtime.drivers.kv, `upload:${id}`))?.startsWith(`${userId}:`)
    ) {
      return notFound();
    }
    const declared = Number(c.req.header("content-length") ?? 0);
    const body = c.req.raw.body;
    if (!body) return Response.json({ error: "Empty body" }, { status: 400 });
    if (declared > MAX_ENCRYPTED_CHAT_FILE_BYTES) {
      return Response.json({ error: "File too large" }, { status: 413 });
    }
    try {
      await runtime.drivers.objects.put(key, body, { maxBytes: MAX_ENCRYPTED_CHAT_FILE_BYTES });
    } catch (error) {
      if (error instanceof ObjectTooLargeError) {
        return Response.json({ error: "File too large" }, { status: 413 });
      }
      throw error;
    }
    return new Response(null, { status: 200 });
  });

  // Imported messages still carry Convex storage URLs; they resolve through `chat_files.legacy_url`.
  app.get("/api/files/resolve", async (c) => {
    const runtime = c.var.runtime;
    const userId = await sessionUserId(runtime, c.req.raw);
    if (!userId) return unauthorized();
    const url = c.req.query("url");
    if (!url || url.length > 2048) return notFound();
    const key = await resolveLegacyDownload(runtime.drivers.db, userId, url);
    return key ? await downloadResponse(runtime, key) : notFound();
  });

  // Historical sidecar envelopes kept in the object store (`e2ee.legacyStorageUrl` points here on
  // stores that cannot presign); authorized like the source row, `404` otherwise.
  app.get("/api/files/legacy", async (c) => {
    const runtime = c.var.runtime;
    const userId = await sessionUserId(runtime, c.req.raw);
    if (!userId) return unauthorized();
    const input = legacyStorageInput.safeParse({
      table: c.req.query("table"),
      record: c.req.query("record"),
    });
    if (!input.success) return notFound();
    let key: string | null;
    try {
      key = await legacyStorageKey(runtime.drivers.db, userId, input.data);
    } catch (error) {
      if (error instanceof AppError) return notFound();
      throw error;
    }
    return key ? await downloadResponse(runtime, key) : notFound();
  });

  app.get("/api/files/:id", async (c) => {
    const runtime = c.var.runtime;
    const userId = await sessionUserId(runtime, c.req.raw);
    if (!userId) return unauthorized();
    const id = c.req.param("id");
    if (!isFileId(id)) return notFound();
    const key = uploadKey(id);
    if (!(await authorizeFileDownload(runtime.drivers.db, userId, key))) return notFound();
    return await downloadResponse(runtime, key);
  });
}
