import { convexQuery } from "@convex-dev/react-query";
import { useQueries } from "@tanstack/react-query";
import type { FunctionReturnType } from "convex/server";
import type { Id } from "backend/convex/_generated/dataModel";
import { blobValue } from "backend/src/telemetry/store";
import { ChevronDownIcon, HistoryIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "backend/convex/_generated/api";
import { DataSection } from "./data-section";
import { MessageView, ToolItem, type TelemetryBlob, type ToolResultView } from "./telemetry-parts";
import { asRecord, messageToolCalls } from "./telemetry-utils";

type RequestResult = FunctionReturnType<typeof api.observability.telemetry.getRequest>;
type MessagePage = FunctionReturnType<typeof api.observability.telemetry.getRequestMessages>;
type ConversationNode = MessagePage["nodes"][number];

const PAGE_SIZE = 20;

/**
 * Everything the model received, in the order it saw it: tool definitions, system
 * instructions, the conversation, then its output. A tool result is shown inside the tool call
 * that requested it rather than as its own message.
 */
export function RequestConversation({
  data,
  title = "Conversation",
  description,
}: {
  data: RequestResult;
  title?: React.ReactNode;
  description?: React.ReactNode;
}) {
  const { request, summary, tools, system, output } = data;
  const changedTools = data.changes?.tools;
  const toolBadges = new Map<string, "added" | "changed">([
    ...(changedTools?.added.map((tool) => [tool.name, "added"] as const) ?? []),
    ...(changedTools?.changed.map((tool) => [tool.name, "changed"] as const) ?? []),
  ]);
  const systemMessages = useMemo(() => {
    const value = blobValue(system);
    return Array.isArray(value) ? value : undefined;
  }, [system]);

  return (
    <DataSection
      title={title}
      description={
        description ??
        "What the model received, in order: tools, system instructions, messages, then its output."
      }
      contentClassName="flex flex-col gap-4 p-3"
    >
      <Part
        label="Tools"
        detail={tools.length ? `${tools.length}` : undefined}
        empty="This request defined no tools."
      >
        {tools.map((tool) => (
          <ToolItem
            key={tool.blob.id}
            name={tool.name}
            blob={tool.blob}
            badge={toolBadges.get(tool.name)}
          />
        ))}
      </Part>

      <Part label="System" empty="No system prompt.">
        {system &&
          (systemMessages
            ? systemMessages.map((message, index) => (
                <MessageView
                  key={index}
                  blob={{ ...system, content: JSON.stringify(message), redacted: false }}
                  highlightNew={false}
                />
              ))
            : [<MessageView key="system" blob={system} highlightNew={false} />])}
      </Part>

      <Part
        label="Messages"
        detail={
          summary.inputDepth > 0
            ? `${summary.inputDepth} · ${Math.max(0, summary.inputDepth - data.prefixDepth)} new${request.recordsInputs ? "" : " · content not recorded"}`
            : undefined
        }
        empty="This request carried no conversation messages."
      >
        {summary.inputDepth > 0 && <ConversationMessages requestId={request._id} />}
      </Part>

      <Part label="Output" empty={outputNote(data)}>
        {output && (
          <MessageView
            blob={output.message}
            depth={output.depth}
            label="output"
            defaultOpen
            highlightNew={false}
          />
        )}
      </Part>
    </DataSection>
  );
}

function outputNote(data: RequestResult) {
  if (data.request.error) return "The request failed before producing output.";
  return data.request.recordsOutputs
    ? "No output was captured."
    : "Output recording was off for this request.";
}

/** One labelled part of the conversation; shows `empty` when it has no children. */
function Part({
  label,
  detail,
  empty,
  children,
}: {
  label: string;
  detail?: string;
  empty: string;
  children: React.ReactNode;
}) {
  const hasContent = Array.isArray(children) ? children.length > 0 : Boolean(children);
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-baseline gap-2 px-1">
        <span className="font-mono text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
        {detail && <span className="font-mono text-[10px] text-muted-foreground">{detail}</span>}
      </div>
      {hasContent ? children : <p className="px-1 text-sm text-muted-foreground">{empty}</p>}
    </section>
  );
}

/**
 * The request's message chain, newest page first, with earlier pages loaded on demand. Pages are
 * merged before rendering so a tool result pairs with its call even across a page boundary.
 */
