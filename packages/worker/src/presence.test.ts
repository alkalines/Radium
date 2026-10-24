import { afterEach, expect, test, vi } from "vitest";
import type { ConvexClient } from "convex/browser";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORKER_HEARTBEAT_INTERVAL_MS } from "backend/src/worker/presence";
import { prepareTempDirectory, startPresenceReporter } from "./presence.js";

afterEach(() => {
  vi.useRealTimers();
});

function fixture() {
  const mutation = vi.fn(async (_fn: unknown, _args: { tempDirectory: string }) => null);
  const client = { mutation } as unknown as ConvexClient;
  return { mutation, reporter: startPresenceReporter(client, "/tmp/radium") };
}

test("presence reports on connect, heartbeats while connected, and stops when disconnected", async () => {
  vi.useFakeTimers();
  const f = fixture();

  f.reporter.setAvailable(false);
  expect(f.mutation).not.toHaveBeenCalled();

  f.reporter.setAvailable(true);
  f.reporter.setAvailable(true);
  expect(f.mutation).toHaveBeenCalledTimes(1);
  expect(f.mutation.mock.calls[0]![1]).toEqual({ tempDirectory: "/tmp/radium" });

  await vi.advanceTimersByTimeAsync(WORKER_HEARTBEAT_INTERVAL_MS * 2);
  expect(f.mutation).toHaveBeenCalledTimes(3);

  f.reporter.setAvailable(false);
  await vi.advanceTimersByTimeAsync(WORKER_HEARTBEAT_INTERVAL_MS * 2);
  expect(f.mutation).toHaveBeenCalledTimes(3);

  f.reporter.setAvailable(true);
  expect(f.mutation).toHaveBeenCalledTimes(4);
  f.reporter.close();
  f.reporter.setAvailable(true);
  await vi.advanceTimersByTimeAsync(WORKER_HEARTBEAT_INTERVAL_MS * 2);
  expect(f.mutation).toHaveBeenCalledTimes(4);
});

test("a failed report is non-fatal and the next heartbeat retries", async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.mutation.mockRejectedValueOnce(new Error("offline"));

  f.reporter.setAvailable(true);
  await vi.advanceTimersByTimeAsync(WORKER_HEARTBEAT_INTERVAL_MS);
  expect(f.mutation).toHaveBeenCalledTimes(2);
  f.reporter.close();
});

test("the temp directory is a radium folder under the OS temp directory, created if missing", async () => {
  const base = await mkdtemp(join(tmpdir(), "radium-worker-presence-test-"));
  try {
    const directory = await prepareTempDirectory(base);
    expect(directory).toBe(join(base, "radium"));
    expect((await stat(directory)).isDirectory()).toBe(true);
    await expect(prepareTempDirectory(base)).resolves.toBe(directory);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
