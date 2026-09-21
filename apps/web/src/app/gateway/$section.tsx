import { createFileRoute, notFound, redirect } from "@tanstack/react-router";
import { createIsomorphicFn } from "@tanstack/react-start";
import { ensureSession as ensureSessionClient } from "@better-auth-ui/core";
import { ensureSessionServer } from "@better-auth-ui/core/server";
import { getRequestHeaders, getRequestUrl } from "@tanstack/react-start/server";

import { convexQuery } from "@convex-dev/react-query";

import {
  GatewaySettings,
  gatewaySections,
  type GatewaySection,
} from "@/components/gateway/gateway-settings";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { useWorkspace } from "@/components/workspaces/workspace-provider";
import { api } from "backend/convex/_generated/api";
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
  loader: ({ context: { queryClient }, params: { section } }) => {
    void queryClient.prefetchQuery(convexQuery(api.auth.userInfo, {}));
  },
  component: GatewayPage,
});

function GatewayPage() {
  const { section } = Route.useParams();
  const { workspace, isLoading } = useWorkspace();

  if (isLoading) {
    return <Skeleton className="mx-auto h-32 w-full max-w-5xl" />;
  }

  if (!workspace) {
    return (
      <WorkspaceNotice
        title="Workspace unavailable"
        description="Select an active workspace to view Gateway settings."
      />
    );
  }

  if (workspace.role === "member") {
    return (
      <WorkspaceNotice
        title="Gateway settings are owner-only"
        description={`You can use models configured in ${workspace.name}, but only its owner can manage providers, credentials, API keys, logs, and activity.`}
      />
    );
  }

  return (
    <div
      className={
        section === "activity"
          ? "mx-auto w-full max-w-7xl p-4 md:p-6"
          : "mx-auto w-full max-w-5xl p-4 md:p-6"
      }
    >
      <GatewaySettings section={section as GatewaySection} hideNav />
    </div>
  );
}

function WorkspaceNotice({ title, description }: { title: string; description: string }) {
  return (
    <div className="mx-auto w-full max-w-3xl p-4 md:p-6">
      <Alert>
        <AlertTitle>{title}</AlertTitle>
        <AlertDescription>{description}</AlertDescription>
      </Alert>
    </div>
  );
}
