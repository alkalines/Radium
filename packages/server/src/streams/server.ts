import { DurableStream, IdempotentProducer } from "@durable-streams/client";

/**
 * The backend's connection to the internal Durable Streams server
 * (`docs/Backend_Migration/Live_Data.md`). Only the backend holds `STREAMS_TOKEN`; browsers and
 * Workers reach streams through `/api/streams/*` (`./http.ts`), which authorizes every request.
 *
 * Streams are JSON mode: every append is one or more messages, reads return message arrays.
 * Expiry hides a stream but leaves its bytes on disk (task 14, Phase 0), so every stream the
 * backend creates is deleted explicitly; TTLs are only a backstop for streams it loses track of.
 */

/**
 * A stream path: `<kind>/<id>/<name>/<id>`, for example `c/<chat>/runs/<run>`. Ids are imported
 * Convex ids or UUIDv7 strings; the pattern keeps paths from escaping the stream prefix.
 */
const STREAM_PATH = /^[a-z]\/[A-Za-z0-9_-]{1,128}\/[a-z]+\/[A-Za-z0-9_-]{1,128}$/;

/** Whether `path` is a well-formed stream path (see {@link STREAM_PATH}). */
export function isStreamPath(path: string): boolean {
  return STREAM_PATH.test(path);
}

/** A stream server answer the caller did not expect; carries the status only, never a body. */
export class StreamServerError extends Error {
  constructor(
    readonly status: number,
    operation: string,
  ) {
    super(`Stream ${operation} failed with status ${status}`);
    this.name = "StreamServerError";
  }
}

const JSON_TYPE = "application/json";
/** Longest a create, append, delete or head may take; a live read is bounded by its caller. */
const REQUEST_TIMEOUT_MS = 10_000;

/** One read of a stream: its messages, where the next read starts, and whether it ended there. */
export type StreamPage = { messages: unknown[]; nextOffset: string; closed: boolean };

export class StreamServer {
  readonly #baseUrl: string;
  readonly #authorization: string;

  /** @param baseUrl the stream prefix (`STREAMS_URL`), paths are appended after a slash. */
  constructor(baseUrl: string, token: string) {
    this.#baseUrl = baseUrl;
    this.#authorization = `Bearer ${token}`;
  }

  /** The internal URL of `path`; throws on a malformed path. */
  url(path: string): string {
    if (!isStreamPath(path)) throw new Error("Invalid stream path");
    return `${this.#baseUrl}/${path}`;
  }

