import { themePlugin } from "@/lib/auth/theme-plugin"
import { Link, useNavigate } from "@tanstack/react-router"
import { ConvexProvider, type ConvexReactClient } from "convex/react"
import { ThemeProvider, useTheme } from "next-themes"
import type { ReactNode } from "react"

import { authClient } from "@/lib/auth-client"
import { AuthProvider } from "./auth/auth-provider"
import { Toaster } from "./ui/sonner"

export function Providers({
  children,
  convexClient
}: {
  children: ReactNode
  convexClient: ConvexReactClient
}) {
  const navigate = useNavigate()
  //const { slug } = useParams({ strict: false })

  return (
    <ConvexProvider client={convexClient}>
      <ThemeProvider
        attribute="class"
        defaultTheme="system"
        enableSystem
        disableTransitionOnChange
      >
        <AuthProvider
          authClient={authClient}
          redirectTo="/settings/account"
          navigate={navigate}
          plugins={[
            themePlugin({ useTheme }),
            /* @todo
            usernamePlugin(),
            apiKeyPlugin({ organization: true }),
            multiSessionPlugin(),
            deleteUserPlugin(),
            organizationPlugin({
              slug: slug ?? null
            })
            */
          ]}
          Link={Link}
        >
          {children}

          <Toaster />
        </AuthProvider>
      </ThemeProvider>
    </ConvexProvider>
  )
}
