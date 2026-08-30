"use client";

import type { LucideIcon } from "lucide-react";
import { Link } from "@tanstack/react-router";

import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";

type NavMainItem = {
  title: string;
  url: "/chat" | "/gateway" | "#";
  icon: LucideIcon;
  isActive?: boolean;
};

export function NavMain({ items }: { items: NavMainItem[] }) {
  return (
    <SidebarMenu>
      {items.map((item) => (
        <SidebarMenuItem key={item.title}>
          <SidebarMenuButton asChild isActive={item.isActive} tooltip={item.title}>
            {item.url === "#" ? (
              <a href={item.url}>
                <item.icon />
                <span>{item.title}</span>
              </a>
            ) : (
              <Link to={item.url}>
                <item.icon />
                <span>{item.title}</span>
              </Link>
            )}
          </SidebarMenuButton>
        </SidebarMenuItem>
      ))}
    </SidebarMenu>
  );
}
