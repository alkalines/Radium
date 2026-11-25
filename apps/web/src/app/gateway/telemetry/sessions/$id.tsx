import { createFileRoute } from "@tanstack/react-router";

import { TelemetrySession } from "@/components/gateway/telemetry-session";

// Session and owner access are enforced by the parent `/gateway/telemetry` route.
export const Route = createFileRoute("/gateway/telemetry/sessions/$id")({
  staticData: {
    pageTitle: "Telemetry session",
    screen: "settings",
    settingsWidth: "wide",
  },
  loader: ({ context: { queryClient, trpc }, params: { id } }) => {
    void queryClient.prefetchQuery(trpc.telemetry.getSession.queryOptions({ session: id }));
  },
  component: TelemetrySessionPage,
});

function TelemetrySessionPage() {
  const { id } = Route.useParams();
  return <TelemetrySession sessionId={id} />;
}
