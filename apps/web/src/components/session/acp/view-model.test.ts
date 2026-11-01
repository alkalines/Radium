import { describe, expect, test } from "bun:test";
import type { AcpItem, AcpOp } from "backend/src/acp/contract";
import {
  applyAcpFrames,
  emptyAcpTimeline,
  startAcpEpoch,
  type AcpTimeline,
} from "backend/src/acp/fold";
import { acpChatStatus, acpRunState, createAcpViewModel } from "./view-model";
import { isAcpNoticePart, isAcpToolPart } from "./parts";

function timeline(items: AcpItem[], ops: AcpOp[] = []): AcpTimeline {
  return applyAcpFrames(startAcpEpoch(emptyAcpTimeline, 1, { keepOlder: false }), [
    {
      seqFrom: 0,
      seqTo: items.length + ops.length,
      kind: "snapshot",
      payload: JSON.stringify([
        { op: "window", start: items[0]?.order ?? 0, hasMore: false },
        ...items.map((item) => ({ op: "item.upsert", item })),
        ...ops,
      ]),
    },
  ]);
}

const user: AcpItem = { id: "u", order: 0, kind: "user", text: "Hello", turnId: "turn" };
const thought: AcpItem = { id: "r", order: 1, kind: "thought", text: "Thinking", turnId: "turn" };
const tool: AcpItem = {
  id: "t",
  order: 2,
  kind: "tool",
  toolCallId: "call",
  title: "Read",
  status: "in_progress",
  turnId: "turn",
};
const agent: AcpItem = { id: "a", order: 3, kind: "agent", text: "Answer", turnId: "turn" };

describe("ACP message mapping", () => {
  test("groups assistant items, renders notices, and takes the latest plan outside messages", () => {
    const state = timeline([
      user,
      thought,
      tool,
      agent,
      { id: "notice", order: 4, kind: "notice", severity: "info", title: "Compacted" },
      {
        id: "plan",
        order: 5,
        kind: "plan",
        entries: [{ content: "Done", status: "completed", priority: "high" }],
      },
      {
        id: "plan2",
        order: 6,
        kind: "plan",
        entries: [{ content: "Next", status: "pending", priority: "low" }],
      },
      { id: "u2", order: 7, kind: "user", text: "Again" },
    ]);
    const view = createAcpViewModel()(state, "idle");
    expect(view.messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
    expect(view.messages[1]!.parts.map((part) => part.type)).toEqual([
      "reasoning",
      "dynamic-tool",
      "text",
      "data-acp-notice",
    ]);
    expect(isAcpNoticePart(view.messages[1]!.parts[3])).toBe(true);
    expect(view.todos).toEqual([{ content: "Next", status: "pending" }]);
  });

  test("reuses finished message objects while the latest turn streams", () => {
    const build = createAcpViewModel();
    const first = timeline([user, thought, agent]);
    const view = build(first, "running");
    const next = applyAcpFrames(first, [
      {
        seqFrom: first.nextSeq,
        seqTo: first.nextSeq,
        kind: "live",
        payload: JSON.stringify([{ op: "text.append", id: agent.id, text: "!" }]),
      },
    ]);
    const updated = build(next, "running");
    expect(updated.messages[0]).toBe(view.messages[0]);
    expect(updated.messages[1]).not.toBe(view.messages[1]);
    expect(updated.messages[1]!.parts[0]).toMatchObject({ type: "reasoning", state: "done" });
    expect(updated.messages[1]!.parts[1]).toMatchObject({ type: "text", state: "streaming" });
    expect(build(next, "running").messages[1]).toBe(updated.messages[1]);
  });

  test("marks open tools cancelled and remembers it after the next turn", () => {
    const build = createAcpViewModel();
    const state = timeline(
      [user, tool],
      [{ op: "turn.end", turnId: "turn", stopReason: "cancelled" }],
    );
    const view = build(state, "idle");
    const part = view.messages[1]!.parts[0];
    expect(isAcpToolPart(part) && part.acp.turnCancelled).toBe(true);
    const next = applyAcpFrames(state, [
      {
        seqFrom: state.nextSeq,
        seqTo: state.nextSeq + 1,
        kind: "live",
        payload: JSON.stringify([
          {
            op: "item.upsert",
            item: { id: "u2", order: 4, kind: "user", text: "Next", turnId: "next" },
          },
          { op: "turn.start", turnId: "next" },
        ]),
      },
    ]);
    expect(build(next, "running").messages[1]).toBe(view.messages[1]);
  });

  test("prepends shared history without changing existing user message identity", () => {
    const build = createAcpViewModel();
    const state = timeline([user, agent]);
    const first = build(state, "idle");
    const next = applyAcpFrames(state, [
      {
        seqFrom: state.nextSeq,
        seqTo: state.nextSeq + 1,
        kind: "history",
        payload: JSON.stringify([
          { op: "window", start: -2, before: 0, hasMore: false },
          { op: "item.upsert", item: { id: "old", kind: "user", order: -2, text: "Earlier" } },
        ]),
      },
    ]);
    const updated = build(next, "idle");
    expect(updated.messages[1]).toBe(first.messages[0]);
    expect(next.windowStart).toBe(-2);
  });
});

describe("ACP lifecycle mapping", () => {
  test("maps metadata without fetching content", () => {
    expect(acpRunState("starting", undefined, emptyAcpTimeline)).toBe("queued");
    expect(acpRunState("running", undefined, emptyAcpTimeline)).toBe("streaming");
    expect(acpRunState("awaiting", undefined, emptyAcpTimeline)).toBe("awaiting");
    expect(acpRunState("idle", "end_turn", emptyAcpTimeline)).toBe("succeeded");
    expect(acpRunState("idle", "cancelled", emptyAcpTimeline)).toBe("cancelled");
    expect(acpRunState("failed", undefined, emptyAcpTimeline)).toBe("failed");
    expect(acpRunState("ended", "cancelled", emptyAcpTimeline)).toBe("idle");
    expect(acpChatStatus("starting")).toBe("submitted");
    expect(acpChatStatus("awaiting")).toBe("streaming");
    expect(acpChatStatus("failed")).toBe("ready");
  });

  test("refines running from thought, agent text, and in-progress tool items", () => {
    expect(acpRunState("running", undefined, timeline([user, thought]))).toBe("thinking");
    expect(acpRunState("running", undefined, timeline([user, thought, tool]))).toBe("executing");
    expect(acpRunState("running", undefined, timeline([user, thought, tool, agent]))).toBe(
      "streaming",
    );
  });
});
