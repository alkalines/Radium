import { getToolName, isToolUIPart, type ToolUIPart, type UIMessage } from "ai";
import type {
  CodeModeCall,
  CodeModeInteraction,
  CodeModeOutput,
} from "backend/src/chatroom/code-mode";
import type { QuestionOutput, QuestionPrompt, TodoItem } from "backend/src/chatroom/session-tools";

import type { RunState } from "@/components/agentic/agent-status";
import { isToolPart } from "./message-parts";
import { acpToolKind, isAcpToolPart, type AcpToolKind, type AcpToolPart } from "./acp/parts";

/**
 * Readers for the tool calls Chatroom can make (`packages/backend/src/http/aisdk.chat.ts`): the
 * session tools (`src/chatroom/session-tools.ts`), the Radium Worker tools
 * (`src/worker/chat-tools.ts`), Exa web search, and arbitrary MCP tools. Only the Worker write and
 * Bash tools ask for approval; `question` waits for the user's answer instead.
 */

/** How a tool call renders. `other` covers MCP tools and anything unknown: generic JSON. */
export type BuiltinToolKind =
  | "code"
  | "bash"
  | "read"
  | "edit"
  | "create"
  | "web-search"
  | "question"
  | "todo"
  | "other";

/** ACP kinds share the Trace renderer, but never go through built-in tool protocol readers. */
export type ToolKind = BuiltinToolKind | AcpToolKind;

const namedToolKinds: Record<string, BuiltinToolKind> = {
  execute: "code",
  question: "question",
  todo_write: "todo",
  worker_bash: "bash",
  worker_read: "read",
  worker_edit: "edit",
  worker_create: "create",
};

/** A synthesized inner call keeps its interaction identity outside the AI SDK approval protocol. */
export type CodeModeToolPart = ToolUIPart & { codeModeInteraction?: CodeModeInteraction };

/** Reads the latest full Code Mode snapshot; unfinished input and legacy outputs have none. */
export function getCodeModeOutput(part: ToolUIPart): CodeModeOutput | undefined {
  if (getToolName(part) !== "execute" || part.state !== "output-available") return undefined;
  const output = part.output;
  if (typeof output !== "object" || output === null) return undefined;
  if (!("calls" in output) || !Array.isArray(output.calls)) return undefined;
  if (!("output" in output) || typeof output.output !== "string") return undefined;
  return output as CodeModeOutput;
}

/** Adapts an inner call to the normal tool renderers without inventing an output receipt. */
export function codeModeCallPart(call: CodeModeCall): CodeModeToolPart {
  const base = {
    type: `tool-${call.tool}` as const,
    toolCallId: call.id,
    input: call.input,
    codeModeInteraction: call.interaction,
  };
  switch (call.status) {
    case "running":
      return { ...base, state: "input-available" };
    case "awaiting":
      if (call.interaction?.kind === "approval") {
        return { ...base, state: "approval-requested", approval: { id: call.interaction.id } };
      }
      return { ...base, state: "input-available" };
    case "completed":
      return { ...base, state: "output-available", output: undefined };
    case "error":
      return { ...base, state: "output-error", errorText: call.error ?? "Tool call failed." };
    case "denied":
      return {
        ...base,
        state: "output-denied",
        approval: { id: call.id, approved: false, reason: call.error },
      };
  }
}

/** Selects a tool's existing per-tool visuals; namespaced MCP paths stay generic. */
export function getToolKind(part: ToolUIPart | AcpToolPart): ToolKind {
  if (isAcpToolPart(part)) return acpToolKind(part.acp.item);
  const name = getToolName(part);
  const namedKind = namedToolKinds[name];
  if (namedKind) return namedKind;

  if (name.replaceAll(/[_-]/g, "").toLowerCase() === "websearch") return "web-search";
  return "other";
}

/** The tool's input, falling back to the raw (unparsed) input of a call that failed validation. */
export function getToolInput(part: ToolUIPart): unknown {
  if (part.input !== undefined) {
    return part.input;
  }

  return "rawInput" in part ? part.rawInput : {};
}

