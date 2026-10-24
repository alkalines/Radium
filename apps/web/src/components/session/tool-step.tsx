import { useEffect, useState, type ReactNode } from "react";
import { getToolName, type ToolUIPart } from "ai";
import {
  FilePenLineIcon,
  FilePlusIcon,
  FileTextIcon,
  SearchIcon,
  TerminalIcon,
  WrenchIcon,
  type LucideIcon,
} from "lucide-react";

import { AgentStatus, type RunState } from "@/components/agentic/agent-status";
import { TerminalLog, type TerminalLine } from "@/components/agentic/terminal-log";
import {
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "@/components/ui/trace";
import { JsonCodeBlock, ToolCodeBlock, ToolInputBlock, languageForPath } from "./tool-code";
import {
  getBashResult,
  getInputString,
  getToolInput,
  getToolKind,
  getToolRunState,
  getWebSearchQuery,
  getWebSearchResults,
  getWorkerFailure,
  isDeniedTool,
  type BashResult,
  type ToolKind,
  type WorkerFailure,
} from "./tool-parts";
import { WebSources } from "./web-sources";

/** `Trace` has its own status vocabulary; map RunState onto it in one place. */
export function traceStatusFor(state: RunState) {
  if (state === "thinking" || state === "executing" || state === "streaming") return "running";
  if (state === "awaiting" || state === "queued") return "pending";
  if (state === "failed") return "error";
  return undefined;
}

type ToolPhase = "active" | "awaiting" | "succeeded" | "failed" | "denied" | "stopped";

const toolVerbs: Record<ToolKind, Record<ToolPhase, string>> = {
  bash: {
    active: "Running",
    awaiting: "Run",
    succeeded: "Ran",
    failed: "Failed to run",
    denied: "Denied",
    stopped: "Stopped",
  },
  read: {
    active: "Reading",
    awaiting: "Read",
    succeeded: "Read",
    failed: "Failed to read",
    denied: "Denied reading",
    stopped: "Stopped reading",
  },
  edit: {
    active: "Editing files",
    awaiting: "Edit files",
    succeeded: "Edited files",
    failed: "Failed to edit files",
    denied: "Denied file edit",
    stopped: "Stopped editing files",
  },
  create: {
    active: "Creating",
    awaiting: "Create",
    succeeded: "Created",
    failed: "Failed to create",
    denied: "Denied creating",
    stopped: "Stopped creating",
  },
  "web-search": {
    active: "Searching the web",
    awaiting: "Search the web",
    succeeded: "Searched the web",
    failed: "Failed to search the web",
    denied: "Denied web search",
    stopped: "Stopped searching the web",
  },
  other: {
    active: "Using",
    awaiting: "Use",
    succeeded: "Used",
    failed: "Failed to use",
    denied: "Denied",
    stopped: "Stopped",
  },
};

const toolIcons: Record<ToolKind, LucideIcon> = {
  bash: TerminalIcon,
  read: FileTextIcon,
  edit: FilePenLineIcon,
  create: FilePlusIcon,
  "web-search": SearchIcon,
  other: WrenchIcon,
};

function toolPhase(part: ToolUIPart, state: RunState): ToolPhase {
  if (state === "awaiting") return "awaiting";
  if (state === "succeeded") return "succeeded";
  if (state === "failed") return "failed";
  if (state === "cancelled") return isDeniedTool(part) ? "denied" : "stopped";
  return "active";
}

/** What the call acts on, after the verb: Machine text for commands and paths, prose otherwise. */
function toolObject(part: ToolUIPart, kind: ToolKind): ReactNode {
  const input = getToolInput(part);

  switch (kind) {
    case "bash": {
      const command = getInputString(input, "command");
      return command ? <span className="font-mono text-xs">{command}</span> : null;
    }
    case "read":
    case "create": {
      const path = getInputString(input, "path");
      return path ? <span className="font-mono text-xs">{path}</span> : null;
    }
    case "web-search": {
      const query = getWebSearchQuery(input);
      return query ? `for ${query}` : null;
    }
    case "edit":
      return null;
    case "other":
      return getToolName(part).replaceAll(/[_-]/g, " ");
  }
}

/**
 * One tool call as a Trace step: verb + subject, with the call's input and output in a
 * collapsible body. The body is open while the call runs and closes once it is answered,
 * produces output, or later content follows; the reader can reopen it. Approval prompts render
 * outside the step (`ApprovalGate`), so an awaiting call stays a closed line.
 */
export function ToolStep({
  part,
  isLive,
  hasLaterContent,
}: {
  part: ToolUIPart;
  /** The chat request writing this message is still in flight. */
  isLive: boolean;
  /** Text or other visible content follows this call in the same message. */
  hasLaterContent: boolean;
}) {
  const kind = getToolKind(part);
  const state = getToolRunState(part, isLive);
  const isRunningInput = part.state === "input-streaming" || part.state === "input-available";
  const shouldAutoClose = !isRunningInput || hasLaterContent;
  const [isOpen, setIsOpen] = useState(!shouldAutoClose);

  useEffect(() => {
    if (shouldAutoClose) {
      setIsOpen(false);
    }
  }, [shouldAutoClose]);

  const Icon = toolIcons[kind];
  const object = toolObject(part, kind);
  const title = getToolTitle(part, kind, state);
  const line = (
    <TraceLine status={traceStatusFor(state)} title={title}>
      <TraceIcon>
        <Icon />
      </TraceIcon>
      <TraceTitle>
        {toolVerbs[kind][toolPhase(part, state)]}
        {object ? <> {object}</> : null}
      </TraceTitle>
      {state === "succeeded" ? null : <AgentStatus state={state} hideLabel />}
    </TraceLine>
  );
  if (!hasToolBody(part, kind)) {
    return line;
  }

  return (
    <TraceCollapsible open={isOpen} onOpenChange={setIsOpen}>
      <TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
      <TraceCollapsibleContent className="flex flex-col gap-2">
        <ToolBody part={part} kind={kind} />
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
}

/** Plain-text title for the line's `title` tooltip, since `TraceTitle` truncates long commands. */
function getToolTitle(part: ToolUIPart, kind: ToolKind, state: RunState) {
  const input = getToolInput(part);
  const subject =
    getInputString(input, "command") ?? getInputString(input, "path") ?? getWebSearchQuery(input);
  const verb = toolVerbs[kind][toolPhase(part, state)];
  return subject ? `${verb} ${subject}` : verb;
}

function hasToolBody(part: ToolUIPart, kind: ToolKind) {
  if (kind === "bash" || kind === "edit" || kind === "create" || kind === "other") return true;
  return part.state === "output-available" || part.state === "output-error";
}

function ToolBody({ part, kind }: { part: ToolUIPart; kind: ToolKind }) {
  if (kind === "bash") {
    return (
      <div className="max-h-64 overflow-y-auto rounded-lg bg-muted p-3">
        <TerminalLog lines={bashTerminalLines(part)} />
      </div>
    );
  }

  if (part.state === "output-error") {
    return (
      <>
        {kind === "web-search" || kind === "read" ? null : <ToolInputBlock part={part} />}
        <ToolCodeBlock code={part.errorText} variant="destructive" />
      </>
    );
  }

  const failure = part.state === "output-available" ? getWorkerFailure(part.output) : undefined;

  if (kind === "web-search") {
    if (part.state !== "output-available") return null;

    const results = getWebSearchResults(part.output);
    return results.length > 0 ? (
      <WebSources results={results} />
    ) : (
      <JsonCodeBlock value={part.output} />
    );
  }

  if (kind === "read") {
    if (part.state !== "output-available") return null;
    if (failure) return <FailureBlock failure={failure} />;

    const content = getInputString(part.output, "content");
    const path = getInputString(getToolInput(part), "path");
    if (content === undefined) return <JsonCodeBlock value={part.output} />;
    return (
      <ToolCodeBlock code={content} language={path ? languageForPath(path) : "text"} title={path} />
    );
  }

  return (
    <>
      <ToolInputBlock part={part} />
      {failure ? <FailureBlock failure={failure} /> : null}
      {part.state === "output-available" && !failure ? (
        <JsonCodeBlock value={part.output} title="output" />
      ) : null}
    </>
  );
}

function FailureBlock({ failure }: { failure: WorkerFailure }) {
  const text = failure.message ? `${failure.code}: ${failure.message}` : failure.code;
  return <ToolCodeBlock code={text} variant="destructive" />;
}

/**
 * Terminal lines for a Worker Bash call. The Worker returns stdout and stderr combined, so output
 * lines are all `stdout`; the failure reason (exit code, timeout, receipt code) is `stderr`.
 */
function bashTerminalLines(part: ToolUIPart): TerminalLine[] {
  const id = part.toolCallId;
  const command = getInputString(getToolInput(part), "command") ?? "";
  const lines: TerminalLine[] = [{ id: `${id}-command`, stream: "stdin", text: command }];

  if (part.state === "output-error") {
    lines.push({ id: `${id}-error`, stream: "stderr", text: part.errorText });
    return lines;
  }

  if (part.state !== "output-available") {
    return lines;
  }

  const result = getBashResult(part.output);
  if (!result) {
    lines.push({ id: `${id}-output`, stream: "stdout", text: JSON.stringify(part.output) });
    return lines;
  }

  const output = result.output.endsWith("\n") ? result.output.slice(0, -1) : result.output;
  if (output) {
    output.split("\n").forEach((text, index) => {
      lines.push({ id: `${id}-output-${index}`, stream: "stdout", text });
    });
  }

  if (result.truncated) {
    lines.push({ id: `${id}-truncated`, stream: "system", text: "Output truncated" });
  }

  if (!result.ok) {
    lines.push({ id: `${id}-failure`, stream: "stderr", text: describeBashFailure(result) });
  }

  return lines;
}

function describeBashFailure(result: BashResult) {
  if (result.timedOut) return "Timed out";
  if (result.code === "COMMAND_FAILED" && result.exitCode !== null) {
    return `Exited with code ${result.exitCode}`;
  }
  if (result.code === "COMMAND_CANCELLED") return "Cancelled";

  const code = result.code ?? "FAILED";
  return result.message ? `${code}: ${result.message}` : code;
}
