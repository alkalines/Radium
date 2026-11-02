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

/** A path as the reader knows it: relative to the Session's folder when it is inside it. */
export function acpDisplayPath(path: string, cwd: string | undefined): string {
  if (!cwd) return path;
  const root = cwd.replace(/[\\/]+$/, "");
  if (path === root) return ".";
  const separator = path.charAt(root.length);
  return path.startsWith(root) && (separator === "/" || separator === "\\")
    ? path.slice(root.length + 1)
    : path;
}

/**
 * What a step is about: paths, the command or the URL as Machine text, else the agent's own title
 * (`isTitle`), which may already name the action.
 */
export function acpToolSubject(
  item: AcpToolItem,
  cwd?: string,
): { text: string; isTitle: boolean } {
  const kind = acpToolKind(item);
  if (kind === "execute") {
    const command = acpCommand(item);
    return { text: command, isTitle: false };
  }
  if (kind === "read" || kind === "edit" || kind === "delete" || kind === "move") {
    const locations = item.locations?.length
      ? item.locations
      : (item.content?.flatMap((entry) => (entry.type === "diff" ? [{ path: entry.path }] : [])) ??
        []);
    if (locations.length)
      return {
        text: locations
          .map((location) => {
            const path = acpDisplayPath(location.path, cwd);
            return "line" in location && location.line !== undefined
              ? `${path}:${location.line}`
              : path;
          })
          .join(kind === "move" ? " → " : ", "),
        isTitle: false,
      };
  }
  if (kind === "fetch") {
    const input = acpRawValue(item.rawInput);
    if (
      typeof input === "object" &&
      input !== null &&
      "url" in input &&
      typeof input.url === "string"
    )
      return { text: input.url, isTitle: false };
    const resource = item.content?.find((entry) => entry.type === "resource");
    if (resource?.type === "resource") return { text: resource.uri, isTitle: false };
  }
  return { text: item.title, isTitle: true };
}

const numberedLine = /^\s*(\d+)(?:[:→|]|\t)(.*)$/;

/**
 * File text an agent already numbered (`12:code`, `12→code`, `cat -n`), split into code and its
 * own line numbers so they show in the gutter instead of twice. Gaps (elided ranges) keep no
 * number. A leading `[path]` header line, which some agents print, is the step's own subject.
 */
export function acpNumberedText(
  text: string,
): { code: string; numbers: (number | undefined)[] } | undefined {
  const lines = text.replace(/\n$/, "").split("\n");
  if (lines.length > 1 && /^\[[^\]\n]+\]$/.test(lines[0]!)) lines.shift();
  const parsed = lines.map((line) => {
    const match = numberedLine.exec(line);
    return match ? { number: Number(match[1]), text: match[2]! } : { text: line };
  });
  const numbered = parsed.filter((line) => line.number !== undefined).length;
  // Elision markers and blank lines between numbered ranges do not count against the file shape.
  const other = parsed.filter(
    (line) => line.number === undefined && !/^\s*(?:…|\.\.\.)?\s*$/.test(line.text),
  ).length;
  if (numbered === 0 || other > numbered / 4) return undefined;
  return {
    code: parsed.map((line) => line.text).join("\n"),
    numbers: parsed.map((line) => line.number),
  };
}
