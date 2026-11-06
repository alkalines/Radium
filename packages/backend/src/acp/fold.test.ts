import { expect, test } from "vitest";
import type { AcpOp } from "./contract";
import {
  type AcpFrame,
  type AcpTimeline,
  acpItemsInOrder,
  applyAcpFrames,
  emptyAcpTimeline,
  startAcpEpoch,
} from "./fold";

function frames(start: number, ...batches: AcpOp[][]): AcpFrame[] {
  let seq = start;
  return batches.map((ops, index) => {
    const frame: AcpFrame = {
      seqFrom: seq,
      seqTo: seq + ops.length - 1,
      kind: index === 0 && start === 0 ? "snapshot" : "live",
      payload: JSON.stringify(ops),
    };
    seq += ops.length;
    return frame;
  });
}

const snapshot: AcpOp[] = [
  { op: "window", start: 4, hasMore: true },
  { op: "turn.start", turnId: "t2" },
  { op: "item.upsert", item: { id: "u", kind: "user", order: 4, text: "hi" } },
  { op: "item.upsert", item: { id: "a", kind: "agent", order: 5, text: "Hel" } },
];

function opened(): AcpTimeline {
  return applyAcpFrames(
    startAcpEpoch(emptyAcpTimeline, 1, { keepOlder: false }),
    frames(0, snapshot),
  );
}

test("snapshot then live ops build the timeline and track the next sequence", () => {
  const live = applyAcpFrames(
    opened(),
    frames(4, [
      { op: "text.append", id: "a", text: "lo" },
      {
        op: "item.upsert",
        item: {
          id: "tool:1",
          kind: "tool",
          order: 6,
          toolCallId: "1",
          title: "ls",
          status: "in_progress",
        },
      },
    ]),
  );
  expect(live.nextSeq).toBe(6);
  expect(live.windowStart).toBe(4);
  expect(live.hasMore).toBe(true);
  expect(live.turn).toEqual({ id: "t2", ended: false });
  expect(acpItemsInOrder(live).map((item) => item.id)).toEqual(["u", "a", "tool:1"]);
  expect(live.items.get("a")).toMatchObject({ text: "Hello" });
});

test("re-delivered frames are skipped and a gap stops the fold until the range arrives", () => {
  const state = opened();
  const append: AcpOp[] = [{ op: "text.append", id: "a", text: "lo" }];
  const once = applyAcpFrames(state, frames(4, append));
  expect(applyAcpFrames(once, frames(0, snapshot, append))).toBe(once);

  const afterGap = applyAcpFrames(state, frames(5, append));
  expect(afterGap).toBe(state);
});

test("upserts patch fields, null clears them, and unchanged items keep their identity", () => {
  const state = applyAcpFrames(
    opened(),
    frames(4, [
      {
        op: "item.upsert",
        item: {
          id: "tool:1",
          kind: "tool",
          order: 6,
          toolCallId: "1",
          title: "ls",
          rawInput: "{}",
        },
      },
    ]),
  );
  const user = state.items.get("u");
  const next = applyAcpFrames(
    state,
    frames(5, [{ op: "item.upsert", item: { id: "tool:1", status: "completed", rawInput: null } }]),
  );
  expect(next.items.get("tool:1")).toEqual({
    id: "tool:1",
    kind: "tool",
    order: 6,
    toolCallId: "1",
    title: "ls",
    status: "completed",
  });
  expect(next.items.get("u")).toBe(user);
  // A patch for an unknown item without kind/order cannot create it.
  const ignored = applyAcpFrames(
    next,
    frames(6, [{ op: "item.upsert", item: { id: "x", title: "?" } }]),
  );
  expect(ignored.items.has("x")).toBe(false);
  expect(ignored.nextSeq).toBe(7);
});

test("fragments apply their op once every piece arrived, across frames", () => {
  const op: AcpOp = {
    op: "item.upsert",
    item: {
      id: "tool:big",
      kind: "tool",
      order: 6,
      toolCallId: "big",
      title: "cat",
      rawOutput: "x".repeat(50),
    },
  };
  const json = JSON.stringify(op);
  const half = Math.floor(json.length / 2);
  const first = applyAcpFrames(
    opened(),
    frames(4, [{ op: "fragment", id: "f", index: 0, total: 2, data: json.slice(0, half) }]),
  );
  expect(first.items.has("tool:big")).toBe(false);
  const second = applyAcpFrames(
    first,
    frames(5, [{ op: "fragment", id: "f", index: 1, total: 2, data: json.slice(half) }]),
  );
  expect(second.items.get("tool:big")).toMatchObject({ rawOutput: "x".repeat(50) });
  expect(second.fragments.size).toBe(0);
});

test("history pages extend the window downwards and own hasMore", () => {
  const page = applyAcpFrames(
    opened(),
    frames(4, [
      { op: "window", start: 0, before: 4, hasMore: false },
      { op: "item.upsert", item: { id: "u0", kind: "user", order: 0, text: "first" } },
      { op: "item.upsert", item: { id: "a0", kind: "agent", order: 1, text: "reply" } },
    ]),
  );
  expect(page.windowStart).toBe(0);
  expect(page.hasMore).toBe(false);
  expect(acpItemsInOrder(page).map((item) => item.id)).toEqual(["u0", "a0", "u", "a"]);
});

test("a new epoch replaces content unless older pages are kept across a rollover", () => {
  const withHistory = applyAcpFrames(
    opened(),
    frames(4, [
      { op: "window", start: 0, before: 4, hasMore: false },
      { op: "item.upsert", item: { id: "u0", kind: "user", order: 0, text: "first" } },
    ]),
  );
  const rollover: AcpOp[] = [
    { op: "window", start: 4, hasMore: true },
    { op: "item.upsert", item: { id: "u", kind: "user", order: 4, text: "hi" } },
    { op: "item.upsert", item: { id: "a", kind: "agent", order: 5, text: "Hello" } },
  ];

  const kept = applyAcpFrames(
    startAcpEpoch(withHistory, 2, { keepOlder: true }),
    frames(0, rollover),
  );
  expect(kept.epoch).toBe(2);
  expect(kept.nextSeq).toBe(3);
  expect(acpItemsInOrder(kept).map((item) => item.id)).toEqual(["u0", "u", "a"]);
  expect(kept.windowStart).toBe(0);
  expect(kept.hasMore).toBe(false);

  const replaced = applyAcpFrames(
    startAcpEpoch(withHistory, 2, { keepOlder: false }),
    frames(0, rollover),
  );
  expect(acpItemsInOrder(replaced).map((item) => item.id)).toEqual(["u", "a"]);
  expect(replaced.hasMore).toBe(true);
});

test("turn end and session patches are tracked", () => {
  const state = applyAcpFrames(
    opened(),
    frames(4, [
      { op: "session.patch", usage: { used: 10, size: 100 }, info: { title: "T" } },
      { op: "turn.end", turnId: "t2", stopReason: "cancelled" },
      { op: "session.patch", info: { title: null } },
    ]),
  );
  expect(state.turn).toEqual({ id: "t2", ended: true, stopReason: "cancelled" });
  expect(state.session).toEqual({ usage: { used: 10, size: 100 } });
});
