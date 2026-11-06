import { convexQuery } from "@convex-dev/react-query";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowUpRightIcon, CircleDollarSignIcon } from "lucide-react";
import { useMemo } from "react";

import { formatCurrency } from "@/components/gateway/telemetry-utils";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "backend/convex/_generated/api";
import type { Id } from "backend/convex/_generated/dataModel";

const WINDOW_DAYS = 30;

/**
 * Owner-only estimated usage of one Project (or of unfiled sessions, `none`) over the last 30
 * days: Gateway requests and ACP agent turns by harness. The query runs only while the popover is
 * open, so Home never subscribes to workspace usage in the background.
 */
export function ProjectUsageButton({
  workspaceId,
  project,
}: {
  workspaceId: Id<"workspaces">;
  project: Id<"projects"> | "none";
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label="Project usage" title="Project usage">
          <CircleDollarSignIcon />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        <ProjectUsageSummary workspaceId={workspaceId} project={project} />
      </PopoverContent>
    </Popover>
  );
}

function ProjectUsageSummary({
  workspaceId,
  project,
}: {
  workspaceId: Id<"workspaces">;
  project: Id<"projects"> | "none";
}) {
  const since = useMemo(() => Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000, []);
  const { data: activity } = useQuery(
    convexQuery(api.observability.usage.getActivity, {
      workspace: workspaceId,
      since,
      project,
    }),
  );
  const unknown = activity
    ? activity.summary.unknownCostRequests + activity.summary.unknownCostTurns
    : 0;

  return (
    <>
      <PopoverHeader>
        <PopoverTitle>Usage</PopoverTitle>
        <PopoverDescription>Estimated cost in the last {WINDOW_DAYS} days.</PopoverDescription>
      </PopoverHeader>
      {activity === undefined ? (
        <Skeleton className="h-24" />
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-xl font-medium tabular-nums">
              {formatCurrency(activity.summary.spend)}
            </span>
            <span className="text-xs text-muted-foreground">
              {unknown > 0 ? `${unknown} with unknown cost` : null}
            </span>
          </div>
          {activity.harnesses.length ? (
            <ul className="flex flex-col gap-1.5 text-xs">
              {activity.harnesses.slice(0, 5).map((harness) => (
                <li key={harness.id} className="flex items-center justify-between gap-3">
                  <span className="truncate">{harness.name}</span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    {formatCurrency(harness.cost)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">No usage in this period.</p>
          )}
        </div>
      )}
      <Button variant="outline" size="sm" asChild>
        <Link to="/gateway/activity" search={{ project }}>
          Open in Activity
          <ArrowUpRightIcon data-icon="inline-end" />
        </Link>
      </Button>
    </>
  );
}
