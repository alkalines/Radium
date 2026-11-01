import type { LanguageModelUsage } from "ai";

import { Button } from "@/components/ui/button";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { Progress } from "@/components/ui/progress";

const compactNumber = new Intl.NumberFormat("en-US", { notation: "compact" });
const percentNumber = new Intl.NumberFormat("en-US", {
  style: "percent",
  maximumFractionDigits: 1,
});
const usdNumber = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 6,
});

type GatewayExecution = {
  requestedServiceTier?: string;
  serviceTier?: string;
  estimatedCost?: number;
  reportedCost?: number;
  costSource?: string;
};

/** Ring radius in a 16-unit viewBox; the stroke dash length derives from it. */
const RING_RADIUS = 6;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/**
 * Context window usage for the Composer toolbar (shadcn Context pattern): a compact Chip with the
 * share of `maxTokens` the conversation has used, and a hover card breaking down input, output,
 * reasoning, and cached tokens. `usage` is the latest assistant message's cumulative usage;
 * `maxTokens` is the selected provider's context window. Costs come from Gateway executions,
 * not a model-only price lookup; an incomplete multi-step total remains unknown.
 */
export function ContextUsage({
  usage,
  maxTokens,
  executions,
  cost,
  costLabel = "Gateway cost",
}: {
  usage: Partial<LanguageModelUsage>;
  maxTokens: number;
  executions?: GatewayExecution[];
  /** Native cost reported by an external agent, without Gateway conversion. */
  cost?: { amount: number; currency: string };
  costLabel?: string;
}) {
  const usedTokens = usage.totalTokens ?? 0;
  const usedShare = maxTokens > 0 ? Math.min(usedTokens / maxTokens, 1) : 0;
  const usedPercent = percentNumber.format(usedShare);
  const rows = [
    { label: "Input", tokens: usage.inputTokens ?? 0 },
    { label: "Output", tokens: usage.outputTokens ?? 0 },
    { label: "Reasoning", tokens: usage.outputTokenDetails?.reasoningTokens ?? 0 },
    { label: "Cache read", tokens: usage.inputTokenDetails?.cacheReadTokens ?? 0 },
    { label: "Cache write", tokens: usage.inputTokenDetails?.cacheWriteTokens ?? 0 },
  ].filter((row) => row.tokens > 0);
  const costs = executions?.map((execution) => execution.reportedCost ?? execution.estimatedCost);
  const totalCost =
    costs && costs.length > 0 && costs.every((cost) => cost !== undefined)
      ? costs.reduce<number>((sum, cost) => sum + (cost ?? 0), 0)
      : undefined;
  const sources = new Set(executions?.map((execution) => execution.costSource).filter(Boolean));
  const servedTiers = new Set(
    executions?.map((execution) => execution.serviceTier).filter(Boolean),
  );

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
        {/* `bg-muted` matches the popover surface in the dark theme, so the unused part of the
            track would be invisible; `bg-accent` stays distinct on popovers in both themes. */}
        <Progress value={usedShare * 100} aria-label="Context used" className="bg-accent" />
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
        <div className="flex flex-col gap-1 border-t pt-3">
          <div className="flex justify-between gap-3">
            <span className="text-muted-foreground">{costLabel}</span>
            <span className="tabular-nums">
              {cost
                ? `${cost.amount.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${cost.currency}`
                : totalCost === undefined
                  ? "Unknown"
                  : totalCost > 0 && totalCost < 0.000001
                    ? "<$0.000001"
                    : usdNumber.format(totalCost)}
            </span>
          </div>
          {sources.size === 1 && executions?.every((execution) => execution.costSource) && (
            <div className="text-muted-foreground">Source: {[...sources][0]}</div>
          )}
          {sources.size > 1 && <div className="text-muted-foreground">Source: mixed</div>}
          {servedTiers.size === 1 && executions?.every((execution) => execution.serviceTier) && (
            <div className="text-muted-foreground">Served tier: {[...servedTiers][0]}</div>
          )}
          {servedTiers.size > 1 && <div className="text-muted-foreground">Served tiers: mixed</div>}
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}
