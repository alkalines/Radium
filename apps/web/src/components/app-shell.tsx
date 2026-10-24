import type { ReactNode } from "react";
import { useRouterState } from "@tanstack/react-router";

import { AppSidebar } from "@/components/app-sidebar";
import { SiteHeader } from "@/components/site-header";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";

export function AppShell({ children }: { children: ReactNode }) {
  const isBare = useRouterState({
    select: (state) => state.matches.some((match) => match.staticData.shell === "bare"),
  });

  if (isBare) return children;

  return (
    <SidebarProvider className="[--header-height:3.5rem]">
      <AppSidebar variant="inset" />
      <SidebarInset>
        <SiteHeader />
        {children}
      </SidebarInset>
    </SidebarProvider>
  );
}
