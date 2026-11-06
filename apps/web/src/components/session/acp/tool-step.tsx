import { use, useEffect, useMemo, useState } from "react";
import {
  ArrowRightLeftIcon,
  BrainIcon,
  FilePenLineIcon,
  FileTextIcon,
  FileXIcon,
  GlobeIcon,
  SearchIcon,
  TerminalIcon,
  WrenchIcon,
} from "lucide-react";
import { AgentStatus } from "@/components/agentic/agent-status";
import {
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "@/components/ui/trace";
import { Marker, MarkerContent } from "@/components/ui/marker";
import { DiffStats, JsonCodeBlock } from "../tool-code";
import { countDiffLines } from "../tool-diff";
import { getToolRunState } from "../tool-parts";
import { traceStatusFor } from "../tool-step";
import { acpToolKind, type AcpToolPart } from "./parts";
import { AcpSessionFolder } from "./session-folder";
import {
  acpCommand,
  acpDiffFile,
  acpDisplayPath,
  acpRawValue,
  acpToolSubject,
} from "./tool-content";
import { AcpToolContentBlock } from "./tool-content-block";

const visuals = {
  read: { icon: FileTextIcon, verbs: ["Reading", "Read", "Failed to read", "Stopped reading"] },
  edit: {
    icon: FilePenLineIcon,
    verbs: ["Editing", "Edited", "Failed to edit", "Stopped editing"],
  },
  delete: {
    icon: FileXIcon,
    verbs: ["Deleting", "Deleted", "Failed to delete", "Stopped deleting"],
  },
  move: {
    icon: ArrowRightLeftIcon,
    verbs: ["Moving", "Moved", "Failed to move", "Stopped moving"],
  },
  search: {
    icon: SearchIcon,
    verbs: ["Searching", "Searched", "Failed to search", "Stopped searching"],
  },
  execute: { icon: TerminalIcon, verbs: ["Running", "Ran", "Failed to run", "Stopped"] },
  fetch: { icon: GlobeIcon, verbs: ["Fetching", "Fetched", "Failed to fetch", "Stopped fetching"] },
  think: { icon: BrainIcon, verbs: ["", "", "", ""] },
  switch_mode: { icon: ArrowRightLeftIcon, verbs: ["", "", "", ""] },
  other: { icon: WrenchIcon, verbs: ["", "", "", ""] },
} as const;

/** Word stems that show an agent's title already names the kind's action. */
const actionStems: Record<keyof typeof visuals, readonly string[]> = {
  read: ["read"],
  edit: ["edit"],
  delete: ["delet"],
  move: ["mov"],
  search: ["search"],
  execute: ["run", "ran"],
  fetch: ["fetch"],
  think: [],
  switch_mode: [],
  other: [],
};

/** ACP uses its reported status, not the browser stream's liveness or built-in receipts. */
export function AcpToolStep({
  part,
  hasLaterContent,
}: {
  part: AcpToolPart;
  hasLaterContent: boolean;
}) {
  const { item } = part.acp;
  const cwd = use(AcpSessionFolder);
  const kind = acpToolKind(item);
  const state = getToolRunState(part, false);
  const active = state === "queued" || state === "executing";
  const autoClose = !active || hasLaterContent;
  const [open, setOpen] = useState(!autoClose);
  useEffect(() => {
    if (autoClose) setOpen(false);
  }, [autoClose]);
  // A truncated item's diffs miss their tail, so its counts would mislead.
  const counts = useMemo(
    () =>
      item.truncated
        ? { added: 0, removed: 0 }
        : countDiffLines(
            (item.content ?? []).flatMap((content) =>
              content.type === "diff" ? acpDiffFile(content).lines : [],
            ),
          ),
    [item.content, item.truncated],
  );
  const { icon: Icon, verbs } = visuals[kind];
  const subject = acpToolSubject(item, cwd);
  // A title that already names this kind's action ("Reading config", "read: a.ts") would read twice.
  const titleWord = subject.isTitle ? (/^[a-z]+/i.exec(subject.text)?.[0] ?? "").toLowerCase() : "";
  const repeatsVerb =
    titleWord !== "" && actionStems[kind].some((stem) => titleWord.startsWith(stem));
  const verb = repeatsVerb
    ? ""
    : verbs[state === "succeeded" ? 1 : state === "failed" ? 2 : state === "cancelled" ? 3 : 0];
  const machine =
    !subject.isTitle && ["read", "edit", "delete", "move", "execute", "fetch"].includes(kind);
  // Paths of file kinds are the step's subject; other kinds list theirs in the body.
  const fileKind = kind === "read" || kind === "edit" || kind === "delete" || kind === "move";
  const firstPath = item.locations?.[0]?.path;
  if (kind === "switch_mode")
    return (
      <Marker className="text-xs">
        <Icon />
        <MarkerContent>
          {item.title}
          {item.truncated ? (
            <span className="ml-2 text-muted-foreground">
              Output truncated; the full output stays in the agent.
            </span>
          ) : null}
        </MarkerContent>
      </Marker>
    );
  const line = (
    <TraceLine
      status={traceStatusFor(state)}
      title={verb ? `${verb} ${subject.text}` : subject.text}
    >
      <TraceIcon>
        <Icon />
      </TraceIcon>
      <TraceTitle>
        {verb ? `${verb} ` : ""}
        <span className={machine ? "font-mono text-xs" : undefined}>{subject.text}</span>
      </TraceTitle>
      {kind === "edit" && (counts.added || counts.removed) ? (
        <TraceDescription>
          <DiffStats {...counts} />
        </TraceDescription>
      ) : null}
      {state !== "succeeded" ? <AgentStatus state={state} hideLabel /> : null}
    </TraceLine>
  );
  const listsLocations = Boolean(item.locations?.length) && (!fileKind || subject.isTitle);
  const hasBody = Boolean(
    item.content?.length ||
    item.rawInput !== undefined ||
    item.rawOutput !== undefined ||
    listsLocations ||
    item.truncated ||
    kind === "execute",
  );
  if (!hasBody) return line;
  return (
    <TraceCollapsible open={open} onOpenChange={setOpen}>
      <TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
      <TraceCollapsibleContent className="flex flex-col gap-2">
        {listsLocations ? (
          <div className="flex flex-col gap-1">
            {item.locations!.map((location, index) => (
              <p key={index} className="break-all font-mono text-xs text-muted-foreground">
                {acpDisplayPath(location.path, cwd)}
                {location.line !== undefined ? `:${location.line}` : ""}
              </p>
            ))}
          </div>
        ) : null}
        <AcpToolContentBlock
          content={item.content ?? []}
          // A read's text is that file; an edit's text is one only when the agent numbered it (a
          // preview of the changed lines). Any other text is the tool's own output.
          path={kind === "read" && firstPath ? acpDisplayPath(firstPath, cwd) : undefined}
          excerptPath={kind === "edit" && firstPath ? acpDisplayPath(firstPath, cwd) : undefined}
          startLine={item.locations?.[0]?.line}
          terminal={kind === "execute"}
          command={kind === "execute" ? acpCommand(item) : undefined}
          reasoning={kind === "think"}
          partial={item.truncated}
        />
        {!item.content?.length ? (
          <>
            {item.rawInput !== undefined ? (
              <JsonCodeBlock value={acpRawValue(item.rawInput)} title="input" />
            ) : null}
            {item.rawOutput !== undefined ? (
              <JsonCodeBlock value={acpRawValue(item.rawOutput)} title="output" />
            ) : null}
          </>
        ) : null}
        {item.truncated ? (
          <p className="text-xs text-muted-foreground">
            Output truncated; the full output stays in the agent.
          </p>
        ) : null}
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
}
