import { ensureSession as ensureSessionClient } from "@better-auth-ui/core";
import { ensureSessionServer } from "@better-auth-ui/core/server";
import { convexQuery } from "@convex-dev/react-query";
import { createFileRoute, Outlet, redirect, useRouterState } from "@tanstack/react-router";
import { createIsomorphicFn } from "@tanstack/react-start";
import { getRequestHeaders, getRequestUrl } from "@tanstack/react-start/server";

import { TelemetryPanel } from "@/components/gateway/telemetry-panel";
import { auth } from "@/lib/auth";
import { authClient } from "@/lib/auth-client";
import { api } from "../../../convex/_generated/api";

export const Route = createFileRoute("/gateway/telemetry")({
  staticData: { pageTitle: "Telemetry" },
  async beforeLoad({ context: { queryClient }, location }) {
    const ensureSession = createIsomorphicFn()
      .server(() =>
        ensureSessionServer(queryClient, auth as any, {
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
  loader: ({ context: { queryClient } }) => {
    void queryClient.prefetchQuery(convexQuery(api.auth.userInfo, {}));
    void queryClient.prefetchQuery(convexQuery(api.telemetry.getSettings, {}));
  },
  component: TelemetryRoute,
});

function TelemetryRoute() {
  const isDetail = useRouterState({
    select: (state) => state.location.pathname !== "/gateway/telemetry",
  });
  return (
    <main className="mx-auto w-full max-w-7xl p-4 md:p-6">
      {isDetail ? <Outlet /> : <TelemetryPanel />}
    </main>
  );
}
