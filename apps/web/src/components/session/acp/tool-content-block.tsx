import { useMemo } from "react";
import type { AcpToolContent } from "backend/src/acp/contract";
import { TerminalLog } from "@/components/agentic/terminal-log";
import { Markdown } from "@/components/markdown";
import { DiffCodeBlock, ToolCodeBlock, languageForPath } from "../tool-code";
import { acpDiffFile } from "./tool-content";

/** Normalized agent content, shared by tool steps and permission prompts. Never fetches resources. */
export function AcpToolContentBlock({
  content,
  path,
  startLine = 1,
  terminal,
  command,
  reasoning,
}: {
  content: AcpToolContent[];
  path?: string;
  startLine?: number;
  terminal?: boolean;
  command?: string;
  reasoning?: boolean;
}) {
  const terminalLines = useMemo(
    () =>
      terminal
        ? [
            ...(command ? [{ id: "command", stream: "stdin" as const, text: command }] : []),
            ...content.flatMap((entry, index) =>
              entry.type === "text"
                ? entry.text
                    .split("\n")
                    .map((text, line) => ({
                      id: `${index}-${line}`,
                      stream: "stdout" as const,
                      text,
                    }))
                : [],
            ),
          ]
        : [],
    [command, content, terminal],
  );
  return (
    <>
      {terminal ? (
        <div className="max-h-64 overflow-y-auto rounded-xl bg-muted p-3">
          <TerminalLog lines={terminalLines} />
        </div>
      ) : null}
      {content.map((entry, index) => {
        if (entry.type === "diff") return <AcpDiffBlock key={index} content={entry} />;
        if (entry.type === "text") {
          if (terminal) return null;
          if (reasoning)
            return (
              <div key={index} className="text-[13px] text-muted-foreground">
                <Markdown>{entry.text}</Markdown>
              </div>
            );
          const language = path ? languageForPath(path) : "text";
          return (
            <ToolCodeBlock
              key={index}
              code={entry.text}
              language={language}
              title={path}
              startLine={language !== "text" ? startLine : undefined}
            />
          );
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
          <p key={index} className="font-mono text-xs text-muted-foreground">
            Terminal {entry.terminalId}
          </p>
        );
      })}
    </>
  );
}

function AcpDiffBlock({ content }: { content: Extract<AcpToolContent, { type: "diff" }> }) {
  const file = useMemo(() => acpDiffFile(content), [content]);
  return <DiffCodeBlock file={file} />;
}
