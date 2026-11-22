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
import { type ReactNode, useEffect } from "react";

import { Providers } from "@/components/providers";
import { HarnessWindow } from "@/components/window/harness-window";
import { Toaster } from "@/components/ui/sonner";
import type { Trpc } from "@/lib/trpc";
import appCss from "@/styles/app.css?url";

const isDev = import.meta.env.DEV;

/**
 * Until React has hydrated, a form submitted with Enter or a click is sent natively: as a GET
 * with every field in the URL, so a password would land in history, logs and the web server.
 * With OPAQUE that would defeat the point of the protocol (the password must never leave the
 * browser). This capture listener, installed before the body is parsed, cancels every submit
 * until {@link RootRouteComponent} marks the page hydrated; afterwards React handles submits.
 */
const BLOCK_SUBMIT_BEFORE_HYDRATION = `document.addEventListener("submit",function(e){if(!window.__radiumHydrated)e.preventDefault()},true);`;

export const Route = createRootRouteWithContext<{
  queryClient: QueryClient;
  convexQueryClient: ConvexQueryClient;
  trpc: Trpc;
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
  beforeLoad: (): { token?: string | null } => {
    // Sign-in now goes to the new backend (`/api/*` forwarder), which issues no Convex JWT, so
    // there is no Convex token to fetch: screens still on Convex run signed out until their
    // slice is ported, and `ConvexBetterAuthProvider` goes with the Convex client (task 14,
    // Phase 5).
    return { token: null };
  },
  component: RootRouteComponent,
  shellComponent: RootDocument,
});

function RootRouteComponent() {
  const context = useRouteContext({ from: Route.id });

  // Root effects run after every child hydrated, so React's own submit handlers are live now.
  useEffect(() => {
    (window as Window & { __radiumHydrated?: boolean }).__radiumHydrated = true;
  }, []);

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
        <script dangerouslySetInnerHTML={{ __html: BLOCK_SUBMIT_BEFORE_HYDRATION }} />
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