  /**
   * A management request (create, append, delete, head). Bounded by {@link REQUEST_TIMEOUT_MS}, so
   * a stalled stream server fails callers instead of holding them; reads have their own signals.
   */
  #request(path: string, method: string, init: { headers?: Record<string, string>; body?: string } = {}) {
    return fetch(this.url(path), {
      method,
      headers: { Authorization: this.#authorization, ...init.headers },
      body: init.body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  }

  /**
   * Creates a JSON stream, or confirms it exists with the same settings (idempotent `PUT`).
   * `ttlSeconds` is a sliding expiry; it can only be set here.
   *
   * @returns `false` when a stream with other settings (or a closed one) already holds the path.
   */
  async create(path: string, options: { ttlSeconds?: number } = {}): Promise<boolean> {
    const headers: Record<string, string> = { "Content-Type": JSON_TYPE };
    if (options.ttlSeconds !== undefined) headers["Stream-TTL"] = String(options.ttlSeconds);
    const response = await this.#request(path, "PUT", { headers });
    await response.body?.cancel();
    if (response.status === 201 || response.status === 200) return true;
    if (response.status === 409) return false;
    throw new StreamServerError(response.status, "create");
  }

  /**
   * Appends `messages` (at least one) in one request; with `close`, closes the stream atomically
   * after them. Without producer headers a retry may duplicate, so callers use this only for
   * messages whose repetition is harmless (invalidation events, doorbells).
   *
   * @returns `false` when the stream does not exist or is already closed.
   */
  async append(path: string, messages: readonly unknown[], options: { close?: boolean } = {}) {
    if (messages.length === 0) throw new Error("Nothing to append");
    const headers: Record<string, string> = { "Content-Type": JSON_TYPE };
    if (options.close) headers["Stream-Closed"] = "true";
    // JSON mode flattens one array level, so each element is one message.
    const response = await this.#request(path, "POST", { headers, body: JSON.stringify(messages) });
    await response.body?.cancel();
    if (response.ok) return true;
    if (response.status === 404 || response.status === 409 || response.status === 410) return false;
    throw new StreamServerError(response.status, "append");
  }

  /** Deletes `path` and its data; a missing stream is not an error. */
  async delete(path: string): Promise<void> {
    const response = await this.#request(path, "DELETE");
    await response.body?.cancel();
    if (response.ok || response.status === 404 || response.status === 410) return;
    throw new StreamServerError(response.status, "delete");
  }

  /** The tail offset of `path` (where the next append lands), or `null` when it does not exist. */
  async tail(path: string): Promise<string | null> {
    const response = await this.#request(path, "HEAD");
    if (response.status === 404 || response.status === 410) return null;
    if (!response.ok) throw new StreamServerError(response.status, "head");
    return response.headers.get("Stream-Next-Offset");
  }

  /**
   * One read of `path` from `offset`: catch-up, or a long-poll that waits for data with
   * `live: "long-poll"`. `closed` means no message will ever follow `nextOffset`.
   *
   * @returns `null` when the stream does not exist.
   */
  async read(
    path: string,
    offset: string,
    options: { live?: "long-poll"; signal?: AbortSignal } = {},
  ): Promise<{ messages: unknown[]; nextOffset: string; closed: boolean } | null> {
    const query = new URLSearchParams({ offset });
    if (options.live) query.set("live", options.live);
    const response = await fetch(`${this.url(path)}?${query}`, {
      headers: { Authorization: this.#authorization },
      signal: options.signal,
    });
    if (response.status === 404 || response.status === 410) {
      await response.body?.cancel();
      return null;
    }
    if (response.status !== 200 && response.status !== 204) {
      await response.body?.cancel();
      throw new StreamServerError(response.status, "read");
    }
    const text = response.status === 204 ? "" : await response.text();
    const messages = text ? (JSON.parse(text) as unknown[]) : [];
    return {
      messages,
      nextOffset: response.headers.get("Stream-Next-Offset") ?? offset,
      closed: response.headers.get("Stream-Closed")?.toLowerCase() === "true",
    };
  }

  /**
   * Forwards a reader's request (`/api/streams/*`, already authorized) to `path`. Only protocol
   * parameters pass; the caller pipes the response back.
   */
  forward(
    path: string,
    request: { method: "GET" | "POST"; query: URLSearchParams; headers?: Record<string, string>; body?: ReadableStream<Uint8Array> | null; signal: AbortSignal },
  ): Promise<Response> {
    const query = request.query.size > 0 ? `?${request.query}` : "";
    return fetch(`${this.url(path)}${query}`, {
      method: request.method,
      headers: { Authorization: this.#authorization, ...request.headers },
      body: request.body ?? undefined,
      signal: request.signal,
      // Required by fetch for a streamed request body.
      ...(request.body ? { duplex: "half" } : {}),
    } as RequestInit);
  }

  /**
   * An idempotent producer writing JSON messages to `path`: batched (`lingerMs`), retried
   * without duplicates. `producerId` names the writer for the server's deduplication, so it must
   * be stable for one writer and distinct between writers of the same stream.
   */
  producer(path: string, producerId: string, options: { lingerMs: number; onError(error: Error): void }) {
    const stream = new DurableStream({
      url: this.url(path),
      headers: { Authorization: this.#authorization },
      contentType: JSON_TYPE,
      warnOnHttp: false,
    });
    return new IdempotentProducer(stream, producerId, {
      lingerMs: options.lingerMs,
      onError: options.onError,
    });
  }
}
