"use client";
import "@/app/globals.css";
import { ss4, DMSans } from "../fonts";
import { SidebarProvider } from "@/lib/contexts/SidebarContext";
import { ModelProvider } from "@/lib/contexts/ModelContext";
import { Conversation, User } from "@/types/chatroom";
import { Sidebar } from "@/components/chatroom/sidebar/Sidebar";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";

function Header() {
  return (
    <div className="fixed top-[9px] right-3 z-header flex items-center gap-3.5">
      <div>
        <button
          className="inline-flex items-center justify-center h-8 w-8 rounded-md text-text-300 hover:bg-bg-300 hover:text-text-100 active:scale-95 group"
          type="button"
        >
          <div className="flex items-center justify-center group">
            <svg
              width="20"
              height="20"
              viewBox="0 0 20 20"
              fill="currentColor"
              xmlns="http://www.w3.org/2000/svg"
              className="shrink-0 group"
              aria-hidden="true"
            >
              <g className="group-hover:animate-[look-around_2.4s_ease-in-out_infinite] group-active:animate-none">
                <path d="M6.99951 8.66672C7.5518 8.66672 7.99951 9.11443 7.99951 9.66672C7.9993 10.2188 7.55166 10.6667 6.99951 10.6667C6.44736 10.6667 5.99973 10.2188 5.99951 9.66672C5.99951 9.11443 6.44723 8.66672 6.99951 8.66672Z" />
                <path d="M12.9995 8.66672C13.5518 8.66672 13.9995 9.11443 13.9995 9.66672C13.9993 10.2188 13.5517 10.6667 12.9995 10.6667C12.4474 10.6667 11.9997 10.2188 11.9995 9.66672C11.9995 9.11443 12.4472 8.66672 12.9995 8.66672Z" />
              </g>
              <path
                fillRule="evenodd"
                clipRule="evenodd"
                d="M10 2C14.326 2.00018 17.9998 5.67403 18 10V17.3123C17.9997 17.5427 17.8411 17.8079 17.6172 17.8623C17.3932 17.9165 17.1614 17.7456 17.0557 17.5408C16.7805 17.007 16.3658 16.5937 16.062 16.2878C15.7793 16.0034 15.4503 15.8338 14.9771 15.8337C14.2092 15.8339 13.4371 16.3862 12.9487 17.53C12.8701 17.7138 12.6887 17.8621 12.4888 17.8623C12.2888 17.8623 12.1076 17.7138 12.0288 17.53C11.5404 16.386 10.7674 15.8339 9.99951 15.8337C9.23161 15.8339 8.45959 16.386 7.97119 17.53C7.89253 17.7138 7.71118 17.8621 7.51123 17.8623C7.31122 17.8623 7.13006 17.7138 7.05127 17.53C6.56296 16.3862 5.78982 15.834 5.02197 15.8337C4.54861 15.8338 4.21974 16.0032 3.93701 16.2878C3.63309 16.5937 3.21952 17.0715 2.94434 17.6055C2.83865 17.8103 2.60589 17.9165 2.38184 17.8623C2.15801 17.8079 2.00033 17.6073 2 17.377V10C2.00018 5.67403 5.67403 2.00018 10 2ZM10 3C6.22631 3.00018 3.00018 6.22631 3 10V15.8633C3.0205 15.8414 3.20696 15.6049 3.22803 15.5837C3.67524 15.1336 4.251 14.8338 5.02197 14.8337C6.03838 14.8341 6.90232 15.4025 7.51025 16.2937C8.11828 15.4018 8.9824 14.8338 9.99951 14.8337C11.0163 14.8338 11.8798 15.4022 12.4878 16.2937C13.0959 15.4018 13.9601 14.8339 14.9771 14.8337C15.7481 14.8338 16.3247 15.1336 16.772 15.5837C16.772 15.5837 16.9796 15.812 17 15.8337V10C16.9998 6.22631 13.7737 3.00018 10 3Z"
              />
            </svg>
          </div>
        </button>
      </div>
    </div>
  );
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  /**
   * @todo Use convex
   */
  const conversations: Conversation[] = [
    {
      id: "1",
      title: "Sem título",
      href: "/chat/e2d4da28-b22c-4101-b524-fd56a3ab91aa",
    },
    {
      id: "2",
      title: "Discord: Risks for Teenagers",
      href: "/chat/150e0208-2b37-4e94-84cd-6113af4a5b7e",
    },
    {
      id: "3",
      title:
        "The Impact of Mental Deterioration on Colombia's International Drug Trade",
      href: "/chat/fcbde3de-79bd-4855-978a-549ca2b4eefb",
    },
    {
      id: "4",
      title: "CRM Strategy for a Pet Shop",
      href: "/chat/041ee6b7-e40c-4563-a8cf-d24cb993260e",
    },
    {
      id: "5",
      title: "Greeting and Assistance",
      href: "/chat/81ed72a1-94db-47f9-bdbe-5b67b153321f",
    },
  ];
  const userInfo = useQuery(api.auth.userInfo, {})
  if (userInfo === 'Not logged in!' || !userInfo) return 'Error'

  return (
    <div
      lang="pt-BR"
      className={`h-screen antialiased scroll-smooth ${ss4.variable} ${DMSans.variable}`}
      data-theme="claude"
      data-mode="dark"
    >
      <div className="bg-bg-100 text-text-100 min-h-screen">
        <SidebarProvider>
          <ModelProvider>
            <div className="flex min-h-screen w-full overflow-x-clip">
              <Sidebar conversations={conversations} user={userInfo} />
              <Header />

              <div
                className="h-screen w-full relative min-w-0"
                style={{ padding: 0 }}
              >
                {children}
              </div>
            </div>
          </ModelProvider>
        </SidebarProvider>
      </div>
    </div>
  );
}
