import { convexQuery } from "@convex-dev/react-query";
import { createFileRoute } from "@tanstack/react-router";
import type { Id } from "backend/convex/_generated/dataModel";

import { TelemetryDetail } from "@/components/gateway/telemetry-detail";
import { api } from "backend/convex/_generated/api";

// Session and owner access are enforced by the parent `/gateway/telemetry` route.
export const Route = createFileRoute("/gateway/telemetry/$id")({
  staticData: {
    pageTitle: "Telemetry request",
    screen: "settings",
    settingsWidth: "wide",
  },
  loader: ({ context: { queryClient }, params: { id } }) => {
    void queryClient.prefetchQuery(
      convexQuery(api.observability.telemetry.getRequest, {
        request: id as Id<"telemetry_requests">,
      }),
    );
  },
  component: TelemetryRequestPage,
});

function TelemetryRequestPage() {
  const { id } = Route.useParams();
  return <TelemetryDetail requestId={id as Id<"telemetry_requests">} />;
}
