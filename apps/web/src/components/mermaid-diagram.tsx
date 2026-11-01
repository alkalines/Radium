import { mermaid } from "@streamdown/mermaid";
import {
  CopyIcon,
  DownloadIcon,
  Maximize2Icon,
  MinusIcon,
  PlusIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/** Mermaid renders flowchart node groups with ids like `mermaid-123-flowchart-n4-7`. */
const FLOWCHART_NODE_ID = /flowchart-([A-Za-z0-9_]+)-\d+$/;
const ZOOM_STEPS = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 2];

/**
 * A Mermaid diagram rendered with Streamdown's Mermaid plugin (strict security level). Unlike a
 * Markdown fence it keeps the diagram's natural size inside a scrollable frame, with zoom,
 * fullscreen, copy-source, and SVG download controls. The theme follows light/dark mode. Source
 * that fails to render shows as text with the error and the copy-source control.
 *
 * `onNodeClick` receives the flowchart node ID of a clicked node; clicks are read from the
 * rendered SVG, so Mermaid never needs script or callback directives.
 */
export function MermaidDiagram({
  chart,
  filename,
  title,
  className,
  onNodeClick,
  startAtEnd = false,
}: {
  chart: string;
  /** Base name for the downloaded SVG. */
  filename: string;
  /** Accessible name of the fullscreen view. */
  title: string;
  className?: string;
  onNodeClick?: (nodeId: string) => void;
  /** Open scrolled to the right/bottom end, where a left-to-right timeline is newest. */
  startAtEnd?: boolean;
}) {
  const { resolvedTheme } = useTheme();
  const renderId = `mermaid-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const [rendered, setRendered] = useState<{ svg?: string; error?: string }>({});
  const [zoom, setZoom] = useState(1);
  const [fullscreen, setFullscreen] = useState(false);
  const frame = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!startAtEnd || !rendered.svg || !frame.current) return;
    frame.current.scrollLeft = frame.current.scrollWidth;
  }, [rendered.svg, startAtEnd]);

  useEffect(() => {
    let current = true;
    const instance = mermaid.getMermaid({
      theme: resolvedTheme === "dark" ? "dark" : "neutral",
      fontFamily: "Inter Variable, sans-serif",
      // Layout is measured with this size, so CSS must not change label font size.
      themeVariables: { fontSize: "13px" },
      // Natural pixel size; the frame scrolls instead of shrinking the diagram to fit.
      flowchart: {
        curve: "basis",
        nodeSpacing: 24,
        rankSpacing: 64,
        padding: 12,
        useMaxWidth: false,
      },
    });
    instance
      .render(renderId, chart)
      .then(({ svg }) => current && setRendered({ svg }))
      .catch((error: unknown) => {
        if (current) {
          setRendered({ error: error instanceof Error ? error.message : "Rendering failed." });
        }
      });
    return () => {
      current = false;
    };
  }, [chart, renderId, resolvedTheme]);

  const zoomIndex = ZOOM_STEPS.indexOf(zoom);
  const handleClick = (event: React.MouseEvent) => {
    if (!onNodeClick || !(event.target instanceof Element)) return;
    const match = event.target.closest("g.node")?.id.match(FLOWCHART_NODE_ID);
    if (match) {
      setFullscreen(false);
      onNodeClick(match[1]!);
    }
  };

  const copySourceButton = (
    <Button
      variant="ghost"
      size="icon-xs"
      aria-label="Copy Mermaid source"
      onClick={() =>
        void navigator.clipboard.writeText(chart).then(
          () => toast.success("Diagram source copied"),
          () => toast.error("Could not copy the diagram source"),
        )
      }
    >
      <CopyIcon />
    </Button>
  );

  // Invalid syntax keeps the source readable and copyable, so the diagram can still be fixed.
  if (rendered.error) {
    return (
      <div className="overflow-hidden rounded-lg border bg-background">
        <div className="flex items-center gap-2 border-b py-1 pr-2 pl-3 text-sm text-muted-foreground">
          <TriangleAlertIcon className="size-4 shrink-0" />
          <span className="min-w-0 flex-1">The diagram could not be drawn: {rendered.error}</span>
          {copySourceButton}
        </div>
        <pre className="max-h-[min(70vh,36rem)] overflow-auto p-3 font-mono text-xs">{chart}</pre>
      </div>
    );
  }
  if (!rendered.svg) return <Skeleton className="h-40 rounded-lg" />;

  const diagram = (
    <div
      className={cn(onNodeClick && "[&_g.node]:cursor-pointer", "w-max p-4", className)}
      style={{ zoom }}
      onClick={handleClick}
      // Mermaid sanitizes its output at the strict security level.
      dangerouslySetInnerHTML={{ __html: rendered.svg }}
    />
  );

  return (
    <div className="overflow-hidden rounded-lg border bg-background">
      <div className="flex items-center gap-1 border-b px-2 py-1">
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Zoom out"
          disabled={zoomIndex <= 0}
          onClick={() => setZoom(ZOOM_STEPS[zoomIndex - 1]!)}
        >
          <MinusIcon />
        </Button>
        <button
          type="button"
          className="w-11 text-center font-mono text-[11px] text-muted-foreground tabular-nums"
          aria-label="Reset zoom"
          onClick={() => setZoom(1)}
        >
          {Math.round(zoom * 100)}%
        </button>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Zoom in"
          disabled={zoomIndex >= ZOOM_STEPS.length - 1}
          onClick={() => setZoom(ZOOM_STEPS[zoomIndex + 1]!)}
        >
          <PlusIcon />
        </Button>
        <span className="ml-auto" />
        {copySourceButton}
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Download SVG"
          onClick={() => downloadSvg(rendered.svg!, filename)}
        >
          <DownloadIcon />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Open fullscreen"
          onClick={() => setFullscreen(true)}
        >
          <Maximize2Icon />
        </Button>
      </div>
      <div ref={frame} className="max-h-[min(70vh,36rem)] overflow-auto">
        {diagram}
      </div>
      <Dialog open={fullscreen} onOpenChange={setFullscreen}>
        <DialogContent className="flex h-[90vh] max-w-[95vw] flex-col gap-3 sm:max-w-[95vw]">
          <DialogTitle>{title}</DialogTitle>
          <div className="min-h-0 flex-1 overflow-auto rounded-lg border bg-background">
            {diagram}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function downloadSvg(svg: string, filename: string) {
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `${filename}.svg`;
  link.click();
  URL.revokeObjectURL(url);
}
