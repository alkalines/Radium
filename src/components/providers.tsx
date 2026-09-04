import { Link, useNavigate } from "@tanstack/react-router";
import { useSession } from "@better-auth-ui/react";
import { ConvexBetterAuthProvider } from "@convex-dev/better-auth/react";
import { useQueryClient } from "@tanstack/react-query";
import type { ConvexReactClient } from "convex/react";
import { ThemeProvider, useTheme } from "next-themes";
import { useEffect, useState, type ReactNode } from "react";

import { authClient } from "@/lib/auth-client";
import { themePlugin } from "@/lib/auth/theme-plugin";
import { AuthProvider } from "./auth/auth-provider";
import { TooltipProvider } from "./ui/tooltip";

export function Providers({
  children,
  convexClient,
  initialToken,
}: {
  children: ReactNode;
  convexClient: ConvexReactClient;
  initialToken?: string | null;
}) {
  const navigate = useNavigate();
  //const { slug } = useParams({ strict: false })

  return (
    <ConvexBetterAuthProvider
      client={convexClient}
      authClient={authClient}
      initialToken={initialToken}
    >
      <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
        <AuthProvider
          authClient={authClient}
          redirectTo="/settings/account"
          navigate={navigate}
          plugins={[
            themePlugin({ useTheme }),
            // usernamePlugin({
            //   usernamePrefix: "@",
            //   localization: { usernamePlaceholder: "username" },
            // }),
            // magicLinkPlugin(),
            // emailOtpPlugin({
            //   emailVerification: true,
            //   passwordReset: true,
            //   changeEmail: true,
            // }),
            // twoFactorPlugin(),
            // passkeyPlugin(),
            // apiKeyPlugin({
            //   organization: true,
            //   configurations: [
            //     { id: "default", label: "Personal", organization: false },
            //     {
            //       id: "organization",
            //       label: "Organization",
            //       organization: true,
            //     },
            //   ],
            // }),
            // multiSessionPlugin(),
            // deleteUserPlugin(),
            // organizationPlugin({
            //   slugPrefix: "@",
            //   slug: slug ?? null,
            //   teams: true,
            // }),
          ]}
          Link={Link}
        >
          <ConvexAuthQueryCache>
            <TooltipProvider>{children}</TooltipProvider>
          </ConvexAuthQueryCache>
        </AuthProvider>
      </ThemeProvider>
    </ConvexBetterAuthProvider>
  );
}

/**
 * Convex query keys do not include the Better Auth identity, so discard the
 * client cache before a different user can reuse the previous user's data.
 */
function ConvexAuthQueryCache({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const { data: session, isPending } = useSession(authClient);
  const userId = session?.user.id;
  const [cacheIdentity, setCacheIdentity] = useState<{
    initialized: boolean;
    userId?: string;
  }>({ initialized: false });
  const identityChanged =
    !isPending && cacheIdentity.initialized && cacheIdentity.userId !== userId;

  useEffect(() => {
    if (isPending) return;

    if (!cacheIdentity.initialized) {
      setCacheIdentity({ initialized: true, userId });
      return;
    }

    if (!identityChanged) return;

    queryClient.removeQueries({ queryKey: ["convexQuery"] });
    setCacheIdentity({ initialized: true, userId });
  }, [cacheIdentity.initialized, identityChanged, isPending, queryClient, userId]);

  return identityChanged ? null : children;
}
