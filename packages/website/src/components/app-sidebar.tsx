import * as React from "react";
import { convexQuery } from "@convex-dev/react-query";
import { useQuery } from "@tanstack/react-query";
import { useMutation } from "convex/react";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { toast } from "sonner";

import { NavMain } from "@/components/nav-main";
import { NavSecondary } from "@/components/nav-secondary";
import { SettingsSidebarSections } from "@/components/settings-sidebar";
import { UserButton } from "@/components/auth/user/user-button";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenuAction,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import {
  BotIcon,
  MoreHorizontalIcon,
  MessageSquareTextIcon,
  PencilIcon,
  PinIcon,
  PinOffIcon,
  Route as RouteIcon,
  SparklesIcon,
  Trash2Icon,
} from "lucide-react";

const data = {
  navMain: [
    {
      title: "Chat",
      url: "/chat" as const,
      icon: MessageSquareTextIcon,
      isActive: true,
    },
    {
      title: "Models",
      url: "#" as const,
      icon: BotIcon,
    },
    {
      title: "Gateway",
      url: "/gateway" as const,
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
};

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  // Subscribe to chats here (not in MainSidebarSections) so the query stays alive while
  // the settings/gateway nav is shown, avoiding a "Loading chats..." flash on return.
  const { data: chats } = useQuery(convexQuery(api.aisdk.ListChats, {}));
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const inSettings =
    pathname.startsWith("/settings") ||
    pathname.startsWith("/gateway") ||
    pathname.startsWith("/chatroom");

  return (
    <Sidebar className="border-r-0" {...props}>
      {inSettings ? (
        <SettingsSidebarSections pathname={pathname} />
      ) : (
        <MainSidebarSections pathname={pathname} chats={chats} />
      )}
      <SidebarFooter>
        <UserButton align="start" className="w-full justify-start" />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

function MainSidebarSections({
  pathname,
  chats,
}: {
  pathname: string;
  chats: SidebarChat[] | string | undefined;
}) {
  const chatSections = Array.isArray(chats) ? groupChatsByLastInteraction(chats) : [];
  const navigate = useNavigate();

  return (
    <>
      <SidebarHeader className="animate-in fade-in-0 slide-in-from-left-8 duration-300">
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
        </SidebarMenu>
        <NavMain items={data.navMain} />
      </SidebarHeader>
      <SidebarContent className="animate-in fade-in-0 slide-in-from-left-8 duration-300">
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
                      const url = `/chat/${chat.id}`;
                      const title = chat.title?.trim();
                      const fallbackTitle = chat.activeStream ? "Generating" : "No title defined";

                      return (
                        <SidebarMenuItem key={chat.id}>
                          <SidebarMenuButton
                            asChild
                            isActive={pathname === url}
                            size="sm"
                            tooltip={title || fallbackTitle}
                            className="pr-7"
                          >
                            <Link to="/chat/$chatId" params={{ chatId: chat.id }}>
                              {title ? (
                                chat.emoji ? (
                                  <span className="flex size-4 shrink-0 items-center justify-center text-sm leading-none">
                                    {chat.emoji}
                                  </span>
                                ) : (
                                  <MessageSquareTextIcon />
                                )
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
                            </Link>
                          </SidebarMenuButton>
                          <ChatMenu chat={chat} pathname={pathname} navigate={navigate} />
                        </SidebarMenuItem>
                      );
                    })}
                  </React.Fragment>
                ))
              )}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <NavSecondary items={data.navSecondary} className="mt-auto" />
      </SidebarContent>
    </>
  );
}

type SidebarChat = {
  id: Id<"aisdk_chats">;
  title?: string;
  emoji?: string;
  pinnedAt?: number;
  lastInteractionAt: number;
  activeStream: boolean;
};

