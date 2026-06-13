import { useQuery } from "convex/react";
import { CreditCardIcon } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "../../../convex/_generated/api";
import { ProviderLogo } from "./provider-logo";

function formatCredits(value: number): string {
  return `$${value.toFixed(Math.abs(value) < 1 ? 4 : 2)}`;
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function CreditsPanel() {
  const userInfo = useQuery(api.auth.userInfo);
  const balanceId = typeof userInfo === "string" ? undefined : userInfo?.balances[0]?._id;
  const credits = useQuery(api.credits.getCredits, balanceId ? { balance: balanceId } : "skip");

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold tracking-tight">Credits</h2>
        <p className="text-sm text-muted-foreground">
          Track gateway credit balance and recent spend.
        </p>
      </div>

      {!balanceId && userInfo !== undefined && (
        <Alert>
          <AlertTitle>No balance yet</AlertTitle>
          <AlertDescription>A balance is required to track credits.</AlertDescription>
        </Alert>
      )}

      {balanceId && credits === undefined ? (
        <div className="grid gap-3 sm:grid-cols-3">
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
        </div>
      ) : balanceId && credits ? (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <SummaryCard title="Balance" value={formatCredits(credits.credits)} description="Available credits" />
            <SummaryCard
              title="Recent spend"
              value={formatCredits(credits.spentRecent)}
              description={`Across ${credits.completions} request${credits.completions === 1 ? "" : "s"}`}
            />
            <SummaryCard
              title="Requests"
              value={String(credits.completions)}
              description="Recent completions"
            />
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Recent activity</CardTitle>
              <CardDescription>The latest completions billed to this balance.</CardDescription>
            </CardHeader>
            <CardContent>
              {credits.recent.length === 0 ? (
                <Empty className="py-8">
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <CreditCardIcon />
                    </EmptyMedia>
                    <EmptyTitle>No usage yet</EmptyTitle>
                    <EmptyDescription>Completions billed to this balance will appear here.</EmptyDescription>
                  </EmptyHeader>
                </Empty>
              ) : (
                <div className="flex flex-col divide-y">
                  {credits.recent.map((completion) => (
                    <div key={completion._id} className="flex items-center gap-3 py-2.5">
                      <ProviderLogo slug={completion.provider} className="size-7" />
                      <div className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-sm font-medium">{completion.provider}</span>
                        <span className="truncate text-xs text-muted-foreground">
                          {formatTime(completion._creationTime)} ·{" "}
                          {completion.usage.prompt_tokens + completion.usage.completion_tokens} tokens
                        </span>
                      </div>
                      {completion.byok && <Badge variant="outline">BYOK</Badge>}
                      <span className="shrink-0 font-mono text-sm">
                        {formatCredits(completion.cost)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </>
      ) : null}
    </div>
  );
}

function SummaryCard({
  title,
  value,
  description,
}: {
  title: string;
  value: string;
  description: string;
}) {
  return (
    <Card>
      <CardHeader>
        <CardDescription>{title}</CardDescription>
        <CardTitle className="text-2xl tabular-nums">{value}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-xs text-muted-foreground">{description}</p>
      </CardContent>
    </Card>
  );
}
