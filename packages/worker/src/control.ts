import { ConvexClient } from "convex/browser";
import { api } from "backend/convex/_generated/api";
import { createMachineTokenFetcher } from "./auth/token.js";
import type { AuthOptions } from "./auth/proof.js";
import type { WorkerState } from "./auth/state.js";
import { WorkerProtocolError, type WorkerMetadata } from "./protocol.js";

/** Identity availability, with metadata derived from the generated backend contract. */
export type WorkerControlDisconnectReason =
  | "connecting"
  | "token_http_failed"
  | "verifier_auth_rejected"
  | "identity_unavailable"
  | "transport"
  | "shutdown";

export type WorkerControlStatus =
  | { status: "connected"; worker: WorkerMetadata }
  | { status: "disconnected"; reason: WorkerControlDisconnectReason };

/** One outbound connection and its idempotent lifecycle cleanup. */
export interface WorkerControlConnection {
  client: ConvexClient;
  diagnostics: () => {
    socketConnected: boolean;
    authenticated: boolean;
    identityAvailable: boolean;
    tokenExchangePending: boolean;
    connectionRetries: number;
  };
  close: () => Promise<void>;
}

const INITIAL_AUTH_RETRY_MS = 5_000;
const MAX_AUTH_RETRY_MS = 60_000;

/**
 * Start one Convex client for the saved machine identity.
 * setAuth obtains backend-signed access tokens using the Worker's saved key;
 * workers.current separately verifies that this identity is still authorized.
 * A connected socket or a valid JWT alone does not establish active authority.
 * Null/stale/revoked metadata, query errors and transport loss report disconnected.
 * This module reports identity/control availability; it does not execute jobs.
 */
export function connectWorkerControl(
  state: WorkerState,
  onStatus: (status: WorkerControlStatus) => void,
  options: AuthOptions = {},
): WorkerControlConnection {
  const identity = state.identity;
  if (!identity) throw new WorkerProtocolError("Worker identity is not enrolled");

  const client = new ConvexClient(state.setup.convexUrl);
  const fetchMachineToken = createMachineTokenFetcher(state, options);
  let closed = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let retryDelay = INITIAL_AUTH_RETRY_MS;
  let lastWorker: WorkerMetadata | undefined;
  let authenticated = false;
  let socketConnected = false;
  let hasConnectedSocket = false;
  let tokenExchangePending = false;
  // Convex's auth callback is boolean-only, so retain the latest fetch result to
  // distinguish a failed issuer exchange from a token rejected by the verifier.
  let tokenFetchFailed = false;

  const fetchToken = async (args: { forceRefreshToken: boolean }) => {
    tokenExchangePending = true;
    try {
      const token = await fetchMachineToken(args);
      tokenFetchFailed = token === null;
      return token;
    } finally {
      tokenExchangePending = false;
    }
  };

  const reportRestored = () => {
    if (!closed && authenticated && socketConnected && lastWorker) {
      onStatus({ status: "connected", worker: lastWorker });
    }
  };

  const disconnected = (reason: WorkerControlDisconnectReason) => {
    if (!closed) onStatus({ status: "disconnected", reason });
  };

  const authChanged = (isAuthenticated: boolean) => {
    if (closed) return;
    authenticated = isAuthenticated;
    if (isAuthenticated) {
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = undefined;
      retryDelay = INITIAL_AUTH_RETRY_MS;
      reportRestored();
      return;
    }
    disconnected(tokenFetchFailed ? "token_http_failed" : "verifier_auth_rejected");
    // A null token stops Convex's own refresh cycle. Re-arm auth after a bounded,
    // jittered delay so an HTTP outage does not permanently strand this process.
    if (retryTimer) return;
    const delay = retryDelay * (0.75 + Math.random() * 0.25);
    retryDelay = Math.min(retryDelay * 2, MAX_AUTH_RETRY_MS);
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      if (!closed) client.setAuth(fetchToken, authChanged);
    }, delay);
  };
  client.setAuth(fetchToken, authChanged);

  const unsubscribeConnection = client.subscribeToConnectionState(
    ({ isWebSocketConnected, connectionRetries }) => {
      socketConnected = isWebSocketConnected;
      if (!isWebSocketConnected) {
        disconnected(
          !hasConnectedSocket && (connectionRetries ?? 0) === 0 ? "connecting" : "transport",
        );
      } else {
        hasConnectedSocket = true;
        reportRestored();
      }
    },
  );
  const unsubscribeWorker = client.onUpdate(
    api.workers.current,
    {},
    (worker) => {
      if (
        worker === null ||
        worker.status !== "active" ||
        worker.workerId !== identity.workerId ||
        worker.workspaceId !== identity.workspaceId ||
        worker.identityEpoch !== identity.identityEpoch
      ) {
        lastWorker = undefined;
        disconnected("identity_unavailable");
      } else if (!closed) {
        lastWorker = worker;
        reportRestored();
      }
    },
    () => {
      lastWorker = undefined;
      disconnected("identity_unavailable");
    },
  );

  return {
    client,
    diagnostics: () => {
      const connection = client.connectionState();
      return {
        socketConnected: connection.isWebSocketConnected,
        authenticated,
        identityAvailable: Boolean(lastWorker),
        tokenExchangePending,
        connectionRetries: connection.connectionRetries,
      };
    },
    close: async () => {
      if (closed) return;
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      unsubscribeWorker();
      unsubscribeConnection();
      onStatus({ status: "disconnected", reason: "shutdown" });
      await client.close();
    },
  };
}
