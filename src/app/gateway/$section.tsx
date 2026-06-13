import { createFileRoute, notFound, redirect } from "@tanstack/react-router";
import { createIsomorphicFn } from "@tanstack/react-start";
import { ensureSession as ensureSessionClient } from "@better-auth-ui/react";
import { ensureSession as ensureSessionServer } from "@better-auth-ui/react/server";
import { getRequestHeaders, getRequestUrl } from "@tanstack/react-start/server";

import { GatewaySettings, gatewaySections, type GatewaySection } from "@/components/gateway/gateway-settings";
import { auth } from "@/lib/auth";
import { authClient } from "@/lib/auth-client";

export const Route = createFileRoute("/gateway/$section")({
  staticData: {
    pageTitle: "Gateway",
  },
  async beforeLoad({ params: { section }, context: { queryClient }, location }) {
    if (!gatewaySections.some((entry) => entry.value === section)) {
      throw notFound();
    }

    const ensureSession = createIsomorphicFn()
      .server(() =>
        ensureSessionServer(queryClient, auth, {
          baseURL: getRequestUrl().origin,
          headers: getRequestHeaders(),
        }),
      )
      .client(() => ensureSessionClient(queryClient, authClient));

    const session = await ensureSession();

    if (!session) {
      throw redirect({
        to: "/auth/$path",
        params: { path: "sign-in" },
        search: { redirectTo: location.href },
      });
    }

    return { session };
  },
  component: GatewayPage,
});

function GatewayPage() {
  const { section } = Route.useParams();

  return (
    <div className="w-full max-w-5xl mx-auto p-4 md:p-6">
      <GatewaySettings section={section as GatewaySection} />
    </div>
  );
}
