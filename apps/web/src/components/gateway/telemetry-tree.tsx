import { useNavigate } from "@tanstack/react-router";
import type { FunctionReturnType } from "convex/server";
import { useMemo, useState } from "react";

import { MermaidDiagram } from "@/components/mermaid-diagram";
import type { api } from "backend/convex/_generated/api";
import { DataSection } from "./data-section";
import { changeLabel, type LineageKind } from "./telemetry-utils";

type SessionResult = FunctionReturnType<typeof api.observability.telemetry.getSession>;
type Entry = SessionResult["requests"][number];
type Indexed = { entry: Entry; index: number };

/** What clicking a diagram node does: open one request, or expand a group of requests. */
type NodeTarget = { kind: "request"; request: string } | { kind: "group"; group: string };

/**
 * The session's requests as a left-to-right Mermaid flowchart. Click a request to open it, or a
 * grouped run of unchanged requests to expand it in place.
 */
export function RequestTree({ data }: { data: SessionResult }) {
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const { chart, targets } = useMemo(() => requestTreeChart(data, expanded), [data, expanded]);

  return (
    <DataSection
      title="Request tree"
      description="How the session grew, left to right. Click a request to open it; click a grouped run to expand it."
      contentClassName="flex flex-col gap-3 p-3"
    >
      <MermaidDiagram
        chart={chart}
        filename="radium-session"
        title="Request tree"
        className="telemetry-tree"
        startAtEnd
        onNodeClick={(node) => {
          const target = targets.get(node);
          if (!target) return;
          if (target.kind === "request") {
            void navigate({ to: "/gateway/telemetry/$id", params: { id: target.request } });
          } else {
            setExpanded((current) => new Set(current).add(target.group));
          }
        }}
      />
      <Legend collapsible={expanded.size > 0} onCollapse={() => setExpanded(new Set())} />
    </DataSection>
  );
}

function Legend({ collapsible, onCollapse }: { collapsible: boolean; onCollapse: () => void }) {
  const items = [
    { label: "Request", swatch: "border-border bg-card" },
    { label: "Grouped requests", swatch: "border-dashed border-muted-foreground bg-muted" },
    {
      label: "Configuration changed",
      swatch: "border-telemetry-thinking bg-telemetry-thinking/15",
    },
    { label: "Failed", swatch: "border-destructive bg-destructive/15" },
    { label: "Latest", swatch: "border-primary bg-card ring-2 ring-primary/30" },
  ];
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-1 text-xs text-muted-foreground">
      {items.map((item) => (
        <span key={item.label} className="flex items-center gap-1.5">
          <span className={`size-3 rounded-[4px] border-2 ${item.swatch}`} />
          {item.label}
        </span>
      ))}
      <span className="flex items-center gap-1.5">
        <span className="w-5 border-t-2 border-dashed border-telemetry-tool" />
        Branch, retry, or restart
      </span>
      {collapsible && (
        <button
          type="button"
          onClick={onCollapse}
          className="ml-auto text-foreground underline underline-offset-2"
        >
          Collapse groups
        </button>
      )}
    </div>
  );
}

/**
 * Mermaid label text. User-controlled strings (model slugs) become entity references for the
 * characters that would end a label or inject markup.
 */
function label(text: string) {
  return text
    .replaceAll("&", "#amp;")
    .replaceAll('"', "#quot;")
    .replaceAll("<", "#lt;")
    .replaceAll(">", "#gt;");
}

function plural(count: number, word: string) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

const edgeLabels: Partial<Record<LineageKind, (depth: number) => string>> = {
  branch: (depth) => `Branched after message ${depth}`,
  retry: () => "Retried",
  rewrite: (depth) => `Reply rewritten at message ${depth}`,
  compacted: () => "Restarted after compaction",
};

/**
 * Build the flowchart. Each branch lane is a chain of nodes; requests that start a lane, change
 * configuration, fail, are forked from, or are the latest get their own node, and unremarkable
 * continuations between them collapse into one group node unless that group is `expanded`.
 */
