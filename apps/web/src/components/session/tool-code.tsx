import { useLayoutEffect, useRef, type ReactNode } from "react";
import type { ToolUIPart } from "ai";

import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockContent,
  CodeBlockCopyButton,
  CodeBlockFooter,
  CodeBlockHeader,
  CodeBlockLine,
  CodeBlockTitle,
} from "@/components/ui/code-block";
import { useHighlightedCode } from "@/hooks/use-highlighted-code";
import { countDiffLines, parsePatch, type DiffFile, type DiffLine } from "./tool-diff";
import { getInputString, getToolInput, getToolKind } from "./tool-parts";

/**
 * Keeps a scroll container pinned to its end while `follow` is set: the live view of a tool input
 * that is still streaming (file content, a patch) shows the newest lines as they arrive.
 */
function useFollowTail<T extends HTMLElement>(follow: boolean, content: unknown) {
  const ref = useRef<T>(null);

  useLayoutEffect(() => {
    const element = ref.current;
    if (follow && element) element.scrollTop = element.scrollHeight;
  }, [follow, content]);

  return ref;
}

/** `+added −removed` counts as Machine text, used in code block headers and Trace lines. */
export function DiffStats({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="shrink-0 font-mono text-xs tabular-nums">
      {added > 0 || removed === 0 ? <span className="text-signal-success">+{added}</span> : null}
      {added > 0 && removed > 0 ? " " : null}
      {removed > 0 ? <span className="text-destructive">−{removed}</span> : null}
    </span>
  );
}

/**
 * Small `CodeBlock` for tool input and output inside a Trace step or the Approval gate: wraps,
 * caps at 16rem and scrolls. `title` is Machine text (a path or language) and gets a copy button.
 * `startLine` numbers the lines from that line; `followTail` keeps a streaming block at its end.
 */
export function ToolCodeBlock({
  code,
  language = "text",
  title,
  stats,
  footer,
  startLine,
  followTail = false,
  variant = "default",
}: {
  code: string;
  language?: string;
  title?: string;
  stats?: ReactNode;
  footer?: ReactNode;
  startLine?: number;
  followTail?: boolean;
  variant?: "default" | "destructive";
}) {
  const lines = useHighlightedCode(code, language);
  const contentRef = useFollowTail<HTMLPreElement>(followTail, code);

  return (
    <CodeBlock size="sm" variant={variant}>
      {title ? (
        <CodeBlockHeader>
          <CodeBlockTitle className="font-mono" title={title}>
            {title}
          </CodeBlockTitle>
          {stats}
          <CodeBlockActions>
            <CodeBlockCopyButton value={code} />
          </CodeBlockActions>
        </CodeBlockHeader>
      ) : null}
      <CodeBlockContent
        ref={contentRef}
        wrap
        lineNumbers={startLine !== undefined}
        startLine={startLine}
        className="max-h-64"
      >
        {lines.map((line, index) => (
          <CodeBlockLine key={index}>{line}</CodeBlockLine>
        ))}
      </CodeBlockContent>
      {footer ? <CodeBlockFooter className="text-xs">{footer}</CodeBlockFooter> : null}
    </CodeBlock>
  );
}

/** Pretty-printed JSON for tool values without a dedicated renderer (MCP tools, receipts). */
export function JsonCodeBlock({ value, title }: { value: unknown; title?: string }) {
  return (
    <ToolCodeBlock code={JSON.stringify(value ?? null, null, 2)} language="json" title={title} />
  );
}

const diffSigns: Record<DiffLine["kind"], string> = {
  added: "+",
  removed: "-",
  context: " ",
  hunk: "",
};

const opLabels: Record<DiffFile["op"], string | undefined> = {
  create: "new file",
  delete: "deleted",
  update: undefined,
};

/**
 * One file of an edit as a diff: additions and removals tinted, hunk and operation lines muted,
 * file line numbers in a gutter when the source reports them (a Worker receipt), none for a patch
 * still being written. The header shows the path, a rename target, and `+/−` counts.
 */
