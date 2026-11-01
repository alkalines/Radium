import { describe, expect, it } from "vitest";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import {
  ACP_HISTORY_PAGE_ITEMS,
  ACP_ITEM_CONTENT_BYTES,
  ACP_SNAPSHOT_BYTES,
  utf8Bytes,
  type AcpItemPatch,
  type AcpOp,
} from "backend/src/acp/contract";
import { AcpTimeline, normalizeConfig, normalizeToolContent } from "./timeline";

function items(ops: AcpOp[]): AcpItemPatch[] {
  return ops.flatMap((op) => (op.op === "item.upsert" ? [op.item] : []));
}

function chunk(text: string, messageId?: string): SessionUpdate {
  return {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text },
    ...(messageId ? { messageId } : {}),
  };
}

describe("AcpTimeline", () => {
  it("groups anonymous chunks by kind and tool boundaries while preserving explicit message ids", () => {
    const timeline = new AcpTimeline();
    timeline.startTurn("turn");
    const first = items(timeline.update(chunk("Hello")))[0]!;
    expect(timeline.update(chunk(" world"))).toEqual([
      { op: "text.append", id: first.id, text: " world" },
    ]);
    const thought = items(
      timeline.update({
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "Thinking" },
      }),
    )[0]!;
    const second = items(timeline.update(chunk("Again")))[0]!;
    timeline.update({ sessionUpdate: "tool_call", toolCallId: "read", title: "Read file" });
    const third = items(timeline.update(chunk("After tool")))[0]!;
    expect(new Set([first.id, thought.id, second.id, third.id]).size).toBe(4);
    timeline.update(chunk("Stable", "stable"));
    timeline.update({ sessionUpdate: "tool_call", toolCallId: "other", title: "Other tool" });
    expect(timeline.update(chunk(" id", "stable"))).toEqual([
      { op: "text.append", id: "msg:stable", text: " id" },
    ]);
    expect(items(timeline.snapshot()).find((item) => item.id === "msg:stable")).toMatchObject({
      text: "Stable id",
      turnId: "turn",
    });
    expect(items(timeline.snapshot()).map((item) => item.order)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("normalizes all message part kinds without retaining binary data", () => {
    const timeline = new AcpTimeline();
    const updates: SessionUpdate[] = [
      {
        sessionUpdate: "user_message_chunk",
        messageId: "parts",
        content: { type: "image", mimeType: "image/png", data: "SECRET", uri: "file:///image" },
      },
      {
        sessionUpdate: "user_message_chunk",
        messageId: "parts",
        content: { type: "audio", mimeType: "audio/wav", data: "SECRET" },
      },
      {
        sessionUpdate: "user_message_chunk",
        messageId: "parts",
        content: {
          type: "resource",
          resource: { uri: "file:///a", mimeType: "text/plain", text: "NOT_RELAYED" },
        },
      },
      {
        sessionUpdate: "user_message_chunk",
        messageId: "parts",
        content: { type: "resource_link", uri: "file:///b", name: "b" },
      },
    ];
    for (const update of updates) timeline.update(update);
    const snapshot = timeline.snapshot();
    expect(items(snapshot)[0]).toMatchObject({
      kind: "user",
      text: "",
      parts: [
        { type: "image", mimeType: "image/png", uri: "file:///image" },
        { type: "audio", mimeType: "audio/wav" },
        { type: "resource", uri: "file:///a", mimeType: "text/plain" },
        { type: "resource_link", uri: "file:///b", name: "b" },
      ],
    });
    expect(JSON.stringify(snapshot)).not.toContain("SECRET");
    expect(JSON.stringify(snapshot)).not.toContain("NOT_RELAYED");
  });

  it("records one user prompt and resets message grouping between turns", () => {
    const timeline = new AcpTimeline();
    expect(
      items(
        timeline.user([
          { type: "text", text: "Read " },
          { type: "resource_link", uri: "file:///a", name: "a" },
          { type: "text", text: "please" },
        ]),
      )[0],
    ).toMatchObject({
      kind: "user",
      text: "Read please",
      parts: [{ type: "resource_link", uri: "file:///a", name: "a" }],
    });
    expect(timeline.startTurn("one")).toEqual([{ op: "turn.start", turnId: "one" }]);
    const one = items(timeline.update(chunk("one")))[0]!;
    expect(timeline.endTurn("cancelled")).toEqual([
      { op: "turn.end", turnId: "one", stopReason: "cancelled" },
    ]);
    timeline.startTurn("two");
    const two = items(timeline.update(chunk("two")))[0]!;
    expect(two.id).not.toBe(one.id);
    expect(timeline.endTurn(undefined, "Agent exited")).toEqual([
      {
        op: "item.upsert",
        item: expect.objectContaining({
          kind: "notice",
          severity: "error",
          title: "Agent exited",
          turnId: "two",
        }),
      },
      { op: "turn.end", turnId: "two", error: "Agent exited" },
    ]);
    expect(timeline.endTurn()).toEqual([]);
    expect(timeline.snapshot().some((op) => op.op === "turn.start")).toBe(false);
  });

  it("patches tool fields without wiping omitted values and uses null to clear", () => {
    const timeline = new AcpTimeline();
    timeline.update({
      sessionUpdate: "tool_call",
      toolCallId: "read",
      title: "Read",
      kind: "read",
      status: "pending",
      locations: [{ path: "/a", line: 3 }],
      rawInput: { path: "/a" },
      content: [{ type: "diff", path: "/a", oldText: "old", newText: "new" }],
    });
    expect(
      timeline.update({
        sessionUpdate: "tool_call_update",
        toolCallId: "read",
        status: "completed",
        rawOutput: { ok: true },
      }),
    ).toEqual([
      {
        op: "item.upsert",
        item: { id: "tool:read", status: "completed", rawOutput: '{"ok":true}' },
      },
    ]);
    expect(items(timeline.snapshot())[0]).toMatchObject({
      title: "Read",
      toolKind: "read",
      rawInput: '{"path":"/a"}',
      content: [{ type: "diff", path: "/a", oldText: "old", newText: "new" }],
    });
    expect(
      timeline.update({
        sessionUpdate: "tool_call_update",
        toolCallId: "read",
        rawInput: null,
        content: null,
        locations: null,
        kind: null,
      }),
    ).toEqual([
      {
        op: "item.upsert",
        item: { id: "tool:read", rawInput: null, content: null, locations: null, toolKind: null },
      },
    ]);
    const item = items(timeline.snapshot())[0]!;
    expect(item).not.toHaveProperty("rawInput");
    expect(item).not.toHaveProperty("content");
    expect(item).not.toHaveProperty("locations");
    expect(item.status).toBe("completed");
  });

  it("bounds combined tool content/raw data in UTF-8 and preserves a useful prefix", () => {
    const timeline = new AcpTimeline();
    timeline.update({
      sessionUpdate: "tool_call",
      toolCallId: "large",
      title: "Large",
      rawOutput: "z".repeat(ACP_ITEM_CONTENT_BYTES),
      content: [
        {
          type: "content",
          content: { type: "text", text: '😀\\"'.repeat(ACP_ITEM_CONTENT_BYTES) },
        },
      ],
    });
    const item = items(timeline.history(Infinity, 1))[0]!;
    expect(item.truncated).toBe(true);
    expect(item.content?.[0]).toMatchObject({ type: "text" });
    const first = item.content?.[0];
    expect(first?.type === "text" ? first.text.length : 0).toBeGreaterThan(1000);
    expect(
      utf8Bytes(JSON.stringify(item.content)) +
        utf8Bytes(item.rawInput ?? "") +
        utf8Bytes(item.rawOutput ?? ""),
    ).toBeLessThanOrEqual(ACP_ITEM_CONTENT_BYTES);
    expect(JSON.stringify(item)).not.toContain("�");
  });

  it("replaces plans and preserves compaction summary patch/null semantics", () => {
    const timeline = new AcpTimeline();
    timeline.startTurn("turn");
    timeline.update({
      sessionUpdate: "plan",
      entries: [{ content: "First", priority: "high", status: "pending" }],
    });
    timeline.update({
      sessionUpdate: "plan",
      entries: [{ content: "Second", priority: "low", status: "completed" }],
    });
    timeline.update({
      sessionUpdate: "compaction_summary_chunk",
      compactionId: "c",
      content: { type: "text", text: "Summary" },
    });
    timeline.update({
      sessionUpdate: "compaction_update",
      compactionId: "c",
      status: "failed",
      error: "Failed",
    });
    expect(items(timeline.snapshot()).find((item) => item.id === "compaction:c")).toMatchObject({
      severity: "error",
      description: "Failed",
      compaction: { id: "c", status: "failed", summary: "Summary" },
    });
    expect(
      timeline.update({
        sessionUpdate: "compaction_update",
        compactionId: "c",
        status: "completed",
        summary: null,
        error: null,
      }),
    ).toEqual([
      {
        op: "item.upsert",
        item: expect.objectContaining({
          id: "compaction:c",
          description: null,
          compaction: { id: "c", status: "completed" },
        }),
      },
    ]);
    const snapshot = items(timeline.snapshot());
    expect(snapshot.filter((item) => item.kind === "plan")).toEqual([
      expect.objectContaining({
        id: "plan:turn",
        entries: [{ content: "Second", priority: "low", status: "completed" }],
      }),
    ]);
    expect(snapshot.find((item) => item.id === "compaction:c")).toMatchObject({
      compaction: { id: "c", status: "completed" },
    });
    expect(snapshot.find((item) => item.id === "compaction:c")?.compaction).not.toHaveProperty(
      "summary",
    );
    expect(snapshot.find((item) => item.id === "compaction:c")).not.toHaveProperty("description");
  });

  it("merges session metadata and normalizes grouped config/boolean choices", () => {
    const timeline = new AcpTimeline();
    timeline.sessionPatch.config = normalizeConfig({
      modes: { currentModeId: "code", availableModes: [{ id: "code", name: "Code" }] },
    });
    timeline.update({
      sessionUpdate: "config_option_update",
      configOptions: [
        {
          type: "select",
          id: "model",
          name: "Model",
          currentValue: "m",
          options: [
            {
              group: "provider",
              name: "Provider",
              options: [{ value: "m", name: "Model", description: null }],
            },
          ],
        },
        { type: "boolean", id: "flag", name: "Flag", currentValue: true, description: null },
      ],
    });
    timeline.update({ sessionUpdate: "current_mode_update", currentModeId: "code" });
    timeline.update({
      sessionUpdate: "available_commands_update",
      availableCommands: [{ name: "test", description: "Test", input: { hint: "args" } }],
    });
    timeline.update({
      sessionUpdate: "usage_update",
      used: 1,
      size: 100,
      cost: { amount: 0.5, currency: "USD" },
    });
    timeline.update({
      sessionUpdate: "session_info_update",
      title: "Title",
      updatedAt: "2026-11-01",
    });
    timeline.update({ sessionUpdate: "session_info_update", title: null });
    expect(timeline.sessionPatch).toEqual({
      op: "session.patch",
      config: {
        options: [
          {
            type: "select",
            id: "model",
            name: "Model",
            currentValue: "m",
            choices: [{ value: "m", name: "Model", group: "provider" }],
          },
          { type: "boolean", id: "flag", name: "Flag", currentValue: true },
        ],
        modes: { currentModeId: "code", available: [{ id: "code", name: "Code" }] },
      },
      commands: [{ name: "test", description: "Test", hint: "args" }],
      usage: { used: 1, size: 100, cost: { amount: 0.5, currency: "USD" } },
      info: { title: null, updatedAt: "2026-11-01" },
    });
    expect(timeline.snapshot().at(-1)).toEqual(timeline.sessionPatch);
  });

  it("publishes bounded whole-item snapshots and nonoverlapping older history pages", () => {
    const timeline = new AcpTimeline();
    for (let index = 0; index < 80; index++)
      timeline.update(chunk("😀".repeat(1000), String(index)));
    timeline.startTurn("running");
    const snapshot = timeline.snapshot(12_000);
    expect(utf8Bytes(JSON.stringify(snapshot))).toBeLessThanOrEqual(12_000);
    expect(snapshot).toContainEqual({ op: "turn.start", turnId: "running" });
    expect(items(snapshot).length).toBeGreaterThan(0);
    expect(items(snapshot).every((item) => item.text === "😀".repeat(1000))).toBe(true);
    const window = snapshot[0]!;
    if (window.op !== "window") throw new Error("Missing window");
    expect(window.hasMore).toBe(true);
    const page = timeline.history(window.start, 10_000);
    expect(items(page)).toHaveLength(ACP_HISTORY_PAGE_ITEMS);
    expect(items(page).every((item) => item.order! < window.start)).toBe(true);
    expect(page[0]).toMatchObject({ op: "window", before: window.start, hasMore: true });
    expect(timeline.history(0, 10)).toEqual([
      { op: "window", start: 0, before: 0, hasMore: false },
    ]);
    expect(utf8Bytes(JSON.stringify(timeline.snapshot()))).toBeLessThanOrEqual(ACP_SNAPSHOT_BYTES);
  });

  it("keeps oversized whole items in history instead of silently truncating the snapshot", () => {
    const timeline = new AcpTimeline();
    const text = "x".repeat(ACP_SNAPSHOT_BYTES + 1);
    timeline.update(chunk(text, "large"));
    expect(items(timeline.snapshot())).toEqual([]);
    expect(timeline.snapshot()[0]).toEqual({ op: "window", start: 1, hasMore: true });
    expect(items(timeline.history(1, 1))[0]?.text).toBe(text);
  });

  it("evicts the oldest cached items and signals that missing history needs a reload", () => {
    const timeline = new AcpTimeline();
    for (let index = 0; index < 10; index++)
      timeline.update(chunk("x".repeat(1024 * 1024), String(index)));
    expect(timeline.needsReload).toBe(true);
    expect(timeline.history(1, 1)).toEqual([{ op: "window", start: 1, before: 1, hasMore: true }]);
    expect(items(timeline.history(10, 50)).at(-1)).toMatchObject({ id: "msg:9", order: 9 });
  });

  it("sanitizes permission content with the same binary-free normalization", () => {
    const content = normalizeToolContent([
      { type: "content", content: { type: "image", mimeType: "image/png", data: "PRIVATE" } },
      { type: "terminal", terminalId: "term" },
    ]);
    expect(content).toEqual([
      { type: "image", mimeType: "image/png" },
      { type: "terminal", terminalId: "term" },
    ]);
  });
});
