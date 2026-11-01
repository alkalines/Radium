import {
  getToolName,
  isToolUIPart,
  type FileUIPart,
  type LanguageModelUsage,
  type ToolUIPart,
  type UIMessage,
} from "ai";
import { codeModeCallPart, getCodeModeOutput, type CodeModeToolPart } from "./tool-parts";

/**
 * Pure readers over AI SDK `UIMessage`s for the Session screen and thread. Metadata fields
 * (`usage`, `performance`, `model`, `provider`) are written by the Chatroom handler
 * (`packages/backend/src/http/aisdk.chat.ts`); every reader tolerates their absence because
 * persisted chats predate some of them.
 */

/** Narrows a message part to a tool call (static or dynamic tool). */
export function isToolPart(part: UIMessage["parts"][number]): part is ToolUIPart {
  return isToolUIPart(part);
}

/** Joins all text parts of a message into a single copy/edit-friendly string. */
export function getMessageText(message: UIMessage) {
  return message.parts
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n\n");
}

/** Extracts attachment parts from a message so forks/edits keep their files. */
export function getMessageFiles(message: UIMessage): FileUIPart[] {
  return message.parts.filter(
    (part): part is FileUIPart => part.type === "file" && Boolean((part as FileUIPart).url),
  );
}

/** Reads the cumulative token usage attached to an assistant message, if any. */
export function getUsageMetadata(metadata: UIMessage["metadata"]): LanguageModelUsage | undefined {
  if (typeof metadata === "object" && metadata !== null && "usage" in metadata) {
    const { usage } = metadata as { usage?: LanguageModelUsage };
    return usage;
  }

  return undefined;
}

/** Generation performance the Chatroom handler records on an assistant message. */
export type MessagePerformance = {
  /** Average output tokens per second across the turn's API requests. */
  averageTps: number;
  generationTimeMs: number;
  requestCount: number;
};

/** Reads generation performance from an assistant message; undefined unless every field is a number. */
export function getPerformanceMetadata(
  metadata: UIMessage["metadata"],
): MessagePerformance | undefined {
  if (typeof metadata !== "object" || !metadata || !("performance" in metadata)) {
    return undefined;
  }
  const performance = metadata.performance;
  if (
    typeof performance !== "object" ||
    !performance ||
    !("averageTps" in performance) ||
    !("generationTimeMs" in performance) ||
    !("requestCount" in performance) ||
    typeof performance.averageTps !== "number" ||
    typeof performance.generationTimeMs !== "number" ||
    typeof performance.requestCount !== "number"
  ) {
    return undefined;
  }
  return performance as MessagePerformance;
}

/** The model slug one message recorded (assistant turns), if any. */
export function getMessageModel(message: UIMessage) {
  return isModelMetadata(message.metadata) ? message.metadata.model : undefined;
}

/** The model slug of the most recent message that recorded one, scanning from the end. */
export function getLastMessageModel(messages: UIMessage[]) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const metadata = messages[index]?.metadata;

    if (isModelMetadata(metadata)) {
      return metadata.model;
    }
  }

  return undefined;
}

/** The provider id of the most recent message that recorded one, scanning from the end. */
export function getLastMessageProvider(messages: UIMessage[]) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const metadata = messages[index]?.metadata;
    if (
      typeof metadata === "object" &&
      metadata !== null &&
      "provider" in metadata &&
      typeof metadata.provider === "string"
    ) {
      return metadata.provider;
    }
  }
  return undefined;
}

function isModelMetadata(metadata: UIMessage["metadata"]): metadata is { model: string } {
  return (
    typeof metadata === "object" &&
    metadata !== null &&
    "model" in metadata &&
    typeof metadata.model === "string"
  );
}

/**
 * Returns a continuation key when the latest assistant step is ready to resume after the user
 * answered it: an approval response, or answers to a `question` call (which has no server
 * execution, so its output in the current step always came from this browser). A dismissed
 * question is an `output-error` and resumes nothing; the user's next message carries it. The key
 * joins the answered approval and call ids, so callers can remember which continuation they
 * already sent and never resubmit the same step.
 */
