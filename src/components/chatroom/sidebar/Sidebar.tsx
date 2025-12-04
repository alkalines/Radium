"use client";

import { Logo } from "@/components/ui/ClaudeLogo";
import { useSidebar } from "@/lib/contexts/SidebarContext";
import { Conversation, User } from "@/types/chatroom";
import { ConversationList } from "./ConversationList";
import { SidebarNav } from "./SidebarNav";
import { UserMenu } from "./UserMenu";
import { UserInfoType } from "../../../../convex/auth";

interface SidebarProps {
  conversations: Conversation[];
  user: UserInfoType;
}

export function Sidebar({ conversations, user }: SidebarProps) {
  const { isExpanded, toggleSidebar } = useSidebar();

  return (
    <div
      className="shrink-0"
      style={{
        overflow: "hidden",
        width: isExpanded ? "18rem" : "3.05rem",
        opacity: 1,
        transition: "width 200ms",
      }}
    >
      <div
        className="fixed z-sidebar lg:sticky"
        style={{
          width: isExpanded ? "18rem" : "3.05rem",
          transition: "width 200ms",
        }}
      >
        <nav
          className="h-screen flex flex-col gap-3 pb-2 px-0 fixed top-0 left-0 transition duration-100 border-border-300 border-r-0.5 shadow-lg lg:shadow-none !bg-bg-200"
          aria-label="Barra lateral"
          style={{
            width: isExpanded ? "18rem" : "3.05rem",
            transition: "width 200ms",
          }}
        >
          {/* Header */}
          <div className="flex w-full items-center gap-px p-2 transition-all duration-75 ease-out">
            <button
              className="inline-flex items-center justify-center h-8 w-8 rounded-md text-text-300 hover:bg-bg-300 hover:text-text-100 active:scale-95 group"
              type="button"
              data-testid="pin-sidebar-toggle"
              aria-label="Barra lateral"
              aria-expanded={isExpanded}
              onClick={toggleSidebar}
            >
              <div className="relative">
                {/* Ícone base (sidebar) */}
                <div
                  className={`flex items-center justify-center group-hover:scale-80 transition scale-100 text-text-300 ${isExpanded ? "group-hover:opacity-0" : ""}`}
                >
                  <svg
                    width="20"
                    height="20"
                    viewBox="0 0 20 20"
                    fill="currentColor"
                  >
                    <path d="M16.5 4C17.3284 4 18 4.67157 18 5.5V14.5C18 15.3284 17.3284 16 16.5 16H3.5C2.67157 16 2 15.3284 2 14.5V5.5C2 4.67157 2.67157 4 3.5 4H16.5ZM7 15H16.5C16.7761 15 17 14.7761 17 14.5V5.5C17 5.22386 16.7761 5 16.5 5H7V15ZM3.5 5C3.22386 5 3 5.22386 3 5.5V14.5C3 14.7761 3.22386 15 3.5 15H6V5H3.5Z" />
                  </svg>
                </div>

                {/* Ícone de hide (seta para esquerda) - aparece quando expanded e no hover */}
                {isExpanded && (
                  <svg
                    width="20"
                    height="20"
                    viewBox="0 0 20 20"
                    fill="currentColor"
                    xmlns="http://www.w3.org/2000/svg"
                    className="shrink-0 opacity-0 scale-75 absolute inset-0 group-hover:scale-100 group-hover:opacity-100 transition-all text-text-200"
                    aria-hidden="true"
                  >
                    <path d="M3.5 3C3.77614 3 4 3.22386 4 3.5V16.5L3.99023 16.6006C3.94371 16.8286 3.74171 17 3.5 17C3.25829 17 3.05629 16.8286 3.00977 16.6006L3 16.5V3.5C3 3.22386 3.22386 3 3.5 3ZM11.2471 5.06836C11.4476 4.95058 11.7104 4.98547 11.8721 5.16504C12.0338 5.34471 12.0407 5.60979 11.9023 5.79688L11.835 5.87207L7.80371 9.5H16.5C16.7761 9.5 17 9.72386 17 10C17 10.2761 16.7761 10.5 16.5 10.5H7.80371L11.835 14.1279C12.0402 14.3127 12.0568 14.6297 11.8721 14.835C11.6873 15.0402 11.3703 15.0568 11.165 14.8721L6.16504 10.3721L6.09473 10.2939C6.03333 10.2093 6 10.1063 6 10C6 9.85828 6.05972 9.72275 6.16504 9.62793L11.165 5.12793L11.2471 5.06836Z" />
                  </svg>
                )}
              </div>
            </button>

            {isExpanded && (
              <a
                className="flex flex-col justify-start items-top"
                aria-label="Início"
                href="/new"
              >
                <Logo />
              </a>
            )}
          </div>

          {/* Content */}
          <div
            className="flex flex-col align-center h-full overflow-hidden"
            aria-hidden={!isExpanded}
            style={{ opacity: isExpanded ? 1 : 0, transition: "opacity 200ms" }}
          >
            {isExpanded && (
              <>
                <SidebarNav />

                <div
                  className="flex flex-grow flex-col overflow-y-auto overflow-x-hidden relative px-2 mb-2"
                  tabIndex={-1}
                >
                  <ConversationList conversations={conversations} />
                </div>

                <UserMenu user={user} />
              </>
            )}
          </div>
        </nav>
      </div>
    </div>
  );
}
