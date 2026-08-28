import { Link, useNavigate } from "@tanstack/react-router";
import { ConvexBetterAuthProvider } from "@convex-dev/better-auth/react";
import type { ConvexReactClient } from "convex/react";
import { ThemeProvider, useTheme } from "next-themes";
import type { ReactNode } from "react";

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
          <TooltipProvider>{children}</TooltipProvider>
        </AuthProvider>
      </ThemeProvider>
    </ConvexBetterAuthProvider>
  );
}
