import { MainLayout } from "@/components/chatroom/layout/MainLayout";
import { ChatInput } from "@/components/chatroom/chat/ChatInput";
import { PromptCategories } from "@/components/chatroom/chat/PromptCategories";
import { CookieBanner } from "@/components/CookieBanner";
import { ClaudeIcon } from "@/components/ui/ClaudeIcon";
import { User, Conversation } from "@/types";

// ============================================
// CONFIGURABLE VARIABLES
// ============================================

const user: User = {
  name: "Gabriel Moneiro",
  email: "bielpau797@gmail.com",
  initials: "GM",
  plan: "plano Gratuito",
};

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
    title: "The Impact of Mental Deterioration on Colombia's International Drug Trade",
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

const welcomeMessage = `Oi ${user.name.split(" ")[0]}, tudo bem?`;

// ============================================

export default function HomePage() {
  return (
    <MainLayout conversations={conversations} user={user}>
      <main className="mx-auto mt-4 w-full flex-1 px-4 md:px-8 lg:mt-6 max-w-7xl !mt-0 flex flex-col items-center gap-8 md:px-14 3xl:px-20 pt-[10vh] md:pt-[20vh] max-sm:!px-1 bg-bg-100">
        {/* Welcome Section */}
        <div className="mx-auto flex w-full flex-col items-center gap-7 max-md:pt-4 max-w-2xl relative">
          {/* Spacer to maintain spacing (replaces plan banner) */}
          <div className="h-8"></div>
          <div
            className="font-display text-text-200 w-full flex-col items-center text-center max-md:flex sm:-ml-0.5 sm:block transition-opacity duration-300 ease-in"
            style={{
              fontSize: "clamp(1.875rem, 1.2rem + 2vw, 2.5rem)",
              lineHeight: 1.5,
            }}
          >
            <ClaudeIcon />
            <div
              className="font-normal font-serif inline-block max-w-full align-middle max-md:line-clamp-2 max-md:break-words md:overflow-hidden md:overflow-ellipsis select-none"
              style={{ opacity: 1 }}
            >
              {welcomeMessage}
            </div>
          </div>
        </div>

        {/* Chat Input and Categories grouped */}
        <div className="top-5 z-10 mx-auto w-full max-w-2xl">
          <ChatInput />
          {/*<PromptCategories />*/}
        </div>
      </main>

      <CookieBanner />
    </MainLayout>
  );
}
