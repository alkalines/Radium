import type { TelemetryLineage } from "./validators";

/** A tool in a toolset, identified by function name and content hash. */
export type ToolRef = { name: string; hash: string };

export type ToolDiff = {
  added: ToolRef[];
  removed: ToolRef[];
  /** Same name, different definition. */
  changed: { name: string; fromHash: string; toHash: string }[];
  /** Tools present in both sets that appear in a different relative order. */
  reordered: boolean;
};

/** Compare two toolsets by tool name; definitions are compared by hash. */
export function diffTools(from: ToolRef[], to: ToolRef[]): ToolDiff {
  const fromByName = new Map(from.map((tool) => [tool.name, tool]));
  const toByName = new Map(to.map((tool) => [tool.name, tool]));

  const added = to.filter((tool) => !fromByName.has(tool.name));
  const removed = from.filter((tool) => !toByName.has(tool.name));
  const changed: ToolDiff["changed"] = [];
  for (const tool of to) {
    const before = fromByName.get(tool.name);
    if (before && before.hash !== tool.hash) {
      changed.push({ name: tool.name, fromHash: before.hash, toHash: tool.hash });
    }
  }

  const sharedInFrom = from.filter((tool) => toByName.has(tool.name)).map((tool) => tool.name);
  const sharedInTo = to.filter((tool) => fromByName.has(tool.name)).map((tool) => tool.name);
  const reordered = sharedInFrom.some((name, index) => name !== sharedInTo[index]);

  return { added, removed, changed, reordered };
}

/** What a request needs from its lineage parent to know how much of its chain was already stored. */
export type LineageParent = {
  /** Depth of the parent's last client message; 0 when it had none. */
  inputDepth: number;
  hasOutput: boolean;
};

/**
 * Depth of the conversation prefix a request shared with earlier history; messages deeper than
 * this are new in the request. Prefers the depth recorded at capture and falls back to deriving
 * it from the lineage parent.
 */
export function sharedPrefixDepth(lineage: TelemetryLineage, parent: LineageParent | null): number {
  if (lineage.depth !== undefined) return lineage.depth;
  if (!parent) return 0;
  switch (lineage.kind) {
    case "retry":
    case "rewrite":
      return parent.inputDepth;
    case "continue":
      return parent.hasOutput ? parent.inputDepth + 1 : parent.inputDepth;
    default:
      return 0;
  }
}

/** Nearest-rank percentile of an unsorted sample; undefined for an empty sample. */
export function percentile(values: number[], p: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
}

type SummaryInput = {
  model: string;
  status: "ok" | "error" | "aborted";
  durationMs: number;
  ttftMs?: number;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
};

/** Aggregate an already bounded, already visibility-filtered request window. */
export function summarizeRequests(requests: SummaryInput[]) {
  let errors = 0;
  let aborted = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  const durations: number[] = [];
  const ttfts: number[] = [];
  const models = new Map<string, { requests: number; totalTokens: number }>();

  for (const request of requests) {
    if (request.status === "error") errors += 1;
    if (request.status === "aborted") aborted += 1;
    const usage = request.usage;
    const total = usage?.totalTokens ?? (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);
    inputTokens += usage?.inputTokens ?? 0;
    outputTokens += usage?.outputTokens ?? 0;
    totalTokens += total;
    durations.push(request.durationMs);
    if (request.ttftMs !== undefined) ttfts.push(request.ttftMs);

    const entry = models.get(request.model) ?? { requests: 0, totalTokens: 0 };
    entry.requests += 1;
    entry.totalTokens += total;
    models.set(request.model, entry);
  }

  const topModels = [...models.entries()]
    .map(([model, entry]) => ({ model, ...entry }))
    .sort((a, b) => b.requests - a.requests || b.totalTokens - a.totalTokens)
    .slice(0, 5);

  return {
    requests: requests.length,
    errors,
    aborted,
    errorRate: requests.length === 0 ? 0 : errors / requests.length,
    inputTokens,
    outputTokens,
    totalTokens,
    durationP50: percentile(durations, 0.5),
    durationP95: percentile(durations, 0.95),
    ttftP50: percentile(ttfts, 0.5),
    ttftP95: percentile(ttfts, 0.95),
    topModels,
  };
}

type LaneInput<Id extends string> = {
  id: Id;
  lineage: { kind: TelemetryLineage["kind"]; request?: Id; depth?: number };
  /** Depth the request shares with history; see {@link sharedPrefixDepth}. */
  forkDepth: number;
};

export type BranchLane<Id extends string> = {
  /** The first request of the lane. */
  id: Id;
  kind: TelemetryLineage["kind"];
  /** Lane holding the request this lane forked from; null for roots and truncated parents. */
  parentLane: Id | null;
  forkRequest: Id | null;
  forkDepth: number;
  /** Chronological request IDs in this lane. */
  requests: Id[];
};

/**
 * Group chronologically ordered requests into lanes. A request extends its parent's lane only
 * when it is a plain `continue` of that lane's latest request; retries, rewrites, branches, and
 * a second continuation of the same parent open a new lane, so every alternate branch of a
 * rolled-back conversation stays visible beside the original.
 */
export function buildBranchLanes<Id extends string>(requests: LaneInput<Id>[]): BranchLane<Id>[] {
  const lanes: BranchLane<Id>[] = [];
  const laneOf = new Map<Id, BranchLane<Id>>();

  for (const request of requests) {
    const parentId = request.lineage.request;
    const parentLane = parentId ? laneOf.get(parentId) : undefined;
    const tail = parentLane?.requests[parentLane.requests.length - 1];

    if (request.lineage.kind === "continue" && parentLane && tail === parentId) {
      parentLane.requests.push(request.id);
      laneOf.set(request.id, parentLane);
      continue;
    }

    const lane: BranchLane<Id> = {
      id: request.id,
      kind: request.lineage.kind,
      parentLane: parentLane?.id ?? null,
      forkRequest: parentId ?? null,
      forkDepth: request.forkDepth,
      requests: [request.id],
    };
    lanes.push(lane);
    laneOf.set(request.id, lane);
  }
  return lanes;
}
