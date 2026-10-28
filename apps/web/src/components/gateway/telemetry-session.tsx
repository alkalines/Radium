import { convexQuery } from "@convex-dev/react-query";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { FunctionReturnType } from "convex/server";
import type { Id } from "backend/convex/_generated/dataModel";
import { ArrowLeftIcon, CircleAlertIcon } from "lucide-react";

import { WorkspacePageHeader } from "@/components/settings/workspace-page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "backend/convex/_generated/api";
import { DataSection } from "./data-section";
import {
  ChangeTags,
  LineageBadge,
  RequestProviderLogo,
  RequestStatusLabel,
} from "./telemetry-parts";
import { RequestConversation } from "./telemetry-conversation";
import { RequestTree } from "./telemetry-tree";
import { formatTelemetryDate, formatTelemetryDuration, formatTokenCount } from "./telemetry-utils";

type SessionResult = FunctionReturnType<typeof api.observability.telemetry.getSession>;
type Entry = SessionResult["requests"][number];

export function TelemetrySession({ sessionId }: { sessionId: Id<"telemetry_sessions"> }) {
  const { data, error } = useQuery(
    convexQuery(api.observability.telemetry.getSession, { session: sessionId }),
  );

  if (error) {
    return (
      <>
        <WorkspacePageHeader title="Session" action={<AllRequestsLink />} />
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertTitle>Could not load session</AlertTitle>
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      </>
    );
  }

  if (data === undefined) {
    return (
      <>
        <WorkspacePageHeader title="Session" action={<AllRequestsLink />} />
        <Skeleton className="h-48 rounded-2xl" />
      </>
    );
  }

  const { session, parentSession, children } = data;
  const latest = data.requests.at(-1);

  return (
    <>
      <WorkspacePageHeader
        title="Session"
        description={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-xs">
            <span className="truncate">{session.key}</span>
            <span>·</span>
            <time dateTime={new Date(session.startedAt).toISOString()}>
              {formatTelemetryDate(session.startedAt)}
            </time>
          </span>
        }
        action={<AllRequestsLink />}
      />

      {(parentSession || children.length > 0) && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-1 text-sm">
          {parentSession && (
            <span className="text-muted-foreground">
              Subagent of{" "}
              <Link
                to="/gateway/telemetry/sessions/$id"
                params={{ id: parentSession._id }}
                className="font-mono text-xs text-foreground underline underline-offset-2"
              >
                {parentSession.key}
              </Link>
            </span>
          )}
          {children.length > 0 && (
            <span className="flex flex-wrap items-center gap-2 text-muted-foreground">
              Subagents:
              {children.map((child) => (
                <Link
                  key={child._id}
                  to="/gateway/telemetry/sessions/$id"
                  params={{ id: child._id }}
                  className="max-w-48 truncate font-mono text-xs text-foreground underline underline-offset-2"
                >
                  {child.key}
                </Link>
              ))}
            </span>
          )}
        </div>
      )}

      {data.truncated && (
        <Alert>
          <AlertTitle>Showing the newest {data.requests.length} requests</AlertTitle>
          <AlertDescription>
            Older requests of this session exist; branches that start before this window appear as
            separate roots.
          </AlertDescription>
        </Alert>
      )}

      {data.requests.length > 0 && <RequestTree data={data} />}

      <DataSection
        title="Timeline"
        description="Requests in the order they were made, with the messages each one added."
        contentClassName="flex flex-col"
      >
        {data.requests.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">No visible requests in this session.</p>
        ) : (
          data.requests.map((entry, index) => (
            <TimelineRow key={entry._id} entry={entry} index={index + 1} />
          ))
        )}
      </DataSection>

      {latest && <LatestConversation requestId={latest._id} />}
    </>
  );
}

function AllRequestsLink() {
  return (
    <Button variant="outline" size="sm" asChild>
      <Link to="/gateway/telemetry">
        <ArrowLeftIcon data-icon="inline-start" />
        All requests
      </Link>
    </Button>
  );
}

function NewMessages({ count }: { count: number }) {
  return (
    <span className="font-mono text-xs text-muted-foreground tabular-nums">
      {count === 0 ? "no new messages" : `+${count} ${count === 1 ? "message" : "messages"}`}
    </span>
  );
}

function TimelineRow({ entry, index }: { entry: Entry; index: number }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b px-4 py-3 text-sm last:border-b-0">
      <span className="w-6 shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums">
        {index}
      </span>
      <LineageBadge lineage={entry.lineage} />
      <Link
        to="/gateway/telemetry/$id"
        params={{ id: entry._id }}
        className="flex min-w-0 items-center gap-2 font-medium underline-offset-2 hover:underline"
      >
        <RequestProviderLogo slug={entry.provider} className="size-4" />
        <span className="truncate">{entry.model}</span>
      </Link>
      <NewMessages count={entry.newMessages} />
      <ChangeTags fields={entry.changedFields} />
      <span className="ml-auto flex items-center gap-3">
        <span className="font-mono text-xs text-muted-foreground tabular-nums">
          {formatTelemetryDuration(entry.durationMs)} ·{" "}
          {formatTokenCount(entry.usage?.totalTokens ?? 0)} tok
        </span>
        <RequestStatusLabel status={entry.status} />
        <time
          dateTime={new Date(entry.startedAt).toISOString()}
          className="hidden w-36 text-right text-xs whitespace-nowrap text-muted-foreground md:block"
        >
          {formatTelemetryDate(entry.startedAt)}
        </time>
      </span>
    </div>
  );
}

/** The newest request's full body, shown the way the model received it. */
function LatestConversation({ requestId }: { requestId: Id<"telemetry_requests"> }) {
  const { data, error } = useQuery(
    convexQuery(api.observability.telemetry.getRequest, { request: requestId }),
  );

  if (error) {
    return (
      <Alert variant="destructive">
        <CircleAlertIcon />
        <AlertTitle>Could not load the latest request</AlertTitle>
        <AlertDescription>{error.message}</AlertDescription>
      </Alert>
    );
  }
  if (data === undefined) return <Skeleton className="h-48 rounded-2xl" />;
  if (data.legacy) return null;

  return (
    <RequestConversation
      data={data}
      title="General messages"
      description={
        <>
          The latest request in this session, as the model received it.{" "}
          <Link
            to="/gateway/telemetry/$id"
            params={{ id: requestId }}
            className="text-foreground underline underline-offset-2"
          >
            Open request
          </Link>
        </>
      }
    />
  );
}
