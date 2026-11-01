import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ACP_FRAME_BYTES,
  ACP_FRAMES_PER_APPEND,
  utf8Bytes,
  type AcpFrameInput,
  type AcpOp,
} from "backend/src/acp/contract";
import { AcpRelay, type AcpRelayOptions } from "./relay";
import { AcpTimeline } from "./timeline";
import type { AcpTransport } from "./transport";

type AppendArgs = { chat: string; epoch: number; frames: AcpFrameInput[] };
const relays: AcpRelay[] = [];

function fixture(options: AcpRelayOptions = {}) {
  const timeline = new AcpTimeline();
  const calls: AppendArgs[] = [];
  const epochs: number[] = [];
  const byteCounts = new Map<number, number>();
  const transport = {
    startEpoch: vi.fn(async ({ epoch }: { chat: string; epoch: number }) => {
      epochs.push(epoch);
      byteCounts.set(epoch, 0);
      return { accepted: true };
    }),
    appendFrames: vi.fn(async (args: AppendArgs) => {
      calls.push(structuredClone(args));
      const bytes =
        (byteCounts.get(args.epoch) ?? 0) +
        args.frames.reduce((sum, frame) => sum + utf8Bytes(frame.payload), 0);
      byteCounts.set(args.epoch, bytes);
      return { accepted: true, bytes };
    }),
  } satisfies Pick<AcpTransport, "startEpoch" | "appendFrames">;
  const relay = new AcpRelay(transport, "chat", timeline, { random: () => 0.5, ...options });
  relays.push(relay);
  return { timeline, relay, transport, calls, epochs };
}

function operations(calls: AppendArgs[]): AcpOp[] {
  return calls.flatMap((call) =>
    call.frames.flatMap((frame) => JSON.parse(frame.payload) as AcpOp[]),
  );
}

afterEach(() => {
  for (const relay of relays) relay.stop();
  relays.length = 0;
  vi.useRealTimers();
});

