"use client";

import { useAuth } from "@better-auth-ui/react";
import { Link } from "@tanstack/react-router";
import { ArrowLeftIcon, Shield, User2 } from "lucide-react";

import { chatroomSections } from "@/components/chatroom/chatroom-settings";
import { gatewaySections } from "@/components/gateway/gateway-settings";
import {
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";

/**
 * Contextual sidebar shown while a `/settings/*` or `/gateway/*` route is active.
 *
 * Replaces the main app navigation with a unified list of settings views (account,
 * security, plus plugin-provided tabs) and gateway sections, mirroring the tabs that
 * previously lived on top of each page. A "Back to chat" action returns to the main app.
 *
 * @param pathname - The current router pathname, used to mark the active entry
 */
export function SettingsSidebarSections({ pathname }: { pathname: string }) {
  const { basePaths, viewPaths, plugins, localization, Link: AuthLink } = useAuth();

  const accountItems = [
    {
      label: localization.settings.account,
      href: `${basePaths.settings}/${viewPaths.settings.account}`,
      icon: User2,
    },
    {
      label: localization.settings.security,
      href: `${basePaths.settings}/${viewPaths.settings.security}`,
      icon: Shield,
    },
    ...plugins.flatMap(
      (plugin) =>
        plugin.settingsTabs?.map((settingsTab) => ({
          label: settingsTab.label,
          href: `${basePaths.settings}/${plugin.viewPaths?.settings?.[settingsTab.view]}`,
          icon: undefined,
        })) ?? [],
    ),
  ];

  return (
    <>
      <SidebarHeader className="animate-in fade-in-0 slide-in-from-right-8 duration-300">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton className="h-10 w-fit px-1.5" asChild>
              <Link to="/chat">
                <img
                  src="/radium_extended.svg"
                  alt="Radium"
                  className="h-5 w-auto invert dark:invert-0"
                />
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton className="text-muted-foreground" asChild>
              <Link to="/chat">
                <ArrowLeftIcon />
                <span>Back to chat</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent className="animate-in fade-in-0 slide-in-from-right-8 duration-300">
        <SidebarGroup>
          <SidebarGroupLabel>{localization.settings.settings}</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {accountItems.map((item) => (
                <SidebarMenuItem key={item.href}>
                  <SidebarMenuButton asChild isActive={pathname === item.href}>
                    <AuthLink href={item.href}>
                      {item.icon ? <item.icon /> : null}
                      <span>{item.label}</span>
                    </AuthLink>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel>Gateway</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {gatewaySections.map((entry) => (
                <SidebarMenuItem key={entry.value}>
                  <SidebarMenuButton asChild isActive={pathname === `/gateway/${entry.value}`}>
                    <Link to="/gateway/$section" params={{ section: entry.value }}>
                      <entry.icon />
                      <span>{entry.label}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel>Chatroom</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {chatroomSections.map((entry) => (
                <SidebarMenuItem key={entry.value}>
                  <SidebarMenuButton asChild isActive={pathname === `/chatroom/${entry.value}`}>
                    <Link to="/chatroom/$section" params={{ section: entry.value }}>
                      <entry.icon />
                      <span>{entry.label}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </>
  );
}
