import type { IncomingMessage } from "node:http";

import type { AnyRouter, inferRouterContext, TRPCError } from "@trpc/server";
import { getWSConnectionHandler, type WSClient, type WSServer } from "@trpc/server/adapters/ws";
import type { Hooks, Message, Peer } from "crossws";

const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

type MessageListener = (data: Buffer, isBinary: boolean) => void;
type CloseOrErrorListener = (cause?: unknown) => void;

/**
 * The members of a `ws` WebSocket that tRPC's connection handler uses (`WSClient`), backed by a
 * crossws peer. crossws owns the socket (Nitro serves it on every runtime); the bridge hook below
 * forwards its message/close/error events here.
 */
class PeerSocket implements WSClient {
  readyState = OPEN;
  readonly #peer: Peer;
  readonly #messageListeners = new Set<MessageListener>();
  readonly #closeListeners = new Set<CloseOrErrorListener>();
  readonly #errorListeners = new Set<CloseOrErrorListener>();

  constructor(peer: Peer) {
    this.#peer = peer;
  }

  on(event: "message", listener: MessageListener): this;
  on(event: "close" | "error", listener: CloseOrErrorListener): this;
  on(event: "message" | "close" | "error", listener: MessageListener | CloseOrErrorListener): this {
    if (event === "message") this.#messageListeners.add(listener as MessageListener);
    else if (event === "close") this.#closeListeners.add(listener as CloseOrErrorListener);
    else this.#errorListeners.add(listener as CloseOrErrorListener);
    return this;
  }

  once(event: "close", listener: () => void): this {
    const wrapped = () => {
      this.#closeListeners.delete(wrapped);
      listener();
    };
    this.#closeListeners.add(wrapped);
    return this;
  }

  send(data: string | Uint8Array) {
    this.#peer.send(data);
  }

  close(code?: number, reason?: string) {
    if (this.readyState !== OPEN) return;
    this.readyState = CLOSING;
    this.#peer.close(code, reason);
  }

  terminate() {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSING;
    this.#peer.terminate();
  }

  receive(message: Message) {
    // tRPC requires a Buffer and decodes it as UTF-8 JSON. Bun delivers text frames as strings,
    // Node's `ws` as Buffers.
    const raw = message.rawData;
    let data: Buffer;
    if (Buffer.isBuffer(raw)) {
      data = raw;
    } else if (typeof raw === "string") {
      data = Buffer.from(raw, "utf8");
    } else {
      const bytes = message.uint8Array();
      data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    }

    for (const listener of this.#messageListeners) listener(data, false);
  }

  fail(error: unknown) {
    for (const listener of this.#errorListeners) listener(error);
  }

  closed() {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    for (const listener of [...this.#closeListeners]) listener();
  }
}

/**
 * The connected sockets. Satisfies tRPC's `WSServer` so its server utilities (for example
 * `broadcastReconnectNotification` before a deploy) work; connections are handed to tRPC directly
 * by the `open` hook, so no `connection` event is ever emitted.
 */
class PeerSocketServer implements WSServer<PeerSocket> {
  readonly clients = new Set<PeerSocket>();

  on() {
    return this;
  }
}

export interface TRPCWebSocketOptions<TRouter extends AnyRouter> {
  router: TRouter;
  /** Builds the context once per socket, after the client's `connectionParams` (if any) arrived. */
  createContext(source: {
    request: Request;
    connectionParams: Record<string, string | undefined> | null;
  }): inferRouterContext<TRouter> | Promise<inferRouterContext<TRouter>>;
  onError?(info: { error: TRPCError; path?: string }): void;
}

/**
 * crossws hooks serving a tRPC router: every subscription, query and mutation of one client is
 * multiplexed on its single socket, as `wsLink` expects.
 */
export function createTRPCWebSocketHooks<TRouter extends AnyRouter>(
  options: TRPCWebSocketOptions<TRouter>,
) {
  const server = new PeerSocketServer();
  const sockets = new Map<string, PeerSocket>();

  const hooks: Partial<Hooks> = {
    upgrade(request) {
      // Browsers attach cookies to cross-site WebSocket upgrades and CORS does not apply, so a
      // foreign page could otherwise open an authenticated socket. Non-browser clients (Worker,
      // CLIs) send no Origin.
      if (!isSameOrigin(request))
        return new Response("Cross-origin WebSocket rejected", { status: 403 });
    },

    open(peer) {
      const socket = new PeerSocket(peer);
      sockets.set(peer.id, socket);
      server.clients.add(socket);

      const handleConnection = getWSConnectionHandler<TRouter, PeerSocketServer>({
        wss: server,
        router: options.router,
        createContext: ({ info }) =>
          options.createContext({ request: peer.request, connectionParams: info.connectionParams }),
        onError: options.onError,
        // Server pings find half-open sockets (sleeping laptops, dropped NAT entries) so their
        // subscriptions are released instead of leaking until the TCP timeout.
        keepAlive: { enabled: true, pingMs: 30_000, pongWaitMs: 5_000 },
      });
      handleConnection(socket, toIncomingMessage(peer.request));
    },

    message(peer, message) {
      sockets.get(peer.id)?.receive(message);
    },

    error(peer, error) {
      sockets.get(peer.id)?.fail(error);
    },

    close(peer) {
      const socket = sockets.get(peer.id);
      if (!socket) return;
      sockets.delete(peer.id);
      server.clients.delete(socket);
      socket.closed();
    },
  };

  return { hooks, server };
}

function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;

  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/**
 * tRPC reads the upgrade request as a Node `IncomingMessage`, but only its `url` (for the
 * `connectionParams=1` flag) and `headers`. Context comes from the Fetch `Request` instead.
 */
function toIncomingMessage(request: Request): IncomingMessage {
  const url = new URL(request.url);
  const shape = {
    url: url.pathname + url.search,
    headers: Object.fromEntries(request.headers),
    socket: {},
  };
  return shape as unknown as IncomingMessage;
}
