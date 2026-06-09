import { TanStackDevtools } from "@tanstack/react-devtools";
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools";
import type { ConvexQueryClient } from "@convex-dev/react-query";
import type { QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  HeadContent,
  Outlet,
  Scripts,
  useRouteContext,
} from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import type { ReactNode } from "react";

import { AppShell } from "@/components/app-shell";
import { Providers } from "@/components/providers";
import { Toaster } from "@/components/ui/sonner";
import { getToken } from "@/lib/auth-server";
import appCss from "@/styles/app.css?url";

const isDev = import.meta.env.DEV;

const getAuth = createServerFn({ method: "GET" }).handler(async () => {
  return await getToken();
});

export const Route = createRootRouteWithContext<{
  queryClient: QueryClient;
  convexQueryClient: ConvexQueryClient;
}>()({
  head: () => ({
    meta: [
      {
        charSet: "utf-8",
      },
      {
        name: "viewport",
        content: "width=device-width, initial-scale=1",
      },
      {
        title: "Alkalines Radium",
      },
    ],
    links: [
      {
        rel: "stylesheet",
        href: appCss,
      },
    ],
  }),
  beforeLoad: async ({ context }) => {
    const token = await getAuth();

    if (token) {
      context.convexQueryClient.serverHttpClient?.setAuth(token);
    }

    return {
      isAuthenticated: Boolean(token),
      token,
    };
  },
  component: RootRouteComponent,
  shellComponent: RootDocument,
});

function RootRouteComponent() {
  const context = useRouteContext({ from: Route.id });

  return (
    <Providers
      convexClient={context.convexQueryClient.convexClient}
      initialToken={context.token}
    >
      <AppShell>
        <Outlet />
      </AppShell>
    </Providers>
  );
}

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>

      <body className="antialiased min-h-svh flex flex-col">
        {children}
        <Toaster />

        {isDev ? (
          <TanStackDevtools
            config={{
              position: "bottom-right",
            }}
            plugins={[
              {
                name: "TanStack Router",
                render: <TanStackRouterDevtoolsPanel />,
              },
            ]}
          />
        ) : null}

        <Scripts />
      </body>
    </html>
  );
}
