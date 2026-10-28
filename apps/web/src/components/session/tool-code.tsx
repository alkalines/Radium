import type { ToolUIPart } from "ai";

import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockContent,
  CodeBlockCopyButton,
  CodeBlockHeader,
  CodeBlockLine,
  CodeBlockTitle,
} from "@/components/ui/code-block";
import { useHighlightedCode } from "@/hooks/use-highlighted-code";
import { getInputString, getToolInput, getToolKind } from "./tool-parts";

/**
 * Small `CodeBlock` for tool input and output inside a Trace step or the Approval gate: wraps,
 * caps at 16rem and scrolls. `title` is Machine text (a path or language) and gets a copy button.
 */
export function ToolCodeBlock({
  code,
  language = "text",
  title,
  variant = "default",
}: {
  code: string;
  language?: string;
  title?: string;
  variant?: "default" | "destructive";
}) {
  const lines = useHighlightedCode(code, language);

  return (
    <CodeBlock size="sm" variant={variant}>
      {title ? (
        <CodeBlockHeader>
          <CodeBlockTitle className="font-mono" title={title}>
            {title}
          </CodeBlockTitle>
          <CodeBlockActions>
            <CodeBlockCopyButton value={code} />
          </CodeBlockActions>
        </CodeBlockHeader>
      ) : null}
      <CodeBlockContent wrap className="max-h-64">
        {lines.map((line, index) => (
          <CodeBlockLine key={index}>{line}</CodeBlockLine>
        ))}
      </CodeBlockContent>
    </CodeBlock>
  );
}

/** Pretty-printed JSON for tool values without a dedicated renderer (MCP tools, receipts). */
export function JsonCodeBlock({ value, title }: { value: unknown; title?: string }) {
  return (
    <ToolCodeBlock code={JSON.stringify(value ?? null, null, 2)} language="json" title={title} />
  );
}

/**
 * What a tool call is about to do, shown in its Trace step and the Approval gate: the Bash
 * command, the file a Worker creates (with its content), the edit patch, or the raw input.
 */
export function ToolInputBlock({ part }: { part: ToolUIPart }) {
  const input = getToolInput(part);
  if (typeof input === "string") return <ToolCodeBlock code={input} title="input" />;

  switch (getToolKind(part)) {
    case "bash": {
      const command = getInputString(input, "command");
      if (command === undefined) break;
      return <ToolCodeBlock code={`$ ${command}`} language="bash" />;
    }
    case "create": {
      const path = getInputString(input, "path");
      const content = getInputString(input, "content");
      if (path === undefined || content === undefined) break;
      return <ToolCodeBlock code={content} language={languageForPath(path)} title={path} />;
    }
    case "edit": {
      const patch = getInputString(input, "patch");
      if (patch === undefined) break;
      return <ToolCodeBlock code={patch} title="patch" />;
    }
    case "read":
    case "web-search":
    case "other":
      break;
  }

  return <JsonCodeBlock value={input} title="input" />;
}

/** Highlighter language for a file path; unknown extensions render as plain text. */
export function languageForPath(path: string) {
  const extension = /\.([a-z0-9]+)$/i.exec(path)?.[1];
  return extension?.toLowerCase() ?? "text";
}