function requestTreeChart(data: SessionResult, expanded: ReadonlySet<string>) {
  const entries = new Map<string, Indexed>(
    data.requests.map((entry, index) => [entry._id, { entry, index: index + 1 }]),
  );
  const latest = data.requests.at(-1)?._id;
  const forkSources = new Set(
    data.lanes.flatMap((lane) => (lane.forkRequest ? [lane.forkRequest] : [])),
  );
  const nodeOf = new Map<string, string>();
  const firstNodeOfLane = new Map<string, string>();
  const targets = new Map<string, NodeTarget>();
  const lines = ["flowchart LR"];
  let nodeCount = 0;

  const addRequestNode = ({ entry, index }: Indexed, showModel: boolean) => {
    const id = `n${++nodeCount}`;
    const facts = [plural(entry.newMessages, "new message")];
    if (entry.status !== "ok") facts.push(entry.status === "error" ? "failed" : entry.status);
    if (entry.changedFields.length > 0) {
      facts.push(`${entry.changedFields.map((field) => changeLabel(field)).join(", ")} changed`);
    }
    const model = showModel || entry.changedFields.includes("model") ? entry.model : undefined;
    const text = [
      `<b>Request ${index}</b>`,
      ...(model ? [label(model)] : []),
      label(facts.join(" · ")),
    ];
    lines.push(`  ${id}("${text.join("<br/>")}")`);
    const classes = [
      entry.status !== "ok" ? "failed" : entry.changedFields.length > 0 ? "changed" : "request",
      ...(entry._id === latest ? ["latest"] : []),
    ];
    lines.push(`  class ${id} ${classes.join(",")}`);
    nodeOf.set(entry._id, id);
    targets.set(id, { kind: "request", request: entry._id });
    return id;
  };

  const addGroupNode = (run: Indexed[]) => {
    const id = `n${++nodeCount}`;
    const first = run[0]!;
    const last = run.at(-1)!;
    const added = run.reduce((sum, item) => sum + item.entry.newMessages, 0);
    const text = [
      `<b>Requests ${first.index}–${last.index}</b>`,
      `${plural(run.length, "unchanged request")} · ${plural(added, "message")}`,
      "Click to expand",
    ];
    lines.push(`  ${id}("${text.join("<br/>")}")`, `  class ${id} group`);
    for (const item of run) nodeOf.set(item.entry._id, id);
    targets.set(id, { kind: "group", group: first.entry._id });
    return id;
  };

  // Forks are dotted edges; app.css colours `.edge-pattern-dotted` links.
  const edge = (from: string, to: string, fork?: string) => {
    lines.push(fork ? `  ${from} -.->|"${label(fork)}"| ${to}` : `  ${from} --> ${to}`);
  };

  for (const lane of data.lanes) {
    const laneEntries = lane.requests.flatMap((id) => entries.get(id) ?? []);
    let previous: string | undefined;
    let run: Indexed[] = [];
    const link = (id: string) => {
      if (previous) edge(previous, id);
      else firstNodeOfLane.set(lane.id, id);
      previous = id;
    };
    const flush = () => {
      if (run.length === 1 || (run.length > 1 && expanded.has(run[0]!.entry._id))) {
        for (const item of run) link(addRequestNode(item, false));
      } else if (run.length > 1) {
        link(addGroupNode(run));
      }
      run = [];
    };

    laneEntries.forEach((item, position) => {
      const notable =
        position === 0 ||
        item.entry._id === latest ||
        item.entry.status !== "ok" ||
        item.entry.changedFields.length > 0 ||
        forkSources.has(item.entry._id);
      if (!notable) {
        run.push(item);
        return;
      }
      flush();
      // The model is named where a lane starts and where it changes, not on every node.
      link(addRequestNode(item, position === 0));
    });
    flush();
  }

  for (const lane of data.lanes) {
    const target = firstNodeOfLane.get(lane.id);
    if (!target) continue;
    const describe = edgeLabels[lane.kind];
    if (lane.forkRequest && nodeOf.has(lane.forkRequest)) {
      edge(nodeOf.get(lane.forkRequest)!, target, describe?.(lane.forkDepth) ?? "Continued");
    } else if (lane.kind === "compacted") {
      // A compacted restart follows the session's preceding request in time.
      const first = entries.get(lane.requests[0]!);
      const before = first ? data.requests[first.index - 2] : undefined;
      const source = before && nodeOf.get(before._id);
      if (source) edge(source, target, edgeLabels.compacted!(0));
    }
  }

  // Colours come from the app theme in CSS (`.telemetry-tree` in app.css); these only name classes.
  lines.push(
    "  classDef request stroke-width:1px",
    "  classDef group stroke-width:1px",
    "  classDef changed stroke-width:2px",
    "  classDef failed stroke-width:2px",
    "  classDef latest stroke-width:2px",
  );
  return { chart: lines.join("\n"), targets };
}
