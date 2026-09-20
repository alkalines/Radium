import assert from "node:assert/strict";
import { test } from "bun:test";
import { preferChatroomTraces, summarizeTraces } from "./summary";

test("prefers chatroom traces without changing request order or first same-source match", () => {
  const gateway = { requestId: "a", source: "gateway" as const };
  const other = { requestId: "b", source: "gateway" as const };
  const parent = { requestId: "a", source: "chatroom" as const };
  const duplicate = { ...parent };
  const result = preferChatroomTraces([gateway, other, parent, duplicate, gateway]);
  assert.deepEqual(result, [parent, other]);
  assert.equal(result[0], parent);
});

test("summarizes unique requests with sorted UTC days and only known durations", () => {
  const result = summarizeTraces([
    { requestId: "a", source: "gateway", status: "ok", startedAt: 86_400_000, durationMs: 999 },
    {
      requestId: "a",
      source: "chatroom",
      status: "ok",
      startedAt: 86_400_000,
      durationMs: 10,
      usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
      stepCount: 2,
      toolCallCount: 1,
    },
    { requestId: "b", source: "gateway", status: "error", startedAt: 0, durationMs: 0 },
    { requestId: "c", source: "gateway", status: "running", startedAt: 0 },
    { requestId: "d", source: "gateway", status: "aborted", startedAt: 0 },
  ]);
  assert.deepEqual(result, {
    summary: {
      traces: 4,
      successful: 1,
      errors: 1,
      aborted: 1,
      running: 1,
      averageDurationMs: 5,
      inputTokens: 2,
      outputTokens: 3,
      totalTokens: 5,
      steps: 2,
      toolCalls: 1,
    },
    daily: [
      { date: "1970-01-01", traces: 3, errors: 1, durationMs: 0, tokens: 0 },
      { date: "1970-01-02", traces: 1, errors: 0, durationMs: 10, tokens: 5 },
    ],
  });
});

test("empty summaries have no days or non-finite average", () => {
  const { summary, daily } = summarizeTraces([]);
  assert.ok(Object.values(summary).every((value) => value === 0));
  assert.deepEqual(daily, []);
});