/** Reads one string field from a tool input object, e.g. the Bash `command` or a file `path`. */
export function getInputString(input: unknown, key: string) {
  if (typeof input !== "object" || input === null || !(key in input)) return undefined;

  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

/** Reads one number field from a tool input or output object, e.g. a read's `startLine`. */
export function getInputNumber(input: unknown, key: string) {
  if (typeof input !== "object" || input === null || !(key in input)) return undefined;

  const value = (input as Record<string, unknown>)[key];
  return typeof value === "number" ? value : undefined;
}

/**
 * RunState of one tool call, mapped once here. `isLive` is true while the chat request that owns
 * this message is in flight; a call left `input-*` after the request stopped was cancelled, except
 * a `question`, which has no server execution and waits for the user's answer.
 * Worker tools report their own failure as an `{ ok: false }` output, which counts as failed.
 */
export function getToolRunState(part: ToolUIPart | AcpToolPart, isLive: boolean): RunState {
  if (isAcpToolPart(part)) {
    const { item, turnCancelled } = part.acp;
    if (item.status === "completed") return "succeeded";
    if (item.status === "failed") return "failed";
    if (turnCancelled) return "cancelled";
    return item.status === "in_progress" ? "executing" : "queued";
  }
  const snapshot = getCodeModeOutput(part);
  if (snapshot) {
    if (snapshot.calls.some((call) => call.status === "awaiting")) {
      return isLive ? "awaiting" : "cancelled";
    }
    if (part.state === "output-available" && part.preliminary) {
      return isLive ? "executing" : "cancelled";
    }
    if (snapshot.error) return "failed";
  }
  switch (part.state) {
    case "input-streaming":
      return isLive ? "streaming" : "cancelled";
    case "input-available":
      if (getToolKind(part) === "question") return "awaiting";
      return isLive ? "executing" : "cancelled";
    case "approval-requested":
      return "awaiting";
    case "approval-responded":
      if (!part.approval.approved) return "cancelled";
      return isLive ? "executing" : "queued";
    case "output-available":
      return getWorkerFailure(part.output) ? "failed" : "succeeded";
    case "output-error":
      // A dismissed question is the user's choice, not a failure.
      return getToolKind(part) === "question" ? "cancelled" : "failed";
    case "output-denied":
      return "cancelled";
  }
}

/** True when the user denied this call (before or after the SDK recorded the denial). */
export function isDeniedTool(part: ToolUIPart) {
  if (part.state === "output-denied") return true;
  return part.state === "approval-responded" && !part.approval.approved;
}

/** A Worker receipt that reports failure: `{ ok: false, code, message? }`. */
export type WorkerFailure = { code: string; message?: string };

export function getWorkerFailure(output: unknown): WorkerFailure | undefined {
  if (typeof output !== "object" || output === null || !("ok" in output) || output.ok !== false) {
    return undefined;
  }

  const code = "code" in output && typeof output.code === "string" ? output.code : "FAILED";
  const message =
    "message" in output && typeof output.message === "string" ? output.message : undefined;
  return { code, message };
}

/** The Worker Bash receipt (`packages/worker/src/bash/service.ts`): combined output, not split streams. */
export type BashResult = {
  ok: boolean;
  code?: string;
  message?: string;
  exitCode: number | null;
  timedOut: boolean;
  output: string;
  truncated: boolean;
};

export function getBashResult(output: unknown): BashResult | undefined {
  if (typeof output !== "object" || output === null || !("ok" in output)) return undefined;

  const record = output as Record<string, unknown>;
  if (typeof record.ok !== "boolean") return undefined;

  return {
    ok: record.ok,
    code: typeof record.code === "string" ? record.code : undefined,
    message: typeof record.message === "string" ? record.message : undefined,
    exitCode: typeof record.exitCode === "number" ? record.exitCode : null,
    timedOut: record.timedOut === true,
    output: typeof record.output === "string" ? record.output : "",
    truncated: record.truncated === true,
  };
}

/** The search query (or comma-joined queries) a web search call ran. */
export function getWebSearchQuery(input: unknown) {
  if (typeof input !== "object" || !input) return undefined;
  if ("query" in input && typeof input.query === "string") return input.query;
  if ("queries" in input && Array.isArray(input.queries)) {
    return input.queries.filter((query): query is string => typeof query === "string").join(", ");
  }
  return undefined;
}

export type WebSearchResult = { url: string; title: string; favicon?: string };

/** Links from an Exa web search output; results without a URL are skipped. */
export function getWebSearchResults(output: unknown): WebSearchResult[] {
  if (typeof output !== "object" || output === null || !("results" in output)) {
    return [];
  }

  if (!Array.isArray(output.results)) {
    return [];
  }

  return output.results.flatMap((result) => {
    if (typeof result !== "object" || result === null) {
      return [];
    }

    const url = "url" in result && typeof result.url === "string" ? result.url : undefined;
    if (!url) {
      return [];
    }

    return [
      {
        url,
        title:
          "title" in result && typeof result.title === "string" && result.title
            ? result.title
            : url,
        favicon:
          "favicon" in result && typeof result.favicon === "string" ? result.favicon : undefined,
      },
    ];
  });
}

/** The questions of a `question` call input, as far as it has streamed; entries without text are skipped. */
export function getQuestionPrompts(input: unknown): QuestionPrompt[] {
  if (typeof input !== "object" || input === null || !("questions" in input)) return [];
  if (!Array.isArray(input.questions)) return [];

  return input.questions.flatMap((entry: unknown) => {
    const question = getInputString(entry, "question");
    if (!question) return [];

    const record = entry as Record<string, unknown>;
    const options = Array.isArray(record.options)
      ? record.options.flatMap((option: unknown) => {
          const label = getInputString(option, "label");
          if (!label) return [];
          return [{ label, description: getInputString(option, "description") }];
        })
      : [];
    return [
      {
        question,
        header: getInputString(entry, "header") ?? "",
        options,
        multiple: record.multiple === true,
      },
    ];
  });
}

/** The user's answers from a `question` output, one string list per question. */
export function getQuestionAnswers(output: unknown): QuestionOutput["answers"] | undefined {
  if (typeof output !== "object" || output === null || !("answers" in output)) return undefined;
  if (!Array.isArray(output.answers)) return undefined;

  return output.answers.map((answer: unknown) =>
    Array.isArray(answer) ? answer.filter((value) => typeof value === "string") : [],
  );
}

const todoStatuses: Record<string, TodoItem["status"]> = {
  pending: "pending",
  in_progress: "in_progress",
  completed: "completed",
};

/** The list of a `todo_write` call input; a status that has not streamed yet reads as pending. */
export function getTodoItems(input: unknown): TodoItem[] {
  if (typeof input !== "object" || input === null || !("todos" in input)) return [];
  if (!Array.isArray(input.todos)) return [];

  return input.todos.flatMap((entry: unknown) => {
    const content = getInputString(entry, "content");
    if (!content) return [];

    const status = todoStatuses[getInputString(entry, "status") ?? ""] ?? "pending";
    return [{ content, status }];
  });
}

/**
 * The Session's current todo list: the latest non-rejected direct `todo_write` input or completed
 * inner `todo_write` input, ordered by message, part, then inner-call order. A call still streaming
 * keeps the previous list on screen. Undefined when the model never wrote one.
 */
export function getLatestTodos(messages: UIMessage[]): TodoItem[] | undefined {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex--) {
    const parts = messages[messageIndex]?.parts ?? [];
    for (let partIndex = parts.length - 1; partIndex >= 0; partIndex--) {
      const part = parts[partIndex];
      if (!part || !isToolPart(part)) continue;
      const snapshot = getCodeModeOutput(part);
      if (snapshot) {
        const call = snapshot.calls.findLast(
          (call) => call.tool === "todo_write" && call.status === "completed",
        );
        if (call) return getTodoItems(call.input);
      }
      if (getToolKind(part) !== "todo") continue;
      if (part.state === "input-streaming" || part.state === "output-error" || isDeniedTool(part)) {
        continue;
      }

      return getTodoItems(part.input);
    }
  }
  return undefined;
}

/** Whether a part shows something to the reader after a tool call, which collapses that call. */
export function hasRenderableAssistantContent(part: UIMessage["parts"][number]) {
  if (part.type === "text") {
    return part.text.trim().length > 0;
  }

  if (part.type === "reasoning") {
    return part.text.trim().length > 0;
  }

  return !isToolUIPart(part) && part.type !== "step-start";
}
