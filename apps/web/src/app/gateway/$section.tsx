import { convexQuery } from "@convex-dev/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import type { ComponentType } from "react";

import { CredentialsPanel } from "@/components/gateway/credentials-panel";
import { gatewaySections, type GatewaySection } from "@/components/gateway/gateway-settings";
import { KeysPanel } from "@/components/gateway/keys-panel";
import { LimitsPanel } from "@/components/gateway/limits-panel";
import { ProvidersPanel } from "@/components/gateway/providers-panel";
import { RoutingPanel } from "@/components/gateway/routing-panel";
import { WorkspaceSettingsGate } from "@/components/settings/workspace-settings-gate";
import { requireSession } from "@/lib/require-session";
import { api } from "backend/convex/_generated/api";

export const Route = createFileRoute("/gateway/$section")({
  staticData: {
    pageTitle: "Gateway",
    screen: "settings",
  },
  async beforeLoad({ params: { section }, context: { queryClient }, location }) {
    if (!gatewaySections.some((entry) => entry.value === section)) {
      throw notFound();
    }

    const session = await requireSession({ queryClient, location });
    return { session };
  },
  loader: ({ context: { queryClient } }) => {
    void queryClient.prefetchQuery(convexQuery(api.auth.userInfo, {}));
  },
  component: GatewayPage,
});

// Each panel renders its own `WorkspacePageHeader`, so the route adds no heading.
const gatewayPanels: Record<GatewaySection, ComponentType> = {
  providers: ProvidersPanel,
  credentials: CredentialsPanel,
  routing: RoutingPanel,
  limits: LimitsPanel,
  keys: KeysPanel,
};

function GatewayPage() {
  const { section } = Route.useParams();
  const gatewaySection = gatewaySections.find((entry) => entry.value === section);

  if (!gatewaySection) {
    throw notFound();
  }

  const Panel = gatewayPanels[gatewaySection.value];

  return (
    <WorkspaceSettingsGate
      title={gatewaySection.label}
      ownerOnlyDetail="Providers, credentials, routing, limits, and API keys stay with the workspace owner. Chats here use the models they connect."
    >
      <Panel />
    </WorkspaceSettingsGate>
  );
}
