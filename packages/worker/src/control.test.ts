import { afterEach, expect, test, vi } from "vitest";
import { connectWorkerControl } from "./control.js";
import type { WorkerMetadata } from "./protocol.js";
import type { WorkerState } from "./state.js";
import { api } from "backend/convex/_generated/api";

const mock = vi.hoisted(() => ({
  authChanged: undefined as ((authenticated: boolean) => void) | undefined,
  workerChanged: undefined as ((worker: WorkerMetadata | null) => void) | undefined,
  connectionChanged: undefined as ((state: { isWebSocketConnected: boolean }) => void) | undefined,
  queryFailed: undefined as (() => void) | undefined,
  construct: vi.fn(),
  setAuth: vi.fn(),
  subscribe: vi.fn(),
  close: vi.fn(),
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
      mock.authChanged = callback;
    }
    subscribeToConnectionState(callback: typeof mock.connectionChanged) {
      mock.connectionChanged = callback;
      return mock.unsubscribeConnection;
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

const identity = { workerId: "worker", keyId: "key", workspaceId: "workspace", identityEpoch: 1 };
const state = { setup: { convexUrl: "https://convex.example.invalid" }, identity } as WorkerState;
const worker: WorkerMetadata = { ...identity, name: "Test", capabilities: [], status: "active" };

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

test("control fails closed on revoked, foreign, stale and missing metadata and transport/query loss", async () => {
  const onStatus = vi.fn();
  const control = connectWorkerControl(state, onStatus);
  expect(mock.subscribe).toHaveBeenCalledWith(api.workers.current, {});
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
    expect(onStatus).toHaveBeenLastCalledWith({ status: "disconnected" });
  }
  mock.workerChanged?.(worker);
  mock.connectionChanged?.({ isWebSocketConnected: false });
  expect(onStatus).toHaveBeenLastCalledWith({ status: "disconnected" });
  mock.workerChanged?.(worker);
  mock.queryFailed?.();
  expect(onStatus).toHaveBeenLastCalledWith({ status: "disconnected" });
  await control.close();
});

test("failed token auth re-arms the same client with backoff and shutdown cancels retries", async () => {
  vi.useFakeTimers();
  const onStatus = vi.fn();
  const control = connectWorkerControl(state, onStatus);
  mock.authChanged?.(false);
  mock.authChanged?.(false);
  expect(onStatus).toHaveBeenLastCalledWith({ status: "disconnected" });
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