function ChatMenu({
  chat,
  pathname,
  navigate,
}: {
  chat: SidebarChat;
  pathname: string;
  navigate: ReturnType<typeof useNavigate>;
}) {
  const [renameOpen, setRenameOpen] = React.useState(false);
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const [title, setTitle] = React.useState(chat.title?.trim() ?? "");
  const [pendingAction, setPendingAction] = React.useState<string | null>(null);

  const setPinned = useMutation(api.aisdk.SetChatPinned);
  const renameChat = useMutation(api.aisdk.RenameChat);
  const regenerateTitle = useMutation(api.aisdk.RegenerateChatTitle);
  const deleteChat = useMutation(api.aisdk.DeleteChat);

  React.useEffect(() => {
    if (!renameOpen) setTitle(chat.title?.trim() ?? "");
  }, [chat.title, renameOpen]);

  const runMenuAction = async (action: string, callback: () => Promise<unknown>) => {
    setPendingAction(action);
    try {
      const result = await callback();
      if (typeof result === "string") {
        toast.error(result);
        return;
      }

      if (action === "pin") toast.success(chat.pinnedAt ? "Chat unpinned." : "Chat pinned.");
      if (action === "regenerate") toast.success("Regenerating chat title.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Chat action failed.");
    } finally {
      setPendingAction(null);
    }
  };

  const submitRename = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = title.trim();
    if (!trimmed) return;

    await runMenuAction("rename", async () => {
      const result = await renameChat({ chatId: chat.id, title: trimmed });
      if (typeof result !== "string") {
        toast.success("Chat renamed.");
        setRenameOpen(false);
      }
      return result;
    });
  };

  const confirmDelete = async () => {
    await runMenuAction("delete", async () => {
      const result = await deleteChat({ chatId: chat.id });
      if (typeof result !== "string") {
        toast.success("Chat deleted.");
        setDeleteOpen(false);
        if (pathname === `/chat/${chat.id}`) await navigate({ to: "/chat" });
      }
      return result;
    });
  };

  const disabled = pendingAction !== null;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <SidebarMenuAction showOnHover aria-label="Open chat actions">
            <MoreHorizontalIcon />
          </SidebarMenuAction>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuGroup>
            <DropdownMenuItem
              disabled={disabled}
              onSelect={() =>
                runMenuAction("pin", () => setPinned({ chatId: chat.id, pinned: !chat.pinnedAt }))
              }
            >
              {chat.pinnedAt ? <PinOffIcon /> : <PinIcon />}
              {chat.pinnedAt ? "Unpin" : "Pin"}
            </DropdownMenuItem>
            <DropdownMenuItem disabled={disabled} onSelect={() => setRenameOpen(true)}>
              <PencilIcon />
              Rename
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={disabled}
              onSelect={() =>
                runMenuAction("regenerate", () => regenerateTitle({ chatId: chat.id }))
              }
            >
              <SparklesIcon />
              Regenerate title
            </DropdownMenuItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuItem
              disabled={disabled}
              variant="destructive"
              onSelect={() => setDeleteOpen(true)}
            >
              <Trash2Icon />
              Delete
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent className="sm:max-w-sm">
          <form onSubmit={submitRename} className="contents">
            <DialogHeader>
              <DialogTitle>Rename chat</DialogTitle>
              <DialogDescription>Give this conversation a short sidebar title.</DialogDescription>
            </DialogHeader>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor={`chat-title-${chat.id}`}>Title</FieldLabel>
                <Input
                  id={`chat-title-${chat.id}`}
                  value={title}
                  maxLength={32}
                  autoFocus
                  onChange={(event) => setTitle(event.target.value)}
                />
              </Field>
            </FieldGroup>
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline">
                  Cancel
                </Button>
              </DialogClose>
              <Button type="submit" disabled={disabled || !title.trim()}>
                Save
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete chat?</DialogTitle>
            <DialogDescription>
              This removes the conversation from your chat history. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="button" variant="destructive" disabled={disabled} onClick={confirmDelete}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
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
  );
}

function groupChatsByLastInteraction(chats: SidebarChat[]) {
  const now = Date.now();
  const sections = [
    { label: "Pinned", chats: [] as SidebarChat[] },
    { label: "Past 7 days", chats: [] as SidebarChat[] },
    ...Array.from({ length: 12 }, (_, index) => ({
      label: `${index + 1} month${index === 0 ? "" : "s"} ago`,
      chats: [] as SidebarChat[],
    })),
    { label: "Past years", chats: [] as SidebarChat[] },
  ];

  for (const chat of chats) {
    if (chat.pinnedAt) {
      sections[0].chats.push(chat);
      continue;
    }

    const ageInDays = (now - chat.lastInteractionAt) / (1000 * 60 * 60 * 24);

    if (ageInDays <= 7) {
      sections[1].chats.push(chat);
    } else if (ageInDays <= 365) {
      const monthIndex = Math.min(Math.ceil(ageInDays / 30), 12);
      sections[monthIndex + 1].chats.push(chat);
    } else {
      sections[14].chats.push(chat);
    }
  }

  return sections.filter((section) => section.chats.length > 0);
}
