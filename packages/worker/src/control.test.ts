import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { connectWorkerControl } from "./control.js";
import type { WorkerMetadata } from "./protocol.js";
import type { WorkerState } from "./state.js";
import { api } from "backend/convex/_generated/api";

const mock = vi.hoisted(() => ({
  authChanged: undefined as ((authenticated: boolean) => void) | undefined,
  workerChanged: undefined as ((worker: WorkerMetadata | null) => void) | undefined,
  connectionChanged: undefined as
    | ((state: { isWebSocketConnected: boolean; connectionRetries?: number }) => void)
    | undefined,
  queryFailed: undefined as (() => void) | undefined,
  fetcher: undefined as
    | ((args: { forceRefreshToken: boolean }) => Promise<string | null>)
    | undefined,
  fetchToken: vi.fn(),
  construct: vi.fn(),
  setAuth: vi.fn(),
  subscribe: vi.fn(),
  close: vi.fn(),
  connectionState: vi.fn(() => ({ isWebSocketConnected: false, connectionRetries: 0 })),
  unsubscribeWorker: vi.fn(),
  unsubscribeConnection: vi.fn(),
}));

vi.mock("convex/browser", () => ({
  ConvexClient: class {
    constructor() {
      mock.construct();
    }
    setAuth(_fetch: unknown, callback: typeof mock.authChanged) {
      mock.setAuth();
      mock.fetcher = _fetch as typeof mock.fetcher;
      mock.authChanged = callback;
    }
    subscribeToConnectionState(callback: typeof mock.connectionChanged) {
      mock.connectionChanged = callback;
      return mock.unsubscribeConnection;
    }
    connectionState() {
      return mock.connectionState();
    }
    onUpdate(
      query: unknown,
      _args: unknown,
      callback: typeof mock.workerChanged,
      onError: typeof mock.queryFailed,
    ) {
      mock.subscribe(query, _args);
      mock.workerChanged = callback;
      mock.queryFailed = onError;
      return mock.unsubscribeWorker;
    }
    async close() {
      mock.close();
    }
  },
}));

vi.mock("./auth/token.js", () => ({
  createMachineTokenFetcher: () => mock.fetchToken,
}));

const identity = { workerId: "worker", keyId: "key", workspaceId: "workspace", identityEpoch: 1 };
const state = { setup: { convexUrl: "https://convex.example.invalid" }, identity } as WorkerState;
const worker: WorkerMetadata = { ...identity, name: "Test", capabilities: [], status: "active" };

beforeEach(() => {
  mock.fetchToken.mockReset();
  mock.fetchToken.mockResolvedValue("machine-token");
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  mock.fetcher = undefined;
});

test("control fails closed on revoked, foreign, stale and missing metadata and transport/query loss", async () => {
  const onStatus = vi.fn();
  const control = connectWorkerControl(state, onStatus);
  expect(mock.subscribe).toHaveBeenCalledWith(api.workers.current, {});
  mock.authChanged?.(true);
  mock.connectionChanged?.({ isWebSocketConnected: true });
  mock.workerChanged?.(worker);
  expect(onStatus).toHaveBeenLastCalledWith({ status: "connected", worker });
  for (const invalid of [
    null,
    { ...worker, status: "revoked" as const },
    { ...worker, workerId: "other" },
    { ...worker, workspaceId: "other" },
    { ...worker, identityEpoch: 2 },
  ]) {
    mock.workerChanged?.(invalid);
    expect(onStatus).toHaveBeenLastCalledWith({
      status: "disconnected",
      reason: "identity_unavailable",
    });
  }
  mock.workerChanged?.(worker);
  mock.connectionChanged?.({ isWebSocketConnected: false });
  expect(onStatus).toHaveBeenLastCalledWith({ status: "disconnected", reason: "transport" });
  mock.workerChanged?.(worker);
  mock.queryFailed?.();
  expect(onStatus).toHaveBeenLastCalledWith({
    status: "disconnected",
    reason: "identity_unavailable",
  });
  await control.close();
});

