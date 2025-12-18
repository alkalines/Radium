"use client";
import { LetterIcon } from "@/components/ui/Letters";
import { Skeleton } from "@/components/chatroom/skeleton";
import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { useChat } from "@ai-sdk/react";
import { api } from "../../../convex/_generated/api";
import ChatroomPromptInput from "@/components/chatroom/chat/PromptInput";
import { PromptInputMessage } from "@/components/ai-elements/prompt-input";
import { UserInfoType } from "../../../convex/auth";
import { useRouter } from "next/navigation";

// ============================================

export default function HomePage() {
  // All hooks must be called unconditionally at the top level
  const userInfo = useQuery(api.auth.userInfo, {});
  const models = useQuery(api.models.availableModels);
  const authors = useQuery(api.authors.listAuthors);
  const createChat = useMutation(api.aisdk.CreateChat)

  const router = useRouter()

  const [selectedModel, setSelectedModel] = useState<string>();
  const [useWebSearch, setUseWebSearch] = useState<boolean>(false);
  const [text, setText] = useState<string>("");
  const { messages, status, sendMessage } = useChat();

  // Handle loading and not logged in states after all hooks
  const isLoading = userInfo === undefined;
  const isNotLoggedIn = userInfo === "Not logged in!";

  const handleSubmit = async (message: PromptInputMessage) => {
    const hasText = Boolean(message.text);
    const hasAttachments = Boolean(message.files?.length);
    if (!(hasText || hasAttachments)) {
      return;
    }
    const chatId = await createChat({
      balance: (userInfo as UserInfoType)!.balances[0]._id,
      messages_queue: {
        text: message.text || "Sent with attachments",
        files: message.files as any,
        model: models?.find((m) => m._id === selectedModel)!.slug!,
        webSearch: useWebSearch,
      },
    });
    router.push(`/chat/${chatId}`)
  };

  if (isNotLoggedIn) {
    return (
      <div className="flex h-full w-full flex-1 items-center justify-center">
        <p className="text-muted-foreground">Not logged in</p>
      </div>
    );
  }

  /**
   * @todo Dynamic day message
   */
  const welcomeMessage = isLoading 
    ? "" 
    : `Hey, ${userInfo.name.split(" ")[0]}!`;

  return (
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
          {isLoading ? null : <LetterIcon letter="R" />}
          <div
            className="font-normal font-serif inline-block max-w-full align-middle max-md:line-clamp-2 max-md:break-words md:overflow-hidden md:overflow-ellipsis select-none"
            style={{ opacity: 1 }}
          >
            {isLoading ? (
              <Skeleton className="h-10 w-48 inline-block" />
            ) : (
              welcomeMessage
            )}
          </div>
        </div>
      </div>

      {/* Chat Input and Categories grouped */}
      <div className="top-5 z-10 mx-auto w-full max-w-2xl">
        <ChatroomPromptInput
          models={models}
          authors={authors}
          chatStatus={status}
          handleSubmit={handleSubmit}
          StateUseWebSearch={[useWebSearch, setUseWebSearch]}
          StateSelectedModel={[selectedModel, setSelectedModel]}
          StateText={[text, setText]}
        />
        {/*<PromptCategories />*/}
      </div>
    </main>
  );
}
