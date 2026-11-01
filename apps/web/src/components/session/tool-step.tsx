import { useEffect, useState, type ReactNode } from "react";
import { getToolName, type ToolUIPart } from "ai";
import {
  CodeXmlIcon,
  FilePenLineIcon,
  FilePlusIcon,
  FileTextIcon,
  ListTodoIcon,
  MessageCircleQuestionIcon,
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
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
  Trace,
} from "@/components/ui/trace";
import { TodoList } from "./todo-list";
import {
  DiffCodeBlock,
  DiffStats,
  JsonCodeBlock,
  ToolCodeBlock,
  ToolInputBlock,
  countContentLines,
  languageForPath,
} from "./tool-code";
import { countDiffLines, getReceiptFiles, parseNumberedRead, parsePatch } from "./tool-diff";
import {
  codeModeCallPart,
  getCodeModeOutput,
  getBashResult,
  getInputNumber,
  getInputString,
  getQuestionAnswers,
  getQuestionPrompts,
  getTodoItems,
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
  code: {
    active: "Running code",
    awaiting: "Running code",
    succeeded: "Ran code",
    failed: "Failed to run code",
    denied: "Denied code",
    stopped: "Stopped code",
  },
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
    active: "Editing",
    awaiting: "Edit",
    succeeded: "Edited",
    failed: "Failed to edit",
    denied: "Denied editing",
    stopped: "Stopped editing",
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
  question: {
    active: "Asking",
    awaiting: "Waiting for your answer to",
    succeeded: "Asked",
    failed: "Failed to ask",
    denied: "Denied asking",
    stopped: "Dismissed",
  },
  todo: {
    active: "Updating todos",
    awaiting: "Update todos",
    succeeded: "Updated todos",
    failed: "Failed to update todos",
    denied: "Denied updating todos",
    stopped: "Stopped updating todos",
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
  code: CodeXmlIcon,
  bash: TerminalIcon,
  read: FileTextIcon,
  edit: FilePenLineIcon,
  create: FilePlusIcon,
  "web-search": SearchIcon,
  question: MessageCircleQuestionIcon,
  todo: ListTodoIcon,
  other: WrenchIcon,
};

function toolPhase(part: ToolUIPart, state: RunState): ToolPhase {
  if (state === "awaiting") return "awaiting";
  if (state === "succeeded") return "succeeded";
  if (state === "failed") return "failed";
  if (state === "cancelled") return isDeniedTool(part) ? "denied" : "stopped";
  return "active";
}

/** The files an edit touches: the receipt's once applied, otherwise the patch's (as it streams). */
function editFiles(part: ToolUIPart) {
  if (part.state === "output-available" && !getWorkerFailure(part.output)) {
    const files = getReceiptFiles(part.output);
    if (files && files.length > 0) return files;
  }
  return parsePatch(getInputString(getToolInput(part), "patch") ?? "");
}

/** Plain-text subject after the verb: a command, a path, a query, or a count. */
function toolSubject(part: ToolUIPart, kind: ToolKind): string | undefined {
  const input = getToolInput(part);

  switch (kind) {
    case "code": {
      const calls = getCodeModeOutput(part)?.calls ?? [];
      return `${calls.length} tool ${calls.length === 1 ? "call" : "calls"}`;
    }
    case "bash":
      return getInputString(input, "command");
    case "read":
    case "create":
      return getInputString(input, "path");
    case "edit": {
      const files = editFiles(part);
      const first = files[0]?.path;
      if (!first) return "files";
      return files.length > 1 ? `${first} and ${files.length - 1} more` : first;
    }
    case "web-search": {
      const query = getWebSearchQuery(input);
      return query ? `for ${query}` : undefined;
    }
    case "question": {
      const questions = getQuestionPrompts(input);
      if (questions.length === 1) return questions[0]?.header || "a question";
      return questions.length > 1 ? `${questions.length} questions` : undefined;
    }
    case "todo":
      return undefined;
    case "other":
      return getToolName(part).replaceAll(/[_-]/g, " ");
  }
}

/** Kinds whose subject is Machine text (commands and paths) rather than prose. */
const machineSubjects: Record<ToolKind, boolean> = {
  code: false,
  bash: true,
  read: true,
  edit: true,
  create: true,
  "web-search": false,
  question: false,
  todo: false,
  other: false,
};

/** Trailing line detail: change counts for writes, a read's line range, todo progress. */
function toolDetail(part: ToolUIPart, kind: ToolKind): ReactNode {
  const input = getToolInput(part);

  switch (kind) {
    case "edit": {
      const lines = editFiles(part).flatMap((file) => file.lines);
      const counts = countDiffLines(lines);
      if (counts.added === 0 && counts.removed === 0) return null;
      return <DiffStats {...counts} />;
    }
    case "create": {
      const content = getInputString(input, "content");
      if (content === undefined) return null;
      return <DiffStats added={countContentLines(content)} removed={0} />;
    }
    case "read": {
      const start = getInputNumber(input, "startLine");
      if (start === undefined) return null;
      const maxLines = getInputNumber(input, "maxLines");
      const range = maxLines === undefined ? `${start}–` : `${start}–${start + maxLines - 1}`;
      return <span className="font-mono text-xs">L{range}</span>;
    }
    case "todo": {
      const items = getTodoItems(input);
      if (items.length === 0) return null;
      const done = items.filter((item) => item.status === "completed").length;
      return `${done}/${items.length} done`;
    }
    case "bash":
    case "code":
    case "web-search":
    case "question":
    case "other":
      return null;
  }
}

/**
 * One tool call as a Trace step: verb + subject (+ change counts or progress), with the call's
 * input and output in a collapsible body. The body is open while the model writes the call and
 * while it runs, so its input renders live as it streams (a command, file content, a patch as a
 * diff, a todo list); it closes once the call is answered, produces output, or later content
 * follows, and the reader can reopen it. Approval and question prompts take the Composer's place
 * (`ApprovalPrompt`, `QuestionPrompt`), so a call awaiting the user stays a closed line.
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
  const isRunningInput =
    (part.state === "input-streaming" ||
      part.state === "input-available" ||
      (kind === "code" && part.state === "output-available" && part.preliminary)) &&
    state !== "awaiting";
  const shouldAutoClose = !isRunningInput || hasLaterContent;
  const [isOpen, setIsOpen] = useState(!shouldAutoClose);

  useEffect(() => {
    if (shouldAutoClose) {
      setIsOpen(false);
    }
  }, [shouldAutoClose]);

  const Icon = toolIcons[kind];
  const verb = toolVerbs[kind][toolPhase(part, state)];
  const subject = toolSubject(part, kind);
  const detail = toolDetail(part, kind);
  // A file write, edit, or todo update in progress already shows its live content and a
  // shimmering verb; the running dot beside it is noise. Other states keep their dot.
  const isActiveWrite =
    (kind === "edit" || kind === "create" || kind === "todo") &&
    (state === "streaming" || state === "executing");
  const showStatus = state !== "succeeded" && !isActiveWrite;
  const line = (
    <TraceLine status={traceStatusFor(state)} title={subject ? `${verb} ${subject}` : verb}>
      <TraceIcon>
        <Icon />
      </TraceIcon>
      <TraceTitle>
        {verb}
        {subject ? (
          <>
            {" "}
            <span className={machineSubjects[kind] ? "font-mono text-xs" : undefined}>
              {subject}
            </span>
          </>
        ) : null}
      </TraceTitle>
      {detail ? <TraceDescription>{detail}</TraceDescription> : null}
      {showStatus ? (
        <AgentStatus
          state={state}
          label={kind === "question" && state === "awaiting" ? "awaiting answer" : undefined}
          hideLabel
        />
      ) : null}
    </TraceLine>
  );
  if (!hasToolBody(part, kind)) {
    return line;
  }

  return (
    <TraceCollapsible open={isOpen} onOpenChange={setIsOpen}>
      <TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
      <TraceCollapsibleContent className="flex flex-col gap-2">
        <ToolBody part={part} kind={kind} state={state} isLive={isLive} />
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
}

function hasToolBody(part: ToolUIPart, kind: ToolKind) {
  switch (kind) {
    case "code":
    case "bash":
    case "edit":
    case "create":
    case "todo":
    case "other":
      return true;
    case "question":
      return part.state === "output-available";
    case "read":
    case "web-search":
      return part.state === "output-available" || part.state === "output-error";
  }
}

function ToolBody({
  part,
  kind,
  state,
  isLive,
}: {
  part: ToolUIPart;
  kind: ToolKind;
  state: RunState;
  isLive: boolean;
}) {
  if (kind === "code") {
    const snapshot = getCodeModeOutput(part);
    return (
      <>
        <ToolInputBlock part={part} />
        {snapshot?.calls.length ? (
          <Trace>
            {snapshot.calls.map((call) => (
              <ToolStep
                key={call.id}
                part={codeModeCallPart(call)}
                isLive={isLive && part.state === "output-available" && part.preliminary === true}
                hasLaterContent={false}
              />
            ))}
          </Trace>
        ) : null}
        {snapshot?.output ? (
          <ToolCodeBlock
            code={snapshot.output}
            title="output"
            variant={snapshot.error ? "destructive" : "default"}
          />
        ) : null}
        {part.state === "output-error" ? (
          <ToolCodeBlock code={part.errorText} variant="destructive" />
        ) : null}
      </>
    );
  }
  if (kind === "bash") {
    return (
      <div className="max-h-64 overflow-y-auto rounded-xl bg-muted p-3">
        <TerminalLog lines={bashTerminalLines(part, state)} />
      </div>
    );
  }

  if (kind === "todo") {
    const items = getTodoItems(getToolInput(part));
    if (items.length === 0) return <p className="text-xs text-muted-foreground">No todos.</p>;
    return <TodoList items={items} className="py-0.5 pl-1" />;
  }

  if (kind === "question") {
    return <QuestionAnswers part={part} />;
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
    if (part.state !== "output-available" || part.output === undefined) return null;

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
    return <ReadOutput part={part} />;
  }

  if (kind === "edit" && part.state === "output-available" && !failure) {
    const files = getReceiptFiles(part.output);
    if (files && files.length > 0) {
      return files.map((file, index) => (
        <DiffCodeBlock key={`${file.path}-${index}`} file={file} />
      ));
    }
  }

  return (
    <>
      <ToolInputBlock part={part} />
      {failure ? <FailureBlock failure={failure} /> : null}
      {kind === "other" && part.state === "output-available" && part.output !== undefined ? (
        <JsonCodeBlock value={part.output} title="output" />
      ) : null}
    </>
  );
}

/** A `worker_read` result: the file's lines numbered from where the read started. */
function ReadOutput({ part }: { part: ToolUIPart & { state: "output-available" } }) {
  const content = getInputString(part.output, "content");
  if (content === undefined) {
    return part.output === undefined ? null : <JsonCodeBlock value={part.output} />;
  }

  const path = getInputString(getToolInput(part), "path");
  const { startLine, text } = parseNumberedRead(content);
  const nextLine = getInputNumber(part.output, "nextLine");
  const footer = nextLine === undefined ? undefined : `Truncated · continues at line ${nextLine}`;

  return (
    <ToolCodeBlock
      code={text}
      language={path ? languageForPath(path) : "text"}
      title={path}
      startLine={startLine}
      footer={footer}
    />
  );
}

/** Each question of an answered `question` call with the user's answers. */
function QuestionAnswers({ part }: { part: ToolUIPart }) {
  const questions = getQuestionPrompts(getToolInput(part));
  const answers = part.state === "output-available" ? getQuestionAnswers(part.output) : undefined;

  return (
    <dl className="flex flex-col gap-2 pl-1 text-[13px]">
      {questions.map((question, index) => {
        const answer = answers?.[index];
        return (
          <div key={index} className="flex min-w-0 flex-col">
            <dt className="text-muted-foreground">{question.question}</dt>
            <dd className={answer?.length ? "text-foreground" : "text-muted-foreground italic"}>
              {answer === undefined
                ? "Answers not retained"
                : answer.length > 0
                  ? answer.join(", ")
                  : "Unanswered"}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

function FailureBlock({ failure }: { failure: WorkerFailure }) {
  const text = failure.message ? `${failure.code}: ${failure.message}` : failure.code;
  return <ToolCodeBlock code={text} variant="destructive" />;
}

/**
 * Terminal lines for a Worker Bash call. The command streams in as the model writes it; once it
 * runs, a system line marks the wait until the Worker returns. The Worker returns stdout and
 * stderr combined, so output lines are all `stdout`; the failure reason (exit code, timeout,
 * receipt code) is `stderr`.
 */
function bashTerminalLines(part: ToolUIPart, state: RunState): TerminalLine[] {
  const id = part.toolCallId;
  const command = getInputString(getToolInput(part), "command") ?? "";
  const lines: TerminalLine[] = [{ id: `${id}-command`, stream: "stdin", text: command }];

  if (part.state === "output-error") {
    lines.push({ id: `${id}-error`, stream: "stderr", text: part.errorText });
    return lines;
  }

  if (part.state !== "output-available") {
    if (state === "executing" && part.state !== "input-streaming") {
      lines.push({ id: `${id}-running`, stream: "system", text: "Running on the Worker…" });
    }
    return lines;
  }

  const result = getBashResult(part.output);
  if (!result) {
    if (part.output !== undefined) {
      lines.push({ id: `${id}-output`, stream: "stdout", text: JSON.stringify(part.output) });
    }
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
