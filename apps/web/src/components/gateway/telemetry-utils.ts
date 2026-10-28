import type { RunState } from "@/components/agentic/agent-status";

/** Request status as stored by the backend. */
export type RequestStatusValue = "ok" | "error" | "aborted";

const requestRunStates: Record<RequestStatusValue, RunState> = {
  ok: "succeeded",
  error: "failed",
  aborted: "cancelled",
};

/** Map a request status to the shared `RunState` once at the data boundary. */
export function requestRunState(status: RequestStatusValue): RunState {
  return requestRunStates[status];
}

/** Format a timestamp using the browser locale and timezone. */
export function formatTelemetryDate(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** Format a duration in milliseconds; an absent value means the phase was not measured. */
export function formatTelemetryDuration(ms: number | undefined): string {
  if (ms === undefined) return "–";
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`;
  return ms >= 1_000 ? `${(ms / 1_000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}

/** Format a token count compactly only once it reaches five digits. */
export function formatTokenCount(value: number): string {
  return new Intl.NumberFormat(undefined, {
    notation: value >= 10_000 ? "compact" : "standard",
  }).format(value);
}

/** Estimated cost in USD; sub-cent values keep enough digits to stay distinguishable. */
export function formatCost(cost: number | undefined): string {
  if (cost === undefined) return "–";
  if (cost > 0 && cost < 0.000001) return "<$0.000001";
  return `$${cost < 0.01 ? cost.toFixed(6) : cost.toFixed(4)}`;
}

export type LineageKind = "root" | "continue" | "retry" | "rewrite" | "branch" | "compacted";

const lineageLabels: Record<LineageKind, string> = {
  root: "Root",
  continue: "Continue",
  retry: "Retry",
  rewrite: "Rewrite",
  branch: "Branch",
  compacted: "Compacted",
};

/** Short lineage badge text; branches name the message they diverged after. */
export function lineageLabel(lineage: { kind: LineageKind; depth?: number }): string {
  if (lineage.kind === "branch" && lineage.depth !== undefined) {
    return `Branch after message ${lineage.depth}`;
  }
  return lineageLabels[lineage.kind];
}

/** Lineage kinds that leave the previous conversation tip behind as an alternate branch. */
export function isForkKind(kind: LineageKind): boolean {
  return kind === "branch" || kind === "retry" || kind === "rewrite";
}

const changeLabels = {
  system: "System",
  toolset: "Tools",
  params: "Params",
  model: "Model",
} as const;

export type ChangedField = keyof typeof changeLabels;

export function changeLabel(field: ChangedField): string {
  return changeLabels[field];
}

export type DiffLine = { kind: "same" | "add" | "remove"; text: string };

/** Above this many cells the quadratic diff table is skipped and the text is shown replaced. */
const MAX_DIFF_CELLS = 4_000_000;

/** Line-level diff using a longest-common-subsequence table. */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  if (a.length * b.length > MAX_DIFF_CELLS) {
    return [
      ...a.map((text): DiffLine => ({ kind: "remove", text })),
      ...b.map((text): DiffLine => ({ kind: "add", text })),
    ];
  }

  const width = b.length + 1;
  const table = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * width + j] =
        a[i] === b[j]
          ? table[(i + 1) * width + j + 1] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }

  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      lines.push({ kind: "same", text: a[i] });
      i++;
      j++;
    } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
      lines.push({ kind: "remove", text: a[i++] });
    } else {
      lines.push({ kind: "add", text: b[j++] });
    }
  }
  while (i < a.length) lines.push({ kind: "remove", text: a[i++] });
  while (j < b.length) lines.push({ kind: "add", text: b[j++] });
  return lines;
}

export type ParamChange = {
  key: string;
  kind: "added" | "removed" | "changed";
  before?: unknown;
  after?: unknown;
};

/** Top-level key diff of two params objects; nested values compare by JSON equality. */
export function diffParams(before: unknown, after: unknown): ParamChange[] {
  const from = asRecord(before) ?? {};
  const to = asRecord(after) ?? {};
  const changes: ParamChange[] = [];

  for (const key of Object.keys(to).sort()) {
    if (!(key in from)) changes.push({ key, kind: "added", after: to[key] });
    else if (JSON.stringify(from[key]) !== JSON.stringify(to[key])) {
      changes.push({ key, kind: "changed", before: from[key], after: to[key] });
    }
  }
  for (const key of Object.keys(from).sort()) {
    if (!(key in to)) changes.push({ key, kind: "removed", before: from[key] });
  }
  return changes;
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Plain text of an OpenAI-format message `content` (string or content parts). */
export function contentText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((part) => {
      const record = asRecord(part);
      return typeof record?.text === "string" ? record.text : undefined;
    })
    .filter((part): part is string => part !== undefined)
    .join("\n");
  return text || undefined;
}

/** Text of the recorded system/developer messages, one block per message. */
export function systemText(value: unknown): string {
  if (!Array.isArray(value)) return typeof value === "string" ? value : prettyJson(value);
  return value
    .map((message) => contentText(asRecord(message)?.content) ?? prettyJson(message))
    .join("\n\n");
}

export type ToolCallView = { id?: string; name: string; arguments: unknown };

/** Tool calls of an assistant message, with JSON-string arguments parsed when possible. */
export function messageToolCalls(message: Record<string, unknown>): ToolCallView[] {
  if (!Array.isArray(message.tool_calls)) return [];
  return message.tool_calls.map((call) => {
    const record = asRecord(call);
    const fn = asRecord(record?.function);
    const raw = fn?.arguments;
    let parsed: unknown = raw;
    if (typeof raw === "string") {
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = raw;
      }
    }
    return {
      id: typeof record?.id === "string" ? record.id : undefined,
      name: typeof fn?.name === "string" ? fn.name : "tool",
      arguments: parsed,
    };
  });
}

export function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}
