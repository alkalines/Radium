import { ensureSession as ensureSessionClient } from "@better-auth-ui/core";
import { ensureSessionServer } from "@better-auth-ui/core/server";
import { convexQuery } from "@convex-dev/react-query";
import { createFileRoute, Outlet, redirect, useRouterState } from "@tanstack/react-router";
import { createIsomorphicFn } from "@tanstack/react-start";
import { getRequestHeaders, getRequestUrl } from "@tanstack/react-start/server";

import { TelemetryPanel } from "@/components/gateway/telemetry-panel";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { useWorkspace } from "@/components/workspaces/workspace-provider";
import { auth } from "@/lib/auth";
import { authClient } from "@/lib/auth-client";
import { api } from "backend/convex/_generated/api";

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
  },
  component: TelemetryRoute,
});

function TelemetryRoute() {
  const { workspace, isLoading } = useWorkspace();
  const isDetail = useRouterState({
    select: (state) => state.location.pathname !== "/gateway/telemetry",
  });

  if (isLoading) {
    return <Skeleton className="mx-auto h-32 w-full max-w-7xl" />;
  }

  if (!workspace) {
    return (
      <TelemetryAccessNotice
        title="Workspace unavailable"
        description="Select an active workspace to view Gateway telemetry."
      />
    );
  }

  if (workspace.role === "member") {
    return (
      <TelemetryAccessNotice
        title="Gateway telemetry is owner-only"
        description={`You can use models configured in ${workspace.name}, but only its owner can inspect workspace-wide traces and payloads.`}
      />
    );
  }

  return (
    <main className="mx-auto w-full max-w-7xl p-4 md:p-6">
      {isDetail ? <Outlet /> : <TelemetryPanel />}
    </main>
  );
}

function TelemetryAccessNotice({ title, description }: { title: string; description: string }) {
  return (
    <div className="mx-auto w-full max-w-3xl p-4 md:p-6">
      <Alert>
        <AlertTitle>{title}</AlertTitle>
        <AlertDescription>{description}</AlertDescription>
      </Alert>
    </div>
  );
}
