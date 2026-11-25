import { createFileRoute } from "@tanstack/react-router";

import { TelemetryDetail } from "@/components/gateway/telemetry-detail";

// Session and owner access are enforced by the parent `/gateway/telemetry` route.
export const Route = createFileRoute("/gateway/telemetry/$id")({
  staticData: {
    pageTitle: "Telemetry request",
    screen: "settings",
    settingsWidth: "wide",
  },
  loader: ({ context: { queryClient, trpc }, params: { id } }) => {
    void queryClient.prefetchQuery(trpc.telemetry.getRequest.queryOptions({ request: id }));
  },
  component: TelemetryRequestPage,
});

function TelemetryRequestPage() {
  const { id } = Route.useParams();
  return <TelemetryDetail requestId={id} />;
}
