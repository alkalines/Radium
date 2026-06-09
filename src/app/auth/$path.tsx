import { viewPaths } from "@better-auth-ui/core"
import { magicLinkPlugin } from "@better-auth-ui/core/plugins"
import { createFileRoute, redirect } from "@tanstack/react-router"

import { Auth } from "@/components/auth/auth"

const validAuthPathSegments = new Set([
  ...Object.values(viewPaths.auth),
  magicLinkPlugin().viewPaths.auth.magicLink
])

export const Route = createFileRoute("/auth/$path")({
  staticData: {
    pageTitle: "Authentication"
  },
  beforeLoad({ params: { path } }) {
    if (!validAuthPathSegments.has(path)) {
      throw redirect({ to: "/" })
    }
  },
  component: AuthPage
})

function AuthPage() {
  const { path } = Route.useParams()

  return (
    <div className="flex justify-center my-auto p-4 md:p-6">
      <Auth path={path} />
    </div>
  )
}
