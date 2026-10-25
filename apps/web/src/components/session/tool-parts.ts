import { getToolName, type ToolUIPart, type UIMessage } from "ai";

import type { RunState } from "@/components/agentic/agent-status";
import { isToolPart } from "./message-parts";

/**
 * Readers for the tool calls Chatroom can make (`packages/backend/src/http/aisdk.chat.ts`): the
 * Radium Worker tools (`src/worker/chat-tools.ts`), Exa web search, and arbitrary MCP tools. Only
 * the Worker write and Bash tools ask for approval.
 */

/** How a tool call renders. `other` covers MCP tools and anything unknown: generic JSON. */
export type ToolKind = "bash" | "read" | "edit" | "create" | "web-search" | "other";

const workerToolKinds: Record<string, ToolKind> = {
  worker_bash: "bash",
  worker_read: "read",
  worker_edit: "edit",
  worker_create: "create",
};

export function getToolKind(part: ToolUIPart): ToolKind {
  const name = getToolName(part);
  const workerKind = workerToolKinds[name];
  if (workerKind) return workerKind;

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

/**
 * RunState of one tool call, mapped once here. `isLive` is true while the chat request that owns
 * this message is in flight; a call left `input-*` after the request stopped was cancelled.
 * Worker tools report their own failure as an `{ ok: false }` output, which counts as failed.
 */
export function getToolRunState(part: ToolUIPart, isLive: boolean): RunState {
  switch (part.state) {
    case "input-streaming":
    case "input-available":
      return isLive ? "executing" : "cancelled";
    case "approval-requested":
      return "awaiting";
    case "approval-responded":
      if (!part.approval.approved) return "cancelled";
      return isLive ? "executing" : "queued";
    case "output-available":
      return getWorkerFailure(part.output) ? "failed" : "succeeded";
    case "output-error":
      return "failed";
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

/** Whether a part shows something to the reader after a tool call, which collapses that call. */
export function hasRenderableAssistantContent(part: UIMessage["parts"][number]) {
  if (part.type === "text") {
    return part.text.trim().length > 0;
  }

  if (part.type === "reasoning") {
    return part.text.trim().length > 0;
  }

  return !isToolPart(part) && part.type !== "step-start";
}
