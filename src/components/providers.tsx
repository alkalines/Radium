import { Link, useNavigate } from "@tanstack/react-router";
import { ConvexProvider, type ConvexReactClient } from "convex/react";
import type { ReactNode } from "react";

import { authClient } from "@/lib/auth-client";
import { AuthProvider } from "./auth/auth-provider";
import { TooltipProvider } from "./ui/tooltip";

export function Providers({
  children,
  convexClient,
}: {
  children: ReactNode;
  convexClient: ConvexReactClient;
}) {
  const navigate = useNavigate();
  //const { slug } = useParams({ strict: false })

  return (
    <ConvexProvider client={convexClient}>
      <AuthProvider
        authClient={authClient}
        redirectTo="/settings/account"
        navigate={navigate}
        plugins={
          [
            /* @todo
            usernamePlugin(),
            apiKeyPlugin({ organization: true }),
            multiSessionPlugin(),
            deleteUserPlugin(),
            organizationPlugin({
              slug: slug ?? null
            })
            */
          ]
        }
        Link={Link}
      >
        <TooltipProvider>
          {children}
        </TooltipProvider>
      </AuthProvider>
    </ConvexProvider>
  );
}
