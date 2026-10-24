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

import { Providers } from "@/components/providers";
import { HarnessWindow } from "@/components/window/harness-window";
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
        title: "Radium",
      },
    ],
    links: [
      {
        rel: "stylesheet",
        href: appCss,
      },
    ],
  }),
  beforeLoad: async ({ context }): Promise<{ token?: string | null }> => {
    // The token only seeds `ConvexBetterAuthProvider` (read once at mount) and server-side
    // prefetch auth; after hydration Better Auth keeps it fresh on the client. Fetching it on
    // every client navigation blocked each Tab switch on a server round trip, and route guards
    // (`requireSession`) still check the session on the client.
    if (typeof window !== "undefined") return {};

    const token = await getAuth();
    if (token) {
      // Route loaders may prefetch authenticated Convex data before the client hydrates.
      context.convexQueryClient.serverHttpClient?.setAuth(token);
    }

    return { token };
  },
  component: RootRouteComponent,
  shellComponent: RootDocument,
});

function RootRouteComponent() {
  const context = useRouteContext({ from: Route.id });

  return (
    <Providers convexClient={context.convexQueryClient.convexClient} initialToken={context.token}>
      <HarnessWindow>
        <Outlet />
      </HarnessWindow>
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
