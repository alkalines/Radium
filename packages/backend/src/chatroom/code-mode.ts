import { v, type Infer } from "convex/values";

/**
 * Code Mode contract shared by the chat action and the web client: the `execute` tool's output
 * and the in-stream prompts its inner calls wait on. Pure data and validators; the runtime lives in
 * `./code-mode-runtime.ts`, which only the chat action imports.
 */

/** Name of the model tool that runs a Code Mode program (`{ code: string }`). */
export const CODE_MODE_TOOL_NAME = "execute";

/**
 * Lifecycle of one call a program made into `tools.*`:
 * `running` → (`awaiting` while the user answers an interaction) → `completed` | `error` | `denied`.
 */
export type CodeModeCallStatus = "running" | "awaiting" | "completed" | "error" | "denied";

/** What an awaiting call needs from the user: an execution approval or a `question` answer. */
export type CodeModeInteractionKind = "approval" | "question";

/**
 * A user prompt an inner call waits on; `id` is a `codemode_interactions` document id. Unanswered
 * at `expiresAt` (epoch ms, server clock) it counts as denied or dismissed.
 */
export type CodeModeInteraction = { id: string; kind: CodeModeInteractionKind; expiresAt: number };

/** How long an inner call waits for the user before it is refused. */
export const CODE_MODE_INTERACTION_TIMEOUT_MS = 180_000;

/**
 * One call a program made, in start order. `tool` is the catalog path without `tools.`: a native
 * tool name (`worker_bash`, `question`) or `<mcp namespace>.<tool>`. Outputs are not kept here (the
 * program decides what the model sees); `error` carries the failure or denial text.
 */
export type CodeModeCall = {
  id: string;
  tool: string;
  status: CodeModeCallStatus;
  input?: unknown;
  error?: string;
  /** Present only while `status` is `awaiting`. */
  interaction?: CodeModeInteraction;
};

/**
 * Output of an `execute` call. Preliminary outputs stream while the program runs (the UI part has
 * `preliminary: true`) with an empty `output`; the last one already equals the final output, which
 * carries the model-facing text: the program's result, then `Warnings:` and `Logs:` sections.
 * `error` marks a failed program.
 */
export type CodeModeOutput = {
  output: string;
  calls: CodeModeCall[];
  error?: true;
};

/**
 * The browser's answer to an awaiting inner call: approve or deny (with an optional reason) an
 * approval, or answer or dismiss a `question` (answers follow `QuestionOutput`, one list per question).
 */
export const codeModeInteractionResponseValidator = v.union(
  v.object({ kind: v.literal("approval"), approved: v.boolean(), reason: v.optional(v.string()) }),
  v.object({ kind: v.literal("question"), answers: v.array(v.array(v.string())) }),
  v.object({ kind: v.literal("question"), dismissed: v.literal(true) }),
);

export type CodeModeInteractionResponse = Infer<typeof codeModeInteractionResponseValidator>;
