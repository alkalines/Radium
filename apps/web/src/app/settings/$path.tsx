import { viewPaths } from "@better-auth-ui/core";
import { useAuth, useAuthenticate } from "@better-auth-ui/react";
import { createFileRoute, notFound } from "@tanstack/react-router";

import { AccountSettings } from "@/components/auth/settings/account/account-settings";
import { SecuritySettings } from "@/components/auth/settings/security/security-settings";
import { PageHeader } from "@/components/harness/page-header";
import { organizationPlugin } from "@/lib/auth/organization-plugin";
import { requireSession } from "@/lib/require-session";

const validSettingsPaths = [
  ...Object.values(viewPaths.settings),
  ...Object.values(organizationPlugin().viewPaths.settings),
];

export const Route = createFileRoute("/settings/$path")({
  staticData: {
    pageTitle: "Settings",
    screen: "settings",
  },
  async beforeLoad({ params: { path }, context: { queryClient }, location }) {
    if (!validSettingsPaths.includes(path)) {
      throw notFound();
    }

    const session = await requireSession({ queryClient, location });
    return { session };
  },
  component: AccountSettingsPage,
});

// Better Auth UI cards are shadcn Cards with their own headings; align them with Group lists
// (Hairline border, `rounded-2xl`, no shadow) and the Row-indented section headings without
// forking the account components.
const betterAuthCardsClassName =
  "flex flex-col gap-8 [&_[data-slot=card]]:rounded-2xl [&_[data-slot=card]]:border [&_[data-slot=card]]:shadow-none [&_[data-slot=card]]:ring-0 [&_h2]:px-4 [&_h2]:font-medium";

/**
 * Account pages follow the signed-in user, not the workspace, so their header has no workspace
 * scope. The path segment resolves to a core settings view (Account, Security) or a plugin tab.
 */
function AccountSettingsPage() {
  const { path } = Route.useParams();
  const { authClient, localization, viewPaths: authViewPaths, plugins } = useAuth();
  useAuthenticate(authClient);

  if (path === authViewPaths.settings.account) {
    return (
      <>
        <PageHeader
          title={localization.settings.account}
          description="Your profile and sign-in email. They apply in every workspace."
        />
        <AccountSettings className={betterAuthCardsClassName} />
      </>
    );
  }

  if (path === authViewPaths.settings.security) {
    return (
      <>
        <PageHeader
          title={localization.settings.security}
          description="Password, linked accounts, and the devices signed in to your account."
        />
        <SecuritySettings className={betterAuthCardsClassName} />
      </>
    );
  }

  const pluginTab = plugins
    .flatMap((plugin) =>
      (plugin.settingsTabs ?? []).map((settingsTab) => ({
        settingsTab,
        segment: plugin.viewPaths?.settings?.[settingsTab.view],
      })),
    )
    .find((entry) => entry.segment === path)?.settingsTab;

  if (!pluginTab) {
    throw notFound();
  }

  return (
    <>
      <PageHeader title={pluginTab.label} />
      <div className={betterAuthCardsClassName}>
        <pluginTab.component />
      </div>
    </>
  );
}
