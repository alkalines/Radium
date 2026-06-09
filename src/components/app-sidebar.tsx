import * as React from "react"

import { NavMain } from "@/components/nav-main"
import { NavSecondary } from "@/components/nav-secondary"
import { UserButton } from "@/components/auth/user/user-button"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar"
import {
  BotIcon,
  Route as RouteIcon,
  MessageSquareTextIcon,
} from "lucide-react"

const data = {
  navMain: [
    {
      title: "Chat",
      url: "/chat",
      icon: MessageSquareTextIcon,
      isActive: true,
    },
    {
      title: "Models",
      url: "#",
      icon: BotIcon,
    },
    {
      title: "Gateway",
      url: "#",
      icon: RouteIcon,
    },
  ],
  navSecondary: [
    // {
    //   title: "Settings",
    //   url: "/settings/account",
    //   icon: Settings2Icon,
    // },
    // {
    //   title: "Help",
    //   url: "#",
    //   icon: LifeBuoyIcon,
    // },
  ],
}

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  return (
    <Sidebar className="border-r-0" {...props}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton className="h-10 w-fit px-1.5" asChild>
              <a href="/chat">
                <img
                  src="/radium_extended.svg"
                  alt="Radium"
                  className="h-5 w-auto invert dark:invert-0"
                />
              </a>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <NavMain items={data.navMain} />
      </SidebarHeader>
      <SidebarContent>
        <NavSecondary items={data.navSecondary} className="mt-auto" />
      </SidebarContent>
      <SidebarFooter>
        <UserButton align="start" className="w-full justify-start" />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
