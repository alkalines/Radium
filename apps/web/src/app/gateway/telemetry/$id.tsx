import { convexQuery } from "@convex-dev/react-query";
import { createFileRoute } from "@tanstack/react-router";
import type { Id } from "../../../../convex/_generated/dataModel";

import { TelemetryDetail } from "@/components/gateway/telemetry-detail";
import { api } from "../../../../convex/_generated/api";

export const Route = createFileRoute("/gateway/telemetry/$id")({
  staticData: { pageTitle: "Telemetry trace" },
  loader: ({ context: { queryClient }, params: { id } }) => {
    void queryClient.prefetchQuery(
      convexQuery(api.telemetry.getTrace, { traceId: id as Id<"telemetry_traces"> }),
    );
  },
  component: TelemetryTracePage,
});

function TelemetryTracePage() {
  const { id } = Route.useParams();
  return <TelemetryDetail traceId={id as Id<"telemetry_traces">} />;
}
