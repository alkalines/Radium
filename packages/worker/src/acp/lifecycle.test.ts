import { afterEach, describe, expect, it, vi } from "vitest";
import { ConvexError } from "convex/values";
import { AcpLifecycle } from "./lifecycle.js";

const queues: AcpLifecycle[] = [];
afterEach(async () => {
  for (const queue of queues.splice(0)) await queue.close(0);
  vi.useRealTimers();
});

describe("durable ACP lifecycle delivery", () => {
  it("keeps failed effects in order while another chat progresses", async () => {
    vi.useFakeTimers();
    const queue = new AcpLifecycle();
    queues.push(queue);
    queue.setAvailable(true);
    const delivered: string[] = [];
    let online = false;
    const first = queue.run("chat-a", async () => {
      if (!online) throw new Error("offline");
      delivered.push("running");
    });
    const second = queue.run("chat-a", async () => {
      delivered.push("finished");
    });
    await queue.run("chat-b", async () => {
      delivered.push("other-chat");
    });
    expect(delivered).toEqual(["other-chat"]);
    online = true;
    await vi.advanceTimersByTimeAsync(1_000);
    await Promise.all([first, second]);
    expect(delivered).toEqual(["other-chat", "running", "finished"]);
  });
  it("does not deliver while control is unavailable and rejects permanent authorization errors", async () => {
    vi.useFakeTimers();
    const queue = new AcpLifecycle();
    queues.push(queue);
    const delivered: string[] = [];
    const work = queue.run("chat", async () => {
      delivered.push("receipt");
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(delivered).toEqual([]);
    queue.setAvailable(true);
    await vi.advanceTimersByTimeAsync(100);
    await work;
    expect(delivered).toEqual(["receipt"]);
    await expect(
      queue.run("chat", async () => {
        throw new ConvexError({ code: "ACP_DENIED" });
      }),
    ).rejects.toMatchObject({ data: { code: "ACP_DENIED" } });
    await queue.run("chat", async () => {
      delivered.push("later");
    });
    expect(delivered).toEqual(["receipt", "later"]);
  });

  it("bounds shutdown even when a mutation never acknowledges its result", async () => {
    vi.useFakeTimers();
    const queue = new AcpLifecycle();
    queues.push(queue);
    queue.setAvailable(true);
    const stalled = Promise.withResolvers<void>();
    const work = queue.run("chat", () => stalled.promise);
    const rejected = expect(work).rejects.toThrow("ACP host stopped");
    await vi.advanceTimersByTimeAsync(0);
    const closing = queue.close(100);
    await vi.advanceTimersByTimeAsync(100);
    await closing;
    await rejected;
  });
});