describe("AcpRelay", () => {
  it("opens above remembered epochs and preserves snapshot/history/live sequence continuity", async () => {
    const { relay, timeline, calls, epochs } = fixture();
    timeline.update({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Before warm" },
    });
    await relay.start(7);
    relay.push(timeline.startTurn("turn"));
    relay.push(timeline.history(Infinity, 10), "history");
    relay.push(timeline.endTurn("end_turn"));
    await relay.flush();
    expect(epochs).toEqual([8]);
    expect(relay.active).toBe(true);
    const frames = calls.flatMap((call) => call.frames);
    expect(frames[0]?.kind).toBe("snapshot");
    expect(frames.some((frame) => frame.kind === "history")).toBe(true);
    expect(frames.some((frame) => frame.kind === "live")).toBe(true);
    let next = 0;
    for (const frame of frames) {
      expect(frame.seqFrom).toBe(next);
      const ops: AcpOp[] = JSON.parse(frame.payload);
      expect(frame.seqTo).toBe(next + ops.length - 1);
      next = frame.seqTo + 1;
    }
    relay.stop();
    await relay.start(2);
    expect(epochs).toEqual([8, 9]);
    expect(calls.at(-1)?.frames[0]?.seqFrom).toBe(0);
  });

  it("coalesces text until 300ms while structural ops flush pending text immediately", async () => {
    vi.useFakeTimers();
    const { relay, calls } = fixture();
    await relay.start(0);
    const initial = calls.length;
    relay.push([{ op: "text.append", id: "message", text: "Hello" }]);
    relay.push([{ op: "text.append", id: "message", text: " world" }]);
    await vi.advanceTimersByTimeAsync(299);
    expect(calls).toHaveLength(initial);
    await vi.advanceTimersByTimeAsync(1);
    await relay.flush();
    expect(operations(calls.slice(initial))).toEqual([
      { op: "text.append", id: "message", text: "Hello world" },
    ]);
    relay.push([{ op: "text.append", id: "message", text: "!" }]);
    relay.push([{ op: "turn.end", turnId: "turn", stopReason: "end_turn" }]);
    await relay.flush();
    expect(operations(calls).slice(-2)).toEqual([
      { op: "text.append", id: "message", text: "!" },
      { op: "turn.end", turnId: "turn", stopReason: "end_turn" },
    ]);
  });

  it("splits escaped multibyte text without loss and respects frame/append bounds", async () => {
    const { relay, calls } = fixture();
    await relay.start(0);
    const text = '😀\\"\n'.repeat(30_000);
    relay.push([{ op: "text.append", id: "message", text }]);
    await relay.flush();
    const appends = operations(calls).filter((op) => op.op === "text.append");
    expect(appends.map((op) => op.text).join("")).toBe(text);
    expect(appends.length).toBeGreaterThan(ACP_FRAMES_PER_APPEND);
    for (const call of calls) {
      expect(call.frames.length).toBeLessThanOrEqual(ACP_FRAMES_PER_APPEND);
      for (const frame of call.frames)
        expect(utf8Bytes(frame.payload)).toBeLessThanOrEqual(ACP_FRAME_BYTES);
    }
  });

  it("losslessly fragments oversized snapshot upserts and history fields", async () => {
    const { relay, timeline, calls } = fixture();
    const text = "😀".repeat(11_000);
    timeline.update({
      sessionUpdate: "tool_call",
      toolCallId: "read",
      title: "Read",
      content: [{ type: "content", content: { type: "text", text } }],
      rawOutput: { ok: true },
    });
    const original = timeline.snapshot().find((op) => op.op === "item.upsert");
    await relay.start(0);
    relay.push(timeline.history(Infinity, 1), "history");
    await relay.flush();
    const fragments = operations(calls).filter((op) => op.op === "fragment");
    expect(fragments.length).toBeGreaterThan(2);
    const ids = [...new Set(fragments.map((op) => op.id))];
    expect(ids).toHaveLength(2);
    for (const id of ids) {
      const parts = fragments.filter((op) => op.id === id);
      expect(parts.map((op) => op.index)).toEqual(parts.map((_, index) => index));
      expect(parts.every((op) => op.total === parts.length)).toBe(true);
      expect(JSON.parse(parts.map((op) => op.data).join(""))).toEqual(original);
    }
    for (const frame of calls.flatMap((call) => call.frames))
      expect(utf8Bytes(frame.payload)).toBeLessThanOrEqual(ACP_FRAME_BYTES);
  });

  it("retries an uncertain append with identical immutable frames before later ops", async () => {
    vi.useFakeTimers();
    const { relay, transport, calls } = fixture();
    await relay.start(0);
    const attempts: AppendArgs[] = [];
    const append = transport.appendFrames.getMockImplementation()!;
    transport.appendFrames.mockImplementationOnce(async (args) => {
      attempts.push(structuredClone(args));
      throw new Error("Disconnected after commit");
    });
    relay.push([{ op: "turn.start", turnId: "turn" }]);
    await vi.advanceTimersByTimeAsync(0);
    transport.appendFrames.mockImplementationOnce(async (args) => {
      attempts.push(structuredClone(args));
      return append(args);
    });
    relay.push([{ op: "text.append", id: "message", text: "later" }]);
    const flushing = relay.flush();
    await vi.advanceTimersByTimeAsync(500);
    await flushing;
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
    expect(operations(calls).slice(-2)).toEqual([
      { op: "turn.start", turnId: "turn" },
      { op: "text.append", id: "message", text: "later" },
    ]);
  });

  it.each(["ACP_FRAME_CONFLICT", "ACP_FRAME_GAP", "ACP_STALE_EPOCH"])(
    "repairs %s with a higher epoch and fresh snapshot",
    async (code) => {
      const { relay, timeline, transport, calls, epochs } = fixture();
      await relay.start(3);
      transport.appendFrames.mockRejectedValueOnce({ data: { code } });
      relay.push(
        timeline.update({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Retained" },
        }),
      );
      await relay.flush();
      expect(epochs).toEqual([4, 5]);
      const repaired = calls.filter((call) => call.epoch === 5);
      expect(repaired[0]?.frames[0]).toMatchObject({ seqFrom: 0, kind: "snapshot" });
      expect(operations(repaired)).toContainEqual({
        op: "item.upsert",
        item: expect.objectContaining({ text: "Retained" }),
      });
    },
  );

  it("restarts an epoch rejected as stale during warm-up", async () => {
    const { relay, transport, epochs } = fixture();
    transport.startEpoch.mockRejectedValueOnce({ data: { code: "ACP_STALE_EPOCH" } });
    await relay.start(5);
    expect(relay.epoch).toBe(7);
    expect(epochs).toEqual([7]);
  });

  it.each(["start", "append"])(
    "stops on cold %s rejection and resumes only after explicit warm start",
    async (where) => {
      const { relay, transport, calls } = fixture();
      if (where === "start") transport.startEpoch.mockResolvedValueOnce({ accepted: false });
      else transport.appendFrames.mockResolvedValueOnce({ accepted: false, bytes: 0 });
      await relay.start(0);
      expect(relay.active).toBe(false);
      relay.push([{ op: "turn.start", turnId: "ignored" }]);
      await relay.flush();
      expect(calls).toEqual([]);
      await relay.start(1);
      expect(relay.active).toBe(true);
      expect(calls[0]?.epoch).toBe(2);
    },
  );

  it("cancels a queued warm-up when stopped while the old append is still pending", async () => {
    const { relay, transport, epochs } = fixture();
    await relay.start(0);
    const gate = Promise.withResolvers<{ accepted: boolean; bytes: number }>();
    transport.appendFrames.mockImplementationOnce(() => gate.promise);
    relay.push([{ op: "turn.start", turnId: "old" }]);
    const warming = relay.start(1);
    relay.stop();
    gate.resolve({ accepted: true, bytes: 100 });
    await warming;
    expect(epochs).toEqual([1]);
    expect(relay.active).toBe(false);
  });

  it("never allows a late start acknowledgement to write after stop", async () => {
    const { relay, transport, calls } = fixture();
    const gate = Promise.withResolvers<{ accepted: boolean }>();
    transport.startEpoch.mockImplementationOnce(() => gate.promise);
    const starting = relay.start(0);
    relay.stop();
    gate.resolve({ accepted: true });
    await starting;
    expect(relay.active).toBe(false);
    expect(calls).toEqual([]);
  });

  it("keeps only one append in flight while later live updates queue", async () => {
    const { relay, transport, calls } = fixture();
    await relay.start(0);
    const gate = Promise.withResolvers<{ accepted: boolean; bytes: number }>();
    transport.appendFrames.mockImplementationOnce(() => gate.promise);
    relay.push([{ op: "turn.start", turnId: "one" }]);
    const first = transport.appendFrames.mock.calls.length;
    relay.push([{ op: "turn.start", turnId: "two" }]);
    expect(transport.appendFrames.mock.calls).toHaveLength(first);
    gate.resolve({ accepted: true, bytes: 100 });
    await relay.flush();
    expect(operations(calls).at(-1)).toEqual({ op: "turn.start", turnId: "two" });
  });

  it("replaces an over-budget outage backlog with the current timeline snapshot", async () => {
    vi.useFakeTimers();
    const { relay, timeline, transport, calls, epochs } = fixture({ outageBytes: 3000 });
    await relay.start(0);
    transport.appendFrames.mockRejectedValueOnce(new Error("Offline"));
    relay.push(timeline.startTurn("turn"));
    await vi.advanceTimersByTimeAsync(0);
    for (let index = 0; index < 4; index++)
      relay.push(
        timeline.update({
          sessionUpdate: "agent_message_chunk",
          messageId: String(index),
          content: { type: "text", text: String(index).repeat(2000) },
        }),
      );
    const flushing = relay.flush();
    await vi.advanceTimersByTimeAsync(500);
    await flushing;
    expect(epochs).toEqual([1, 2]);
    const repaired = calls.filter((call) => call.epoch === 2);
    expect(
      repaired.flatMap((call) => call.frames).every((frame) => frame.kind === "snapshot"),
    ).toBe(true);
    expect(operations(repaired).filter((op) => op.op === "item.upsert")).toHaveLength(4);
    expect(operations(repaired)).toContainEqual({ op: "turn.start", turnId: "turn" });
  });

  it("rolls over only at the turn boundary after the epoch byte budget", async () => {
    const { relay, timeline, epochs, calls } = fixture({ rolloverBytes: 1000 });
    await relay.start(0);
    relay.push(timeline.startTurn("previous"));
    relay.push(timeline.endTurn("end_turn"));
    await relay.flush();
    relay.push(timeline.startTurn("turn"));
    relay.push(
      timeline.update({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "x".repeat(2000) },
      }),
    );
    await relay.flush();
    expect(epochs).toEqual([1]);
    relay.push(timeline.endTurn("end_turn"));
    await relay.flush();
    expect(epochs).toEqual([1, 2]);
    expect(
      operations(calls.filter((call) => call.epoch === 2)).some((op) => op.op === "turn.start"),
    ).toBe(false);
    expect(calls.find((call) => call.epoch === 2)?.frames[0]).toMatchObject({
      seqFrom: 0,
      kind: "snapshot",
    });
  });

  it("close drains pending text and then rejects later live pushes", async () => {
    const { relay, calls } = fixture();
    await relay.start(0);
    relay.push([{ op: "text.append", id: "message", text: "last" }]);
    await relay.close();
    expect(relay.active).toBe(false);
    expect(operations(calls).at(-1)).toEqual({ op: "text.append", id: "message", text: "last" });
    const count = calls.length;
    relay.push([{ op: "text.append", id: "message", text: "ignored" }]);
    await relay.flush();
    expect(calls).toHaveLength(count);
  });
});