function ConversationMessages({ requestId }: { requestId: Id<"telemetry_requests"> }) {
  // Cursors of the loaded pages, newest page first.
  const [cursors, setCursors] = useState<(Id<"telemetry_nodes"> | undefined)[]>([undefined]);
  const { error, loaded, oldest, nodes } = useQueries({
    queries: cursors.map((cursor) =>
      convexQuery(api.observability.telemetry.getRequestMessages, {
        request: requestId,
        cursor,
        limit: PAGE_SIZE,
      }),
    ),
    // Runs only when a page result changes, so `nodes` stays stable between renders.
    combine: (pages) => {
      const loaded = pages.every((page) => page.data !== undefined);
      return {
        error: pages.find((page) => page.error)?.error,
        loaded,
        oldest: pages.at(-1)?.data,
        // Pages are newest-first and each page is oldest-first; reverse pages to read forward.
        nodes: loaded ? [...pages].reverse().flatMap((page) => page.data!.nodes) : [],
      };
    },
  });
  const { items, results } = useMemo(() => pairToolResults(nodes), [nodes]);

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{error.message}</AlertDescription>
      </Alert>
    );
  }
  if (!loaded) {
    return (
      <>
        <Skeleton className="h-9" />
        <Skeleton className="h-9" />
      </>
    );
  }

  const total = oldest?.total ?? 0;
  // Everything before the first item this request added (a new message, or an earlier call whose
  // result is new) was already in the conversation; it folds into one accordion.
  const split = items.findIndex((item) => item.fresh);
  const earlier = split === -1 ? items : items.slice(0, split);
  const added = split === -1 ? [] : items.slice(split);
  const earlierCount = total - added.reduce((sum, item) => sum + 1 + item.results, 0);
  const render = (item: ConversationItem) => (
    <MessageView
      key={item.node.id}
      blob={item.node.message}
      depth={item.node.depth}
      isNew={item.node.isNew}
      defaultOpen={item.fresh && item.node.depth >= total - 1}
      toolResults={results}
    />
  );

  return (
    <>
      {earlier.length > 0 && (
        <Collapsible className="overflow-hidden rounded-lg border bg-muted/20">
          <CollapsibleTrigger className="group flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-muted-foreground">
            <HistoryIcon className="size-3.5 shrink-0" />
            <span className="font-medium text-foreground">
              {earlierCount} earlier {earlierCount === 1 ? "message" : "messages"}
            </span>
            <span>already sent in previous requests</span>
            <ChevronDownIcon className="ml-auto size-3 shrink-0 transition-transform group-data-[state=open]:rotate-180" />
          </CollapsibleTrigger>
          <CollapsibleContent className="collapsible-content border-t">
            <div className="flex flex-col gap-2 p-2">
              {oldest?.more && oldest.nextCursor && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="self-center"
                  onClick={() => setCursors((current) => [...current, oldest.nextCursor!])}
                >
                  Load earlier messages
                </Button>
              )}
              {earlier.map(render)}
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}
      {added.map(render)}
    </>
  );
}

type ConversationItem = {
  node: ConversationNode;
  /** Added by this request: the message is new, or one of its tool results is. */
  fresh: boolean;
  /** Tool results folded into this message. */
  results: number;
};

/**
 * Attach each `tool` message to the assistant call with the same `tool_call_id` and drop it from
 * the message list. Results whose call is not loaded (or was not recorded) stay as messages.
 */
function pairToolResults(nodes: ConversationNode[]) {
  const items: ConversationItem[] = [];
  const ownerOf = new Map<string, ConversationItem>();
  for (const node of nodes) {
    const item = { node, fresh: node.isNew, results: 0 };
    const record = asRecord(blobValue(node.message));
    if (record)
      for (const call of messageToolCalls(record)) if (call.id) ownerOf.set(call.id, item);
    items.push(item);
  }

  const results = new Map<string, ToolResultView>();
  const kept: ConversationItem[] = [];
  for (const item of items) {
    const callId = toolCallId(item.node.message);
    const owner = callId ? ownerOf.get(callId) : undefined;
    if (callId && owner) {
      const { node } = item;
      results.set(callId, { blob: node.message, depth: node.depth, isNew: node.isNew });
      owner.results += 1;
      if (node.isNew) owner.fresh = true;
      continue;
    }
    kept.push(item);
  }
  return { items: kept, results };
}

function toolCallId(blob: TelemetryBlob): string | undefined {
  const record = asRecord(blobValue(blob));
  const role = typeof record?.role === "string" ? record.role : blob.meta?.role;
  if (role !== "tool") return undefined;
  const id = record?.tool_call_id ?? blob.meta?.toolCallId;
  return typeof id === "string" ? id : undefined;
}