test("active metadata cannot report connected before auth and the socket are ready", async () => {
  const onStatus = vi.fn();
  const control = connectWorkerControl(state, onStatus);
  mock.workerChanged?.(worker);
  expect(onStatus).not.toHaveBeenCalledWith({ status: "connected", worker });

  mock.authChanged?.(true);
  expect(onStatus).not.toHaveBeenCalledWith({ status: "connected", worker });

  mock.connectionChanged?.({ isWebSocketConnected: true });
  expect(onStatus).toHaveBeenLastCalledWith({ status: "connected", worker });
  await control.close();
});

test("initial connection attempts are distinguished from failed handshakes", async () => {
  const onStatus = vi.fn();
  const control = connectWorkerControl(state, onStatus);
  mock.connectionChanged?.({ isWebSocketConnected: false, connectionRetries: 0 });
  expect(onStatus).toHaveBeenLastCalledWith({ status: "disconnected", reason: "connecting" });
  mock.connectionChanged?.({ isWebSocketConnected: false, connectionRetries: 1 });
  expect(onStatus).toHaveBeenLastCalledWith({ status: "disconnected", reason: "transport" });
  expect(control.diagnostics()).toEqual({
    socketConnected: false,
    authenticated: false,
    identityAvailable: false,
    tokenExchangePending: false,
    connectionRetries: 0,
  });
  await control.close();
});

test("failed token auth re-arms the same client with backoff and shutdown cancels retries", async () => {
  vi.useFakeTimers();
  const onStatus = vi.fn();
  const control = connectWorkerControl(state, onStatus);
  mock.fetchToken.mockResolvedValue(null);
  await mock.fetcher?.({ forceRefreshToken: true });
  mock.authChanged?.(false);
  mock.authChanged?.(false);
  expect(onStatus).toHaveBeenLastCalledWith({
    status: "disconnected",
    reason: "token_http_failed",
  });
  await vi.advanceTimersByTimeAsync(5_000);
  expect(mock.setAuth).toHaveBeenCalledTimes(2);
  expect(mock.construct).toHaveBeenCalledTimes(1);
  mock.authChanged?.(false);
  await control.close();
  await control.close();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(mock.setAuth).toHaveBeenCalledTimes(2);
  expect(mock.close).toHaveBeenCalledTimes(1);
  expect(mock.unsubscribeWorker).toHaveBeenCalledTimes(1);
  expect(mock.unsubscribeConnection).toHaveBeenCalledTimes(1);
});

test("a successfully issued token rejected by Convex reports verifier auth rejection", async () => {
  const onStatus = vi.fn();
  const control = connectWorkerControl(state, onStatus);
  await mock.fetcher?.({ forceRefreshToken: true });
  mock.authChanged?.(false);
  expect(onStatus).toHaveBeenLastCalledWith({
    status: "disconnected",
    reason: "verifier_auth_rejected",
  });
  await control.close();
});

test("transport restoration resumes cached control availability while denied metadata stays disconnected", async () => {
  const onStatus = vi.fn();
  const control = connectWorkerControl(state, onStatus);
  mock.authChanged?.(true);
  mock.connectionChanged?.({ isWebSocketConnected: true });
  mock.workerChanged?.(worker);
  mock.connectionChanged?.({ isWebSocketConnected: false });
  expect(onStatus).toHaveBeenLastCalledWith({ status: "disconnected", reason: "transport" });
  mock.connectionChanged?.({ isWebSocketConnected: true });
  expect(onStatus).toHaveBeenLastCalledWith({ status: "connected", worker });
  mock.workerChanged?.(null);
  mock.connectionChanged?.({ isWebSocketConnected: true });
  expect(onStatus).toHaveBeenLastCalledWith({
    status: "disconnected",
    reason: "identity_unavailable",
  });
  await control.close();
});
