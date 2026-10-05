import { ConvexClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { createMachineTokenFetcher, type AuthOptions } from "./auth.js";
import type { WorkerMetadata } from "./protocol.js";
import { WorkerProtocolError } from "./protocol.js";
import type { WorkerState } from "./state.js";

export type WorkerControlStatus =
  | { status: "connected"; worker: WorkerMetadata }
  | { status: "disconnected" };

const currentWorker = makeFunctionReference<"query", Record<string, never>, WorkerMetadata | null>(
  "workers:current",
);

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
): { client: ConvexClient; close: () => Promise<void> } {
  if (!state.identity) throw new WorkerProtocolError("Worker identity is not enrolled");

  const client = new ConvexClient(state.setup.convexUrl);
  const fetchToken = createMachineTokenFetcher(state, options);
  let closed = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let retryDelay = 5_000;
  const disconnected = () => {
    if (!closed) onStatus({ status: "disconnected" });
  };

  const authChanged = (isAuthenticated: boolean) => {
    if (closed) return;
    if (isAuthenticated) {
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = undefined;
      retryDelay = 5_000;
      return;
    }
    disconnected();
    // A null token stops Convex's own refresh cycle. Re-arm auth after a bounded,
    // jittered delay so an HTTP outage does not permanently strand this process.
    if (retryTimer) return;
    const delay = retryDelay * (0.75 + Math.random() * 0.25);
    retryDelay = Math.min(retryDelay * 2, 60_000);
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      if (!closed) client.setAuth(fetchToken, authChanged);
    }, delay);
  };
  client.setAuth(fetchToken, authChanged);

  const unsubscribeConnection = client.subscribeToConnectionState(({ isWebSocketConnected }) => {
    if (!isWebSocketConnected) disconnected();
  });
  const unsubscribeWorker = client.onUpdate(
    currentWorker,
    {},
    (worker) => {
      if (
        worker === null ||
        worker.status !== "active" ||
        worker.workerId !== state.identity!.workerId ||
        worker.workspaceId !== state.identity!.workspaceId ||
        worker.identityEpoch !== state.identity!.identityEpoch
      )
        disconnected();
      else if (!closed) onStatus({ status: "connected", worker });
    },
    disconnected,
  );

  return {
    client,
    close: async () => {
      if (closed) return;
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      unsubscribeWorker();
      unsubscribeConnection();
      onStatus({ status: "disconnected" });
      await client.close();
    },
  };
}
