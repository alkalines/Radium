import type { LanguageModelUsage } from "ai";
import { getUsage } from "tokenlens";

import { Button } from "@/components/ui/button";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { Progress } from "@/components/ui/progress";

const compactNumber = new Intl.NumberFormat("en-US", { notation: "compact" });
const percentNumber = new Intl.NumberFormat("en-US", {
  style: "percent",
  maximumFractionDigits: 1,
});
const usdNumber = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/** Ring radius in a 16-unit viewBox; the stroke dash length derives from it. */
const RING_RADIUS = 6;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/**
 * Context window usage for the Composer toolbar (shadcn Context pattern): a compact Chip with the
 * share of `maxTokens` the conversation has used, and a hover card breaking down input, output,
 * reasoning, and cached tokens. `usage` is the latest assistant message's cumulative usage;
 * `maxTokens` is the selected provider's context window. With a `modelId` the catalogue knows,
 * the card adds tokenlens' estimated cost, an operational estimate rather than a charge.
 */
export function ContextUsage({
  usage,
  maxTokens,
  modelId,
}: {
  usage: LanguageModelUsage;
  maxTokens: number;
  modelId?: string;
}) {
  const usedTokens = usage.totalTokens ?? 0;
  const usedShare = maxTokens > 0 ? Math.min(usedTokens / maxTokens, 1) : 0;
  const usedPercent = percentNumber.format(usedShare);
  const rows = [
    { label: "Input", tokens: usage.inputTokens ?? 0 },
    { label: "Output", tokens: usage.outputTokens ?? 0 },
    { label: "Reasoning", tokens: usage.outputTokenDetails?.reasoningTokens ?? 0 },
    { label: "Cache", tokens: usage.inputTokenDetails?.cacheReadTokens ?? 0 },
  ].filter((row) => row.tokens > 0);
  const estimatedCost = modelId
    ? getUsage({
        modelId,
        usage: {
          input: usage.inputTokens ?? 0,
          output: usage.outputTokens ?? 0,
          reasoningTokens: usage.outputTokenDetails?.reasoningTokens ?? 0,
          cacheReads: usage.inputTokenDetails?.cacheReadTokens ?? 0,
        },
      }).costUSD?.totalUSD
    : undefined;

  return (
    <HoverCard openDelay={10} closeDelay={100}>
      <HoverCardTrigger asChild>
        <Button
          variant="ghost"
          size="xs"
          aria-label={`Context used: ${usedPercent}`}
          className="text-muted-foreground tabular-nums"
        >
          <svg aria-hidden="true" viewBox="0 0 16 16" data-icon="inline-start">
            <circle
              cx="8"
              cy="8"
              r={RING_RADIUS}
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              opacity="0.25"
            />
            <circle
              cx="8"
              cy="8"
              r={RING_RADIUS}
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeDasharray={RING_CIRCUMFERENCE}
              strokeDashoffset={RING_CIRCUMFERENCE * (1 - usedShare)}
              transform="rotate(-90 8 8)"
            />
          </svg>
          {usedPercent}
        </Button>
      </HoverCardTrigger>
      <HoverCardContent align="end" className="flex w-64 flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <span className="font-medium">Context</span>
          <span className="text-muted-foreground tabular-nums">
            {compactNumber.format(usedTokens)} / {compactNumber.format(maxTokens)}
          </span>
        </div>
        <Progress value={usedShare * 100} aria-label="Context used" />
        {rows.length > 0 ? (
          <dl className="flex flex-col gap-1">
            {rows.map((row) => (
              <div key={row.label} className="flex justify-between gap-3">
                <dt className="text-muted-foreground">{row.label}</dt>
                <dd className="tabular-nums">{compactNumber.format(row.tokens)}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        {estimatedCost !== undefined ? (
          <div className="flex justify-between gap-3 border-t pt-3">
            <span className="text-muted-foreground">Estimated cost</span>
            <span className="tabular-nums">{usdNumber.format(estimatedCost)}</span>
          </div>
        ) : null}
      </HoverCardContent>
    </HoverCard>
  );
}
