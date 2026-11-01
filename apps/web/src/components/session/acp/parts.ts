import type { DynamicToolUIPart } from "ai";
import type { AcpItem } from "backend/src/acp/contract";

/**
 * How ACP timeline items enter the shared Session renderers (`docs/ACP/Interactions.md#view-model`).
 * `user`/`agent`/`thought` items become text and reasoning parts; `tool` items become AI SDK
 * `dynamic-tool` parts carrying the normalized item, so Trace, Steps and `tool-parts.ts` keep one
 * rendering path; `notice` items become `data-acp-notice` parts. Components read ACP fields only
 * through the helpers below.
 */

export type AcpToolItem = Extract<AcpItem, { kind: "tool" }>;
export type AcpNoticeItem = Extract<AcpItem, { kind: "notice" }>;
export type AcpPlanItem = Extract<AcpItem, { kind: "plan" }>;

/** ACP tool kinds (`ToolKind` in ACP v1); anything else renders as `other`. */
export const ACP_TOOL_KINDS = [
  "read",
  "edit",
  "delete",
  "move",
  "search",
  "execute",
  "think",
  "fetch",
  "switch_mode",
  "other",
] as const;
export type AcpToolKind = (typeof ACP_TOOL_KINDS)[number];

/** Tool names of ACP parts are `acp_<kind>`, which never collide with Radium tool names. */
export const ACP_TOOL_NAME_PREFIX = "acp_";

/**
 * A `dynamic-tool` part built from an ACP tool item. `turnCancelled` marks a call still open when
 * its turn ended as cancelled (ACP v1 has no cancelled tool status). Session renderers receive it
 * through `isToolPart`, which narrows to `ToolUIPart`; `isAcpToolPart` recovers the ACP fields.
 */
export type AcpToolPart = DynamicToolUIPart & {
  acp: { item: AcpToolItem; turnCancelled: boolean };
};

/** A notice (agent notice, compaction progress, turn error) inside an assistant turn. */
export type AcpNoticePart = { type: "data-acp-notice"; id: string; data: AcpNoticeItem };

/** Narrows a message part to an ACP tool part. */
export function isAcpToolPart(part: unknown): part is AcpToolPart {
  return (
    typeof part === "object" &&
    part !== null &&
    "acp" in part &&
    "type" in part &&
    part.type === "dynamic-tool"
  );
}

/** Narrows a message part to an ACP notice part. */
export function isAcpNoticePart(part: unknown): part is AcpNoticePart {
  return (
    typeof part === "object" && part !== null && "type" in part && part.type === "data-acp-notice"
  );
}

/** The ACP kind of a tool item, `other` when the agent sent none or an unknown one. */
export function acpToolKind(item: AcpToolItem): AcpToolKind {
  return (ACP_TOOL_KINDS as readonly string[]).includes(item.toolKind ?? "")
    ? (item.toolKind as AcpToolKind)
    : "other";
}

/**
 * Builds the `dynamic-tool` part of one tool item. State: `completed` → `output-available`,
 * `failed` → `output-error`, otherwise `input-available`; `getToolRunState` reads the ACP status
 * (and `turnCancelled`) for the RunState, not this state. `input` and `output` hold the parsed raw
 * input/output when they are JSON, else the raw text.
 */
export function acpToolPart(item: AcpToolItem, turnCancelled: boolean): AcpToolPart {
  const base = {
    type: "dynamic-tool" as const,
    toolName: `${ACP_TOOL_NAME_PREFIX}${acpToolKind(item)}`,
    toolCallId: item.toolCallId,
    title: item.title,
    input: parseRaw(item.rawInput),
    acp: { item, turnCancelled },
  };
  if (item.status === "completed") {
    return { ...base, state: "output-available", output: parseRaw(item.rawOutput) } as AcpToolPart;
  }
  if (item.status === "failed") {
    const text = item.content?.find((entry) => entry.type === "text");
    return {
      ...base,
      state: "output-error",
      errorText: text?.type === "text" ? text.text : "The tool failed.",
    } as AcpToolPart;
  }
  return { ...base, state: "input-available" } as AcpToolPart;
}

function parseRaw(raw: string | undefined): unknown {
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
