import {
  HttpChatTransport,
  uiMessageChunkSchema,
  type HttpChatTransportInitOptions,
  type UIMessage,
  type UIMessageChunk,
} from "ai";

import { readStream } from "./stream-reader";

/**
 * The built-in chat transport (`docs/Backend_Migration/Live_Data.md`, Built-in Chat Runs). Requests
 * are prepared exactly as with AI SDK's HTTP transports (`prepareSendMessagesRequest`, body,
 * headers), but no response carries the reply itself:
 *
 * - `POST /api/chat` admits a run and answers `201 {streamUrl}`;
 * - a reconnect asks `GET /api/chat/<chat>/stream`: `200 {streamUrl}` for the chat's active run,
 *   `204` (nothing to resume) otherwise.
 *
 * Either way the run's stream is read from its start over SSE through the `/api/streams` proxy,
 * resuming after network errors, until the backend closes it. Every Tab and device reads the
 * same stream, so a reconnect replays the reply ({@link resumeStreamIsReplay}). Cancelling the
 * returned stream (`useChat().stop()`, unmount) only stops reading: the run is detached, and only
 * `chats.stop` ends it. So that a Stop pressed while `POST /api/chat` is pending can still end the
 * run it may start, that request is never aborted, and `onRunStream` reports every answer that
 * names a run. A refused request throws with the backend's message.
 */
export class ChatRunTransport<UI_MESSAGE extends UIMessage> extends HttpChatTransport<UI_MESSAGE> {
  readonly resumeStreamIsReplay = true;

  constructor({
    onRunStream,
    ...options
  }: Omit<HttpChatTransportInitOptions<UI_MESSAGE>, "fetch"> & {
    /** A request named a run to read: one it started (`send`) or the chat's active one (`resume`). */
    onRunStream?: (source: "send" | "resume") => void;
  }) {
    const runFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const isSend = init?.method === "POST";
      const response = await chatFetch(input, isSend ? { ...init, signal: undefined } : init);
      if (response.status !== 204) onRunStream?.(isSend ? "send" : "resume");
      return response;
    };
    super({ ...options, fetch: runFetch as typeof fetch });
  }

  protected processResponseStream(
    body: ReadableStream<Uint8Array>,
  ): ReadableStream<UIMessageChunk> {
    const abort = new AbortController();
    const schema = uiMessageChunkSchema();
    return new ReadableStream<UIMessageChunk>({
      start(controller) {
        void (async () => {
          const location: unknown = await new Response(body).json();
          const streamUrl =
            typeof location === "object" && location !== null && "streamUrl" in location
              ? location.streamUrl
              : undefined;
          // Only the authorizing proxy on this origin serves run streams.
          if (typeof streamUrl !== "string" || !streamUrl.startsWith("/api/streams/c/")) {
            throw new Error("The chat response did not name its reply stream.");
          }
          const end = await readStream<unknown>({
            url: streamUrl,
            offset: "-1",
            signal: abort.signal,
            onMessages: async (messages) => {
              for (const message of messages) {
                const chunk = schema.validate ? await schema.validate(message) : undefined;
                if (!chunk?.success) {
                  // Reading again would deliver the same bytes: end the reply instead.
                  controller.error(new Error("The reply stream sent an invalid chunk."));
                  abort.abort();
                  return;
                }
                controller.enqueue(chunk.value);
              }
            },
          });
          if (end === "closed") controller.close();
          else if (end === "gone") throw new Error("The reply is no longer available.");
        })().catch((error: unknown) => {
          if (!abort.signal.aborted) controller.error(error);
        });
      },
      cancel() {
        abort.abort();
      },
    });
  }
}

/**
 * `fetch` for `/api/chat` on the web origin (cookie session). A refusal carries the server's
 * message (`409`: another run is active, or the chat's key must be rotated first); it becomes the
 * thrown error.
 */
async function chatFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const response = await fetch(input, init);
  if (response.ok) return response;
  const body = (await response.json().catch(() => null)) as {
    error?: { message?: unknown };
  } | null;
  const message = body?.error?.message;
  throw new Error(
    typeof message === "string" ? message : `The chat request failed (${response.status}).`,
  );
}
