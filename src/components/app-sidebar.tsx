import * as React from "react"
import { useQuery } from "convex/react"
import { useRouterState } from "@tanstack/react-router"

import { NavMain } from "@/components/nav-main"
import { NavSecondary } from "@/components/nav-secondary"
import { UserButton } from "@/components/auth/user/user-button"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar"
import { api } from "../../convex/_generated/api"
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
  const chats = useQuery(api.aisdk.ListChats, {})
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const chatSections = Array.isArray(chats) ? groupChatsByLastInteraction(chats) : []

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
        <SidebarGroup className="group-data-[collapsible=icon]:hidden">
          <SidebarGroupLabel>Recent chats</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {chats === undefined ? (
                <SidebarMenuItem>
                  <SidebarMenuButton disabled size="sm">
                    <span>Loading chats...</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ) : typeof chats === "string" ? (
                <SidebarMenuItem>
                  <SidebarMenuButton disabled size="sm">
                    <span>Sign in to view chats</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ) : chats.length === 0 ? (
                <SidebarMenuItem>
                  <SidebarMenuButton disabled size="sm">
                    <span>No chats yet</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ) : (
                chatSections.map((section) => (
                  <React.Fragment key={section.label}>
                    <SidebarMenuItem>
                      <div className="px-3 pt-2 pb-1 text-[0.6875rem] font-medium text-sidebar-foreground/50">
                        {section.label}
                      </div>
                    </SidebarMenuItem>
                    {section.chats.map((chat) => {
                      const url = `/chat/${chat.id}`
                      const title = chat.title?.trim()
                      const fallbackTitle = chat.activeStream
                        ? "Generating"
                        : "No title defined"

                      return (
                        <SidebarMenuItem key={chat.id}>
                          <SidebarMenuButton
                            asChild
                            isActive={pathname === url}
                            size="sm"
                            tooltip={title || fallbackTitle}
                          >
                            <a href={url}>
                              {title ? chat.emoji ? (
                                <span className="flex size-4 shrink-0 items-center justify-center text-sm leading-none">
                                  {chat.emoji}
                                </span>
                              ) : (
                                <MessageSquareTextIcon />
                              ) : (
                                <AnimatedDotsIcon />
                              )}
                              {title ? (
                                <span>{title}</span>
                              ) : (
                                <span className="text-sidebar-foreground/50 italic">
                                  {fallbackTitle}
                                </span>
                              )}
                            </a>
                          </SidebarMenuButton>
                        </SidebarMenuItem>
                      )
                    })}
                  </React.Fragment>
                ))
              )}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <NavSecondary items={data.navSecondary} className="mt-auto" />
      </SidebarContent>
      <SidebarFooter>
        <UserButton align="start" className="w-full justify-start" />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}

type SidebarChat = {
  id: string
  title?: string
  emoji?: string
  lastInteractionAt: number
  activeStream: boolean
}

function AnimatedDotsIcon() {
  return (
    <span
      aria-hidden="true"
      className="flex size-4 shrink-0 items-center justify-center gap-0.5 text-sidebar-foreground/50"
    >
      <span className="size-1 rounded-full bg-current motion-safe:animate-pulse" />
      <span className="size-1 rounded-full bg-current motion-safe:animate-pulse motion-safe:[animation-delay:150ms]" />
      <span className="size-1 rounded-full bg-current motion-safe:animate-pulse motion-safe:[animation-delay:300ms]" />
    </span>
  )
}

function groupChatsByLastInteraction(chats: SidebarChat[]) {
  const now = Date.now()
  const sections = [
    { label: "Past 7 days", chats: [] as SidebarChat[] },
    ...Array.from({ length: 12 }, (_, index) => ({
      label: `${index + 1} month${index === 0 ? "" : "s"} ago`,
      chats: [] as SidebarChat[],
    })),
    { label: "Past years", chats: [] as SidebarChat[] },
  ]

  for (const chat of chats) {
    const ageInDays = (now - chat.lastInteractionAt) / (1000 * 60 * 60 * 24)

    if (ageInDays <= 7) {
      sections[0].chats.push(chat)
    } else if (ageInDays <= 365) {
      const monthIndex = Math.min(Math.ceil(ageInDays / 30), 12)
      sections[monthIndex].chats.push(chat)
    } else {
      sections[13].chats.push(chat)
    }
  }

  return sections.filter((section) => section.chats.length > 0)
}
