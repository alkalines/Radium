import type { AcpToolContent } from "backend/src/acp/contract";
import { diffLines } from "@/components/gateway/telemetry-utils";
import type { DiffFile, DiffLine } from "../tool-diff";
import { acpToolKind, type AcpToolItem } from "./parts";

/** Decode the bounded permission payload, tolerating interrupted or older relay content. */
export function acpPermissionContent(raw: string | undefined): AcpToolContent[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [{ type: "text", text: raw }];
    return value.filter((entry): entry is AcpToolContent => {
      if (typeof entry !== "object" || entry === null) return false;
      if (entry.type === "text") return typeof entry.text === "string";
      if (entry.type === "diff")
        return (
          typeof entry.path === "string" &&
          typeof entry.newText === "string" &&
          (entry.oldText === undefined || typeof entry.oldText === "string")
        );
      if (entry.type === "resource") return typeof entry.uri === "string";
      if (entry.type === "image") return typeof entry.mimeType === "string";
      return entry.type === "terminal" && typeof entry.terminalId === "string";
    });
  } catch {
    return [{ type: "text", text: raw }];
  }
}

const diffFiles = new WeakMap<Extract<AcpToolContent, { type: "diff" }>, DiffFile>();

/** Same bounded line-diff algorithm as Telemetry, adapted to the Session's per-file renderer. */
export function acpDiffFile(content: Extract<AcpToolContent, { type: "diff" }>): DiffFile {
  const cached = diffFiles.get(content);
  if (cached) return cached;
  const before = content.oldText ?? "";
  const after = content.newText;
  let oldLine = 1;
  let newLine = 1;
  const lines: DiffLine[] = !before
    ? after
      ? after
          .replace(/\n$/, "")
          .split("\n")
          .map((text, index) => ({ kind: "added", text, line: index + 1 }))
      : []
    : !after
      ? before
          .replace(/\n$/, "")
          .split("\n")
          .map((text, index) => ({ kind: "removed", text, line: index + 1 }))
      : diffLines(before.replace(/\n$/, ""), after.replace(/\n$/, "")).map<DiffLine>((entry) => {
          if (entry.kind === "remove")
            return { kind: "removed", text: entry.text, line: oldLine++ };
          if (entry.kind === "add") return { kind: "added", text: entry.text, line: newLine++ };
          const line = newLine++;
          oldLine++;
          return { kind: "context", text: entry.text, line };
        });
  const file: DiffFile = {
    path: content.path,
    op: content.oldText === undefined ? "create" : "update",
    lines,
  };
  diffFiles.set(content, file);
  return file;
}

/** A raw value is JSON when the agent supplied JSON, text otherwise. */
export function acpRawValue(raw: string | undefined): unknown {
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export function acpCommand(item: AcpToolItem): string {
  const input = acpRawValue(item.rawInput);
  const command =
    typeof input === "object" &&
    input !== null &&
    "command" in input &&
    typeof input.command === "string"
      ? input.command
      : undefined;
  return command ?? item.title;
}

/** Paths and commands are Machine text; unknown kinds retain the agent's own title. */
export function acpToolSubject(item: AcpToolItem): string {
  const kind = acpToolKind(item);
  if (kind === "execute") return acpCommand(item);
  if (kind === "read" || kind === "edit" || kind === "delete" || kind === "move") {
    const paths = item.locations?.map((location) => location.path) ?? [];
    if (!paths.length)
      paths.push(
        ...(item.content?.flatMap((entry) => (entry.type === "diff" ? [entry.path] : [])) ?? []),
      );
    if (paths.length) return paths.join(kind === "move" ? " → " : ", ");
  }
  if (kind === "fetch") {
    const input = acpRawValue(item.rawInput);
    if (
      typeof input === "object" &&
      input !== null &&
      "url" in input &&
      typeof input.url === "string"
    )
      return input.url;
    const resource = item.content?.find((entry) => entry.type === "resource");
    if (resource?.type === "resource") return resource.uri;
  }
  return item.title;
}