export function DiffCodeBlock({
  file,
  followTail = false,
}: {
  file: DiffFile;
  followTail?: boolean;
}) {
  const code = file.lines.map((line) => (line.kind === "hunk" ? "" : line.text)).join("\n");
  const highlighted = useHighlightedCode(code, languageForPath(file.path));
  const contentRef = useFollowTail<HTMLPreElement>(followTail, file.lines.length);
  const { added, removed } = countDiffLines(file.lines);
  const hasLineNumbers = file.lines.some((line) => line.line !== undefined);
  const gutterWidth = `${String(Math.max(...file.lines.map((line) => line.line ?? 0))).length}ch`;
  const title = file.moveTo ? `${file.path} → ${file.moveTo}` : file.path;
  const copyValue = file.lines.map((line) => diffSigns[line.kind] + line.text).join("\n");
  const opLabel = opLabels[file.op];

  return (
    <CodeBlock size="sm">
      <CodeBlockHeader>
        <CodeBlockTitle className="font-mono" title={title}>
          {title}
        </CodeBlockTitle>
        {opLabel ? <span className="shrink-0 text-xs">{opLabel}</span> : null}
        <DiffStats added={added} removed={removed} />
        <CodeBlockActions>
          <CodeBlockCopyButton value={copyValue} />
        </CodeBlockActions>
      </CodeBlockHeader>
      <CodeBlockContent ref={contentRef} className="max-h-80">
        {file.lines.map((line, index) => {
          if (line.kind === "hunk") {
            return (
              <CodeBlockLine key={index} className="text-muted-foreground/70">
                {line.text}
              </CodeBlockLine>
            );
          }

          return (
            <CodeBlockLine key={index} variant={line.kind === "context" ? "default" : line.kind}>
              {hasLineNumbers ? (
                <span
                  className="mr-3 ml-1.5 inline-block text-right text-muted-foreground/60 tabular-nums select-none"
                  style={{ width: gutterWidth }}
                >
                  {line.line ?? ""}
                </span>
              ) : null}
              {highlighted[index]}
            </CodeBlockLine>
          );
        })}
      </CodeBlockContent>
    </CodeBlock>
  );
}

/**
 * What a tool call is about to do, shown in its Trace step and the Approval gate, and rendered
 * live while the model is still writing it: the Bash command, the file a Worker creates (its
 * content follows the newest line), the edit patch as per-file diffs, or the raw input.
 */
export function ToolInputBlock({ part }: { part: ToolUIPart }) {
  const input = getToolInput(part);
  const isStreaming = part.state === "input-streaming";
  if (typeof input === "string") return <ToolCodeBlock code={input} title="input" />;

  switch (getToolKind(part)) {
    case "bash": {
      const command = getInputString(input, "command");
      if (command === undefined) break;
      return <ToolCodeBlock code={`$ ${command}`} language="bash" followTail={isStreaming} />;
    }
    case "create": {
      const path = getInputString(input, "path");
      const content = getInputString(input, "content");
      if (content === undefined) {
        if (path === undefined) return null;
        return <ToolCodeBlock code="" title={path} />;
      }
      return (
        <ToolCodeBlock
          code={content}
          language={path ? languageForPath(path) : "text"}
          title={path ?? "new file"}
          startLine={1}
          stats={<DiffStats added={countContentLines(content)} removed={0} />}
          followTail={isStreaming}
        />
      );
    }
    case "edit": {
      const patch = getInputString(input, "patch");
      if (patch === undefined) return null;

      const files = parsePatch(patch);
      if (files.length === 0)
        return <ToolCodeBlock code={patch} title="patch" followTail={isStreaming} />;
      return files.map((file, index) => (
        <DiffCodeBlock
          key={`${file.path}-${index}`}
          file={file}
          followTail={isStreaming && index === files.length - 1}
        />
      ));
    }
    case "read":
    case "web-search":
    case "question":
    case "todo":
    case "other":
      break;
  }

  return <JsonCodeBlock value={input} title="input" />;
}

/** Lines a created file will have; a trailing newline does not start another line. */
export function countContentLines(content: string) {
  if (content === "") return 0;
  const lines = content.split("\n").length;
  return content.endsWith("\n") ? lines - 1 : lines;
}

/** Highlighter language for a file path; unknown extensions render as plain text. */
export function languageForPath(path: string) {
  const extension = /\.([a-z0-9]+)$/i.exec(path)?.[1];
  return extension?.toLowerCase() ?? "text";
}
