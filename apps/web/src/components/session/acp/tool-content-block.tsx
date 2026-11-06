import { useMemo } from "react";
import type { AcpToolContent } from "backend/src/acp/contract";
import { TerminalLog } from "@/components/agentic/terminal-log";
import { Markdown } from "@/components/markdown";
import { DiffCodeBlock, ToolCodeBlock, languageForPath } from "../tool-code";
import { acpDiffFile, acpNumberedText } from "./tool-content";

/**
 * Normalized agent content, shared by tool steps and permission prompts. Never fetches resources.
 * Text is file content with a `path` (a read), an excerpt of `excerptPath` when the agent numbered
 * its lines (an edit's preview), and otherwise the tool's plain output. `partial` marks content
 * cut at the item's size cap, so diffs show as partial.
 */
export function AcpToolContentBlock({
  content,
  path,
  excerptPath,
  startLine = 1,
  terminal,
  command,
  reasoning,
  partial = false,
}: {
  content: AcpToolContent[];
  path?: string;
  excerptPath?: string;
  startLine?: number;
  terminal?: boolean;
  command?: string;
  reasoning?: boolean;
  partial?: boolean;
}) {
  const terminalLines = useMemo(() => {
    if (!terminal) return [];
    const output = content.flatMap((entry, index) =>
      entry.type === "text"
        ? entry.text.split("\n").map((text, line) => ({
            id: `${index}-${line}`,
            stream: "stdout" as const,
            text,
          }))
        : [],
    );
    // Agents that echo the command as their first output line would show it twice.
    if (command && output[0]?.text.trim() === `$ ${command.trim()}`) output.shift();
    return [
      ...(command ? [{ id: "command", stream: "stdin" as const, text: command }] : []),
      ...output,
    ];
  }, [command, content, terminal]);
  return (
    <>
      {terminal ? (
        <div className="max-h-64 overflow-y-auto rounded-xl bg-muted p-3">
          <TerminalLog lines={terminalLines} />
        </div>
      ) : null}
      {content.map((entry, index) => {
        if (entry.type === "diff")
          return <AcpDiffBlock key={index} content={entry} partial={partial} />;
        if (entry.type === "text") {
          if (terminal) return null;
          if (reasoning)
            return (
              <div key={index} className="text-[13px] text-muted-foreground">
                <Markdown>{entry.text}</Markdown>
              </div>
            );
          if (path || excerptPath)
            return (
              <AcpFileText
                key={index}
                text={entry.text}
                path={(path ?? excerptPath)!}
                start={startLine}
                excerpt={!path}
              />
            );
          return <ToolCodeBlock key={index} code={entry.text} />;
        }
        if (entry.type === "resource")
          return (
            <p key={index} className="break-all font-mono text-xs text-muted-foreground">
              {entry.name ? `${entry.name} · ` : ""}
              {entry.uri}
            </p>
          );
        if (entry.type === "image")
          return (
            <p key={index} className="text-xs text-muted-foreground">
              Image ({entry.mimeType}) stays in the agent.
            </p>
          );
        return (
          <p key={index} className="text-xs text-muted-foreground">
            Terminal output stays in the agent.
          </p>
        );
      })}
    </>
  );
}

function AcpDiffBlock({
  content,
  partial,
}: {
  content: Extract<AcpToolContent, { type: "diff" }>;
  partial: boolean;
}) {
  const file = useMemo(() => acpDiffFile(content, partial), [content, partial]);
  return <DiffCodeBlock file={file} />;
}

/**
 * File text highlighted for its path and numbered by the agent's own numbers when it gave them.
 * An `excerpt` is file text only when numbered; unnumbered it is the tool's plain output.
 */
function AcpFileText({
  text,
  path,
  start,
  excerpt,
}: {
  text: string;
  path: string;
  start: number;
  excerpt: boolean;
}) {
  const numbered = useMemo(() => acpNumberedText(text), [text]);
  const language = languageForPath(path);
  if (numbered)
    return (
      <ToolCodeBlock
        code={numbered.code}
        language={language}
        title={path}
        numbers={numbered.numbers}
      />
    );
  if (excerpt) return <ToolCodeBlock code={text} />;
  return (
    <ToolCodeBlock
      code={text}
      language={language}
      title={path}
      startLine={language !== "text" ? start : undefined}
    />
  );
}
