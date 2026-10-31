import { cjk } from "@streamdown/cjk";
import { math } from "@streamdown/math";
import * as React from "react";
import { Streamdown, useIsCodeFenceIncomplete, type ExtraProps } from "streamdown";

import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockContent,
  CodeBlockCopyButton,
  CodeBlockHeader,
  CodeBlockLine,
  CodeBlockTitle,
} from "@/components/ui/code-block";
import { MermaidDiagram } from "@/components/mermaid-diagram";
import { useHighlightedCode } from "@/hooks/use-highlighted-code";
import { cn } from "@/lib/utils";

/** A fenced code block from a Markdown reply, highlighted line by line as it streams. */
function MarkdownCodeBlock({ code, language }: { code: string; language: string }) {
  // True until the closing fence arrives; copying half a block would paste broken code.
  const isIncomplete = useIsCodeFenceIncomplete();
  const lines = useHighlightedCode(code, language);
  const copyValue = code.endsWith("\n") ? code.slice(0, -1) : code;

  // A half-streamed diagram cannot parse, so Mermaid shows as source until its fence closes.
  if (language === "mermaid" && !isIncomplete) {
    return <MermaidDiagram chart={copyValue} filename="diagram" title="Diagram" />;
  }

  return (
    <CodeBlock size="sm">
      <CodeBlockHeader>
        <CodeBlockTitle className="font-mono">{language || "text"}</CodeBlockTitle>
        <CodeBlockActions>
          <CodeBlockCopyButton value={copyValue} disabled={isIncomplete} />
        </CodeBlockActions>
      </CodeBlockHeader>
      <CodeBlockContent lineNumbers={lines.length > 1}>
        {lines.map((line, index) => (
          <CodeBlockLine key={index}>{line}</CodeBlockLine>
        ))}
      </CodeBlockContent>
    </CodeBlock>
  );
}

function MarkdownCode({
  node,
  className,
  children,
  ...props
}: React.ComponentProps<"code"> & ExtraProps) {
  // Streamdown marks fenced code with `data-block`; everything else is inline code.
  if (!("data-block" in props)) {
    return (
      <code className="rounded-sm bg-muted px-1 py-0.5 font-mono text-[0.9em]" {...props}>
        {children}
      </code>
    );
  }

  return (
    <MarkdownCodeBlock
      code={typeof children === "string" ? children : ""}
      language={/language-(\S+)/.exec(className ?? "")?.[1] ?? ""}
    />
  );
}

const components = { code: MarkdownCode };
// Math uses the plugin default, `$$…$$` only, so prices like "$5 and $10" stay plain text.
const plugins = { math, cjk };

/**
 * Agent Markdown rendered with Streamdown, which repairs unterminated syntax while a reply
 * streams. Fenced code renders as a `CodeBlock` with a copy button (disabled until the fence
 * closes); a closed `mermaid` fence renders as a {@link MermaidDiagram}. KaTeX math (`$$…$$`)
 * and CJK-aware emphasis come from Streamdown plugins. Pass `isAnimating` only for the text that
 * is still streaming: it shows the caret and lets code blocks know their fence may be incomplete.
 */
export const Markdown = React.memo(
  function Markdown({
    children,
    isAnimating = false,
    className,
  }: {
    children: string;
    isAnimating?: boolean;
    className?: string;
  }) {
    return (
      <Streamdown
        className={cn("min-w-0 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0", className)}
        components={components}
        plugins={plugins}
        isAnimating={isAnimating}
        caret={isAnimating ? "block" : undefined}
      >
        {children}
      </Streamdown>
    );
  },
  (previous, next) =>
    previous.children === next.children &&
    previous.isAnimating === next.isAnimating &&
    previous.className === next.className,
);
