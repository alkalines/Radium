import { useAuth } from "@better-auth-ui/react";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  ActivityIcon,
  ArrowLeftIcon,
  BoxesIcon,
  RadioTowerIcon,
  ScrollTextIcon,
  ShieldIcon,
  UserRoundIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { chatroomSections } from "@/components/chatroom/chatroom-settings";
import { gatewaySections } from "@/components/gateway/gateway-settings";
import {
  SideColumnItem,
  SideColumnLayout,
  SideColumnSearch,
  SideColumnSection,
} from "@/components/harness/side-column";
import { WorkspaceSwitcher } from "@/components/workspaces/workspace-switcher";

type NavItem = {
  label: ReactNode;
  /** Text the sidebar search matches; plugin tab labels may be elements. */
  searchText: string;
  href: string;
  icon?: LucideIcon;
  /** Also active on nested pages (`/gateway/telemetry/<trace>`). */
  matchNested?: boolean;
};

// Workspace pages apply only to the workspace chosen in the section heading; the order follows
// setup (configure, connect, run), then the owner's operational views.
const workspaceItems: NavItem[] = [
  { label: "General", searchText: "General", icon: BoxesIcon, href: "/settings/workspace" },
  ...gatewaySections.map((section) => ({
    label: section.label,
    searchText: section.label,
    icon: section.icon,
    href: `/gateway/${section.value}`,
  })),
  ...chatroomSections.map((section) => ({
    label: section.label,
    searchText: section.label,
    icon: section.icon,
    href: `/chatroom/${section.value}`,
  })),
  { label: "Activity", searchText: "Activity", icon: ActivityIcon, href: "/gateway/activity" },
  { label: "Logs", searchText: "Logs", icon: ScrollTextIcon, href: "/gateway/logs" },
  {
    label: "Telemetry",
    searchText: "Telemetry",
    icon: RadioTowerIcon,
    href: "/gateway/telemetry",
    matchNested: true,
  },
];

/**
 * Settings screen (`docs/Interface_Design.md` §5.2): a 240px sidebar with `Back to app`, a
 * search over page names, the **Account** pages (Better Auth UI views, which follow the user), and
 * the workspace pages headed by the Workspace switcher. Route components render only their page
 * content (header + Group lists) as `children`. Page switches are plain navigation, so instant.
 *
 * @param backHref - URL of the previously focused Tab or Home, owned by the Window.
 * @param wide - Lets wide tables use the full layout width instead of the 760px column.
 */
export function SettingsLayout({
  children,
  wide = false,
  backHref,
}: {
  children: ReactNode;
  wide?: boolean;
  backHref: string;
}) {
  const { basePaths, viewPaths, plugins, localization } = useAuth();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLowerCase();

  const accountItems: NavItem[] = [
    {
      label: localization.settings.account,
      searchText: localization.settings.account,
      icon: UserRoundIcon,
      href: `${basePaths.settings}/${viewPaths.settings.account}`,
    },
    {
      label: localization.settings.security,
      searchText: localization.settings.security,
      icon: ShieldIcon,
      href: `${basePaths.settings}/${viewPaths.settings.security}`,
    },
    ...plugins.flatMap(
      (plugin) =>
        plugin.settingsTabs?.map((settingsTab) => ({
          label: settingsTab.label,
          searchText: typeof settingsTab.label === "string" ? settingsTab.label : settingsTab.view,
          href: `${basePaths.settings}/${plugin.viewPaths?.settings?.[settingsTab.view]}`,
        })) ?? [],
    ),
  ];

  function renderItems(items: NavItem[]) {
    const visibleItems = items.filter((item) =>
      item.searchText.toLowerCase().includes(normalizedQuery),
    );

    return visibleItems.map((item) => {
      const isActive =
        pathname === item.href ||
        (item.matchNested === true && pathname.startsWith(`${item.href}/`));

      return (
        <SideColumnItem key={item.href} asChild isActive={isActive}>
          <Link to={item.href}>
            {item.icon ? <item.icon className="text-muted-foreground" /> : null}
            <span className="truncate">{item.label}</span>
          </Link>
        </SideColumnItem>
      );
    });
  }

  // Wide tables (Activity, Logs, Telemetry) are a deliberate deviation from the 760px settings
  // column: their columns are unreadable when squeezed.
  const contentClassName = wide ? undefined : "max-w-190";

  return (
    <SideColumnLayout
      sideLabel="Settings"
      contentClassName={contentClassName}
      side={
        <>
          {/* `backHref` carries the search string (`/chat/<id>?model=…`), so it navigates by
              href rather than a typed route. */}
          <SideColumnItem onClick={() => void navigate({ href: backHref })}>
            <ArrowLeftIcon />
            Back to app
          </SideColumnItem>

          <SideColumnSearch
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search"
            aria-label="Search settings"
          />

          <SideColumnSection title="Account">
            <div className="flex flex-col gap-0.5">{renderItems(accountItems)}</div>
          </SideColumnSection>

          <SideColumnSection title={<WorkspaceSwitcher variant="heading" />}>
            <div className="flex flex-col gap-0.5">{renderItems(workspaceItems)}</div>
          </SideColumnSection>
        </>
      }
    >
      {children}
    </SideColumnLayout>
  );
}