export function getToolContinuationKey(messages: UIMessage[]) {
  const message = messages[messages.length - 1];

  if (!message || message.role !== "assistant") {
    return null;
  }

  const lastStepStartIndex = message.parts.reduce(
    (lastIndex, part, index) => (part.type === "step-start" ? index : lastIndex),
    -1,
  );
  // Earlier steps are already complete; only answers in the current step can trigger a resume.
  const toolParts = message.parts.slice(lastStepStartIndex + 1).filter(isToolPart);
  const answeredIds = toolParts.flatMap((part) => {
    if (part.state === "approval-responded") return [part.approval.id];
    if (part.state === "output-available" && getToolName(part) === "question") {
      return [part.toolCallId];
    }
    return [];
  });

  if (answeredIds.length === 0) {
    return null;
  }

  const canContinue = toolParts.every(
    (part) =>
      (part.state === "output-available" && !part.preliminary) ||
      part.state === "output-error" ||
      part.state === "approval-responded",
  );

  if (!canContinue) {
    return null;
  }

  return answeredIds.join(":");
}

/**
 * The conversation to resend when a stopped or failed turn continues. The last assistant turn
 * keeps its finished steps, so the model picks up after the tool results it already has, and
 * drops the step that was cut off: partial text or reasoning and calls without a result (the
 * model calls them again). A step whose calls all have a result or an approval answer is
 * finished. An assistant turn left with nothing finished is dropped, so the user turn is answered
 * again. Any other conversation is returned as is.
 */
export function withoutUnfinishedStep(messages: UIMessage[]): UIMessage[] {
  const message = messages.at(-1);
  if (!message || message.role !== "assistant") return messages;

  const lastStepStartIndex = message.parts.findLastIndex((part) => part.type === "step-start");
  const lastStepTools = message.parts.slice(lastStepStartIndex + 1).filter(isToolPart);
  const isLastStepFinished =
    lastStepTools.length > 0 &&
    lastStepTools.every(
      (part) =>
        (part.state === "output-available" && !part.preliminary) ||
        part.state === "output-error" ||
        part.state === "output-denied" ||
        part.state === "approval-responded",
    );
  if (isLastStepFinished) return messages;

  const finishedParts = message.parts.slice(0, Math.max(lastStepStartIndex, 0));
  if (finishedParts.every((part) => part.type === "step-start")) return messages.slice(0, -1);
  return [...messages.slice(0, -1), { ...message, parts: finishedParts }];
}

/** Last-turn direct calls and awaiting Code Mode calls, preserving part and inner-call order. */
function pendingToolParts(messages: UIMessage[]): CodeModeToolPart[] {
  const message = messages.at(-1);
  if (!message || message.role !== "assistant") return [];
  return message.parts.flatMap((part) => {
    if (!isToolPart(part)) return [];
    const snapshot = getCodeModeOutput(part);
    if (!snapshot) return [part];
    return snapshot.calls
      .filter((call) => call.status === "awaiting" && call.interaction !== undefined)
      .map(codeModeCallPart);
  });
}

/**
 * Direct and Code Mode approval requests of the latest assistant turn, in call order.
 * Inner requests carry `codeModeInteraction` and must be answered through its Convex mutation.
 */
export function getPendingApprovals(
  messages: UIMessage[],
): (CodeModeToolPart & { state: "approval-requested" })[] {
  return pendingToolParts(messages).filter(
    (part): part is CodeModeToolPart & { state: "approval-requested" } =>
      part.state === "approval-requested",
  );
}

/**
 * Direct and Code Mode questions of the latest assistant turn waiting for the user's answers.
 * Inner questions wait in-stream; direct questions are answered through the AI SDK continuation.
 */
export function getPendingQuestions(
  messages: UIMessage[],
): (CodeModeToolPart & { state: "input-available" })[] {
  return pendingToolParts(messages).filter(
    (part): part is CodeModeToolPart & { state: "input-available" } =>
      part.state === "input-available" && getToolName(part) === "question",
  );
}
