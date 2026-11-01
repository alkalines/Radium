import type { ChatStatus, UIMessage } from "ai";
import type { AcpItem, AcpSessionStatus, AcpStopReason } from "backend/src/acp/contract";
import { acpItemsInOrder, type AcpTimeline } from "backend/src/acp/fold";
import type { TodoItem } from "backend/src/chatroom/session-tools";
import type { RunState } from "@/components/agentic/agent-status";
import { acpToolPart, type AcpNoticePart } from "./parts";

type CachedMessage = {
  items: readonly AcpItem[];
  live: boolean;
  cancelled: boolean;
  message: UIMessage;
};

/** Per-Session cache: only the turn whose item identities changed gets a new message object. */
export function createAcpViewModel() {
  let cache = new Map<string, CachedMessage>();
  let previousPlan: AcpItem | undefined;
  let todos: TodoItem[] | undefined;
  const cancelledTurns = new Set<string>();
  let epoch: number | undefined;

  return (timeline: AcpTimeline, status: AcpSessionStatus | undefined) => {
    if (epoch !== timeline.epoch && timeline.items.size === 0) cancelledTurns.clear();
    epoch = timeline.epoch;
    if (timeline.turn?.ended && timeline.turn.stopReason === "cancelled") {
      cancelledTurns.add(timeline.turn.id);
    }
    const groups: AcpItem[][] = [];
    let plan: AcpItem | undefined;
    for (const item of acpItemsInOrder(timeline)) {
      if (item.kind === "plan") {
        plan = item;
        continue;
      }
      const previous = groups.at(-1);
      if (item.kind === "user" || !previous || previous[0]?.kind === "user") groups.push([item]);
      else previous.push(item);
    }
    const nextCache = new Map<string, CachedMessage>();
    const messages = groups.map((items): UIMessage => {
      const first = items[0]!;
      const user = first.kind === "user";
      const id = `${user ? "user" : "assistant"}:${first.id}`;
      const live =
        !user && status === "running" && !timeline.turn?.ended && groups.at(-1) === items;
      const cancelled = items.some((item) => item.turnId && cancelledTurns.has(item.turnId));
      const cached = cache.get(id);
      if (
        cached &&
        cached.live === live &&
        cached.cancelled === cancelled &&
        cached.items.length === items.length &&
        items.every((item, index) => cached.items[index] === item)
      ) {
        nextCache.set(id, cached);
        return cached.message;
      }
      const parts: UIMessage["parts"] = items.flatMap((item): UIMessage["parts"] => {
        switch (item.kind) {
          case "user":
          case "agent":
            return [
              {
                type: "text",
                text: item.text,
                state: live && item === items.at(-1) ? "streaming" : "done",
              },
            ];
          case "thought":
            return [
              {
                type: "reasoning",
                text: item.text,
                state: live && item === items.at(-1) ? "streaming" : "done",
              },
            ];
          case "tool":
            return [acpToolPart(item, cancelled)];
          case "notice":
            return [{ type: "data-acp-notice", id: item.id, data: item } satisfies AcpNoticePart];
          case "plan":
            return [];
        }
      });
      const message: UIMessage = { id, role: user ? "user" : "assistant", parts };
      nextCache.set(id, { items, live, cancelled, message });
      return message;
    });
    cache = nextCache;
    if (previousPlan !== plan) {
      previousPlan = plan;
      todos =
        plan?.kind === "plan"
          ? plan.entries.map(({ content, status }) => ({ content, status }))
          : undefined;
    }
    return { messages, todos };
  };
}

/** Durable status wins; live items refine only a running turn, never Worker presence. */
export function acpRunState(
  status: AcpSessionStatus | undefined,
  stopReason: AcpStopReason | undefined,
  timeline: AcpTimeline,
): RunState {
  if (status === "starting") return "queued";
  if (status === "awaiting") return "awaiting";
  if (status === "failed") return "failed";
  if (status === "idle") {
    if (stopReason === "cancelled") return "cancelled";
    if (stopReason === "end_turn") return "succeeded";
  }
  if (status !== "running") return "idle";
  if (timeline.turn?.ended) return "streaming";
  const items = acpItemsInOrder(timeline);
  const current = items.filter((item) => !timeline.turn || item.turnId === timeline.turn.id);
  const latest = current.findLast(
    (item) => item.kind === "thought" || item.kind === "agent" || item.kind === "tool",
  );
  if (latest?.kind === "thought") return "thinking";
  if (latest?.kind === "agent") return "streaming";
  if (current.some((item) => item.kind === "tool" && item.status === "in_progress"))
    return "executing";
  return "streaming";
}

export function acpChatStatus(status: AcpSessionStatus | undefined): ChatStatus {
  if (status === "starting") return "submitted";
  if (status === "running" || status === "awaiting") return "streaming";
  return "ready";
}
