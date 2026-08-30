import { convexQuery } from "@convex-dev/react-query";
import { useQuery } from "@tanstack/react-query";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "../../../convex/_generated/api";

function formatCredits(value: number): string {
  return `$${value.toFixed(Math.abs(value) < 1 ? 4 : 2)}`;
}

export function CreditsPanel() {
  const { data: userInfo } = useQuery(convexQuery(api.auth.userInfo, {}));
  const balanceId = typeof userInfo === "string" ? undefined : userInfo?.balances[0]?._id;
  const { data: credits } = useQuery(
    convexQuery(api.credits.getCredits, balanceId ? { balance: balanceId } : "skip"),
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold tracking-tight">Credits</h2>
        <p className="text-sm text-muted-foreground">
          Track gateway credit balance and recent spend. See the Generation Logs tab for per-request
          detail.
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
        <div className="grid gap-3 sm:grid-cols-3">
          <SummaryCard
            title="Balance"
            value={formatCredits(credits.credits)}
            description="Available credits"
          />
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
