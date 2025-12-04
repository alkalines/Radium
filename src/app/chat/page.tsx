import { MainLayout } from "@/components/chatroom/layout/MainLayout";
import { Header } from "@/components/chatroom/layout/Header";
import { ChatInput } from "@/components/chatroom/chat/ChatInput";
import { PromptCategories } from "@/components/chatroom/chat/PromptCategories";
import { CookieBanner } from "@/components/CookieBanner";
import { ClaudeIcon } from "@/components/ui/ClaudeIcon";

export default function HomePage() {
  return (
    <MainLayout>
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
              Oi Gabriel, tudo bem?
            </div>
          </div>
        </div>

        {/* Chat Input and Categories grouped */}
        <div className="top-5 z-10 mx-auto w-full max-w-2xl">
          <ChatInput />
          {/*<PromptCategories />*/}
        </div>
      </main>

      <Header />
      <CookieBanner />
    </MainLayout>
  );
}
