import type { TelemetrySource, TelemetryUsage } from "./integration";

type Trace = {
  requestId: string;
  source: TelemetrySource;
  status: "running" | "ok" | "error" | "aborted";
  startedAt: number;
  durationMs?: number;
  usage?: TelemetryUsage;
  stepCount?: number;
  toolCallCount?: number;
};

/** Keep request order, replacing nested gateway traces with their chatroom parent. */
export function preferChatroomTraces<T extends Pick<Trace, "requestId" | "source">>(
  traces: T[],
): T[] {
  const byRequest = new Map<string, T>();
  for (const trace of traces) {
    const current = byRequest.get(trace.requestId);
    if (!current || (trace.source === "chatroom" && current.source !== "chatroom")) {
      byRequest.set(trace.requestId, trace);
    }
  }
  return [...byRequest.values()];
}

/** Aggregate an already bounded window, counting each request once. */
export function summarizeTraces(traces: Trace[]) {
  const windowed = preferChatroomTraces(traces);
  const summary = {
    traces: windowed.length,
    successful: 0,
    errors: 0,
    aborted: 0,
    running: 0,
    averageDurationMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    steps: 0,
    toolCalls: 0,
  };
  const daily = new Map<
    string,
    { date: string; traces: number; errors: number; durationMs: number; tokens: number }
  >();
  let durationTotal = 0;
  let durationCount = 0;

  for (const trace of windowed) {
    if (trace.status === "ok") summary.successful++;
    else if (trace.status === "error") summary.errors++;
    else if (trace.status === "aborted") summary.aborted++;
    else summary.running++;
    if (trace.durationMs !== undefined) {
      durationTotal += trace.durationMs;
      durationCount++;
    }
    summary.inputTokens += trace.usage?.inputTokens ?? 0;
    summary.outputTokens += trace.usage?.outputTokens ?? 0;
    summary.totalTokens += trace.usage?.totalTokens ?? 0;
    summary.steps += trace.stepCount ?? 0;
    summary.toolCalls += trace.toolCallCount ?? 0;

    const date = new Date(trace.startedAt).toISOString().slice(0, 10);
    const day = daily.get(date) ?? {
      date,
      traces: 0,
      errors: 0,
      durationMs: 0,
      tokens: 0,
    };
    day.traces++;
    if (trace.status === "error") day.errors++;
    day.durationMs += trace.durationMs ?? 0;
    day.tokens += trace.usage?.totalTokens ?? 0;
    daily.set(date, day);
  }
  summary.averageDurationMs = durationCount ? durationTotal / durationCount : 0;

  return {
    summary,
    daily: [...daily.values()].sort((a, b) => a.date.localeCompare(b.date)),
  };
}
