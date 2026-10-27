import { convexQuery } from "@convex-dev/react-query";
import { createFileRoute } from "@tanstack/react-router";
import type { Id } from "backend/convex/_generated/dataModel";

import { TelemetrySession } from "@/components/gateway/telemetry-session";
import { api } from "backend/convex/_generated/api";

// Session and owner access are enforced by the parent `/gateway/telemetry` route.
export const Route = createFileRoute("/gateway/telemetry/sessions/$id")({
  staticData: {
    pageTitle: "Telemetry session",
    screen: "settings",
    settingsWidth: "wide",
  },
  loader: ({ context: { queryClient }, params: { id } }) => {
    void queryClient.prefetchQuery(
      convexQuery(api.observability.telemetry.getSession, {
        session: id as Id<"telemetry_sessions">,
      }),
    );
  },
  component: TelemetrySessionPage,
});

function TelemetrySessionPage() {
  const { id } = Route.useParams();
  return <TelemetrySession sessionId={id as Id<"telemetry_sessions">} />;
}
