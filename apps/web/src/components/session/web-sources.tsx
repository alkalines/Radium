import { ArrowUpRightIcon, GlobeIcon } from "lucide-react";

import { Trace, TraceIcon, TraceLine, TraceTitle } from "@/components/ui/trace";
import type { WebSearchResult } from "./tool-parts";

/** Results shown per search; the model sees all of them, the reader needs the top few. */
const VISIBLE_RESULTS = 8;

/**
 * Links a web search returned, in the shadcn Sources pattern: one Trace line per result with the
 * site favicon and page title, opening in a new tab.
 */
export function WebSources({ results }: { results: WebSearchResult[] }) {
  return (
    <Trace>
      {results.slice(0, VISIBLE_RESULTS).map((result) => (
        <a key={result.url} href={result.url} target="_blank" rel="noreferrer" title={result.url}>
          <TraceLine>
            <TraceIcon>
              {result.favicon ? (
                <img alt="" className="size-4 rounded-sm" src={result.favicon} />
              ) : (
                <GlobeIcon />
              )}
            </TraceIcon>
            <TraceTitle>
              {result.title}
              <span className="sr-only"> (opens in a new tab)</span>
            </TraceTitle>
            <TraceIcon>
              <ArrowUpRightIcon />
            </TraceIcon>
          </TraceLine>
        </a>
      ))}
    </Trace>
  );
}
