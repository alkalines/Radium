import { viewPaths } from "@better-auth-ui/core";
import { magicLinkPlugin } from "@/lib/auth/magic-link-plugin";
import { createFileRoute, redirect } from "@tanstack/react-router";

import { Auth } from "@/components/auth/auth";

const validAuthPathSegments = new Set([
  ...Object.values(viewPaths.auth),
  magicLinkPlugin().viewPaths.auth.magicLink,
]);

export const Route = createFileRoute("/auth/$path")({
  staticData: {
    pageTitle: "Authentication",
    // Signed-out screens have no Tabs, workspace, or account menu, so they skip the Window.
    shell: "bare",
  },
  beforeLoad({ params: { path } }) {
    if (!validAuthPathSegments.has(path)) {
      throw redirect({ to: "/" });
    }
  },
  component: AuthPage,
});

function AuthPage() {
  const { path } = Route.useParams();

  return (
    <main className="flex min-h-svh items-center justify-center bg-chrome p-4 md:p-6">
      <Auth path={path} />
    </main>
  );
}
