import { useAuth } from "@better-auth-ui/react";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  ActivityIcon,
  ArrowLeftIcon,
  BellIcon,
  BoxesIcon,
  CpuIcon,
  RadioTowerIcon,
  ScrollTextIcon,
  ShieldIcon,
  UserRoundIcon,
} from "lucide-react";
import { useState, type ComponentType, type ReactNode, type SVGProps } from "react";

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
  icon?: ComponentType<SVGProps<SVGSVGElement>>;
  iconClassName?: string;
  /** Also active on nested pages (`/gateway/telemetry/<trace>`). */
  matchNested?: boolean;
};

type NavGroup = { label: string; items: NavItem[] };

function chatroomItem(section: (typeof chatroomSections)[number]): NavItem {
  return {
    label: section.label,
    searchText: section.label,
    icon: section.icon,
    href: `/chatroom/${section.value}`,
    // The ACP mark is a wide wordmark: fit its width to the 16px icon slot instead of its height.
    iconClassName: section.value === "acp" ? "w-4! h-auto!" : undefined,
  };
}

// Workspace pages apply only to the workspace chosen in the section heading. Subgroups follow
// setup (the workspace and its machines, model routing, chat behavior), then the owner's
// operational views. Workers is a Chatroom route but configures the workspace's machines.
const workspaceGroups: NavGroup[] = [
  {
    label: "Workspace",
    items: [
      { label: "General", searchText: "General", icon: BoxesIcon, href: "/settings/workspace" },
      ...chatroomSections
        .filter((section) => section.value === "workers" || section.value === "acp")
        .map(chatroomItem),
    ],
  },
  {
    label: "Gateway",
    items: gatewaySections.map((section) => ({
      label: section.label,
      searchText: section.label,
      icon: section.icon,
      href: `/gateway/${section.value}`,
    })),
  },
  {
    label: "Chat",
    items: chatroomSections
      .filter((section) => section.value !== "workers" && section.value !== "acp")
      .map(chatroomItem),
  },
  {
    label: "Observability",
    items: [
      { label: "Activity", searchText: "Activity", icon: ActivityIcon, href: "/gateway/activity" },
      { label: "Logs", searchText: "Logs", icon: ScrollTextIcon, href: "/gateway/logs" },
      {
        label: "Telemetry",
        searchText: "Telemetry",
        icon: RadioTowerIcon,
        href: "/gateway/telemetry",
        matchNested: true,
      },
    ],
  },
];

/**
 * Settings screen (`docs/Interface_Design.md` §5.2): a 240px sidebar with `Back to app`, a
 * search over page names, the **Account** pages (Better Auth UI views and Models, which follow
 * the user), and the workspace pages headed by the Workspace switcher and divided into labelled
 * subgroups. Search hides non-matching pages and any subgroup left empty. Route components render
 * only their page content (header + Group lists) as `children`. Page switches are plain
 * navigation, so instant.
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
    { label: "Models", searchText: "Models", icon: CpuIcon, href: "/settings/models" },
    {
      label: "Notifications",
      searchText: "Notifications",
      icon: BellIcon,
      href: "/settings/notifications",
    },
  ];

  function matchingItems(items: NavItem[]) {
    return items.filter((item) => item.searchText.toLowerCase().includes(normalizedQuery));
  }

  function renderItems(items: NavItem[]) {
    return items.map((item) => {
      const isActive =
        pathname === item.href ||
        (item.matchNested === true && pathname.startsWith(`${item.href}/`));

      return (
        <SideColumnItem key={item.href} asChild isActive={isActive}>
          <Link to={item.href}>
            {item.icon ? (
              <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
                <item.icon className={item.iconClassName} />
              </span>
            ) : null}
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
            <div className="flex flex-col gap-0.5">{renderItems(matchingItems(accountItems))}</div>
          </SideColumnSection>

          <SideColumnSection title={<WorkspaceSwitcher variant="heading" />}>
            <div className="flex flex-col gap-3">
              {workspaceGroups.map((group) => {
                const items = matchingItems(group.items);
                if (items.length === 0) return null;

                const labelId = `settings-group-${group.label.toLowerCase()}`;
                return (
                  <div
                    key={group.label}
                    role="group"
                    aria-labelledby={labelId}
                    className="flex flex-col gap-0.5"
                  >
                    <div
                      id={labelId}
                      className="flex h-6 items-center px-3 text-xs text-subtle-foreground"
                    >
                      {group.label}
                    </div>
                    {renderItems(items)}
                  </div>
                );
              })}
            </div>
          </SideColumnSection>
        </>
      }
    >
      {children}
    </SideColumnLayout>
  );
}
