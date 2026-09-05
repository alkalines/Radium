import type React from "react";

import { Message, MessageContent } from "@/components/ai-elements/message";
import { Skeleton } from "@/components/ui/skeleton";

const chatHandoffStoragePrefix = "radium:chat-handoff:";

export const chatComposerViewTransitionName = "chat-composer";

export function rememberChatHandoff(chatId: string, prompt: string) {
  if (typeof window === "undefined") {
    return;
  }

  window.sessionStorage.setItem(`${chatHandoffStoragePrefix}${chatId}`, prompt);
}

export function readChatHandoff(chatId: string) {
  if (typeof window === "undefined") {
    return null;
  }

  return window.sessionStorage.getItem(`${chatHandoffStoragePrefix}${chatId}`);
}

export function clearChatHandoff(chatId: string) {
  if (typeof window === "undefined") {
    return;
  }

  window.sessionStorage.removeItem(`${chatHandoffStoragePrefix}${chatId}`);
}

export function ChatHomeSkeleton() {
  return (
    <main className="flex min-h-[calc(100svh-var(--header-height))] flex-col items-center justify-center gap-8 p-4 md:p-8">
      <section className="flex w-full max-w-3xl items-center justify-center gap-4">
        <Skeleton className="size-12 rounded-full md:size-16" />
        <div className="flex flex-1 flex-col gap-3 sm:flex-none sm:items-center">
          <Skeleton className="h-8 w-56 md:h-12 md:w-96" />
          <Skeleton className="h-4 w-40 md:w-64" />
        </div>
      </section>

      <section className="w-full max-w-3xl rounded-3xl border bg-background/80 p-3 shadow-sm">
        <Skeleton className="h-24 w-full rounded-2xl" />
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex gap-2">
            <Skeleton className="h-9 w-32" />
            <Skeleton className="h-9 w-24" />
          </div>
          <Skeleton className="size-10 rounded-full" />
        </div>
      </section>
    </main>
  );
}

export function ChatConversationSkeleton() {
  return (
    <main className="flex min-h-[calc(100svh-var(--header-height))] flex-col">
      <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-8 px-4 py-8">
        <Skeleton className="h-5 w-40" />
        <div className="flex flex-col gap-6">
          <MessageSkeleton align="start" />
          <MessageSkeleton align="end" />
          <MessageSkeleton align="start" wide />
        </div>
      </div>

      <div className="sticky bottom-0 border-t bg-background/95 p-4 backdrop-blur">
        <div className="mx-auto w-full max-w-3xl rounded-3xl border bg-background/80 p-3 shadow-sm">
          <Skeleton className="h-20 w-full rounded-2xl" />
          <div className="mt-3 flex items-center justify-between gap-3">
            <Skeleton className="h-9 w-36" />
            <Skeleton className="size-10 rounded-full" />
          </div>
        </div>
      </div>
    </main>
  );
}

export function ChatStartingTransition({
  children,
  prompt,
}: {
  children: React.ReactNode;
  prompt: string;
}) {
  return (
    <main className="flex min-h-[calc(100svh-var(--header-height))] flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-4xl flex-col px-4 py-8">
          <Message className="animate-in fade-in slide-in-from-bottom-2 duration-500" from="user">
            <MessageContent>
              <p className="line-clamp-4 whitespace-pre-wrap">{prompt || "New chat"}</p>
            </MessageContent>
          </Message>
        </div>
      </div>

      <div className="sticky bottom-0 border-t bg-background/95 p-4 backdrop-blur">
        <div
          className="mx-auto w-full max-w-3xl"
          style={{ viewTransitionName: chatComposerViewTransitionName }}
        >
          {children}
        </div>
      </div>
    </main>
  );
}

function MessageSkeleton({ align, wide }: { align: "start" | "end"; wide?: boolean }) {
  return (
    <div className={`flex ${align === "end" ? "justify-end" : "justify-start"}`}>
      <div className="flex w-full max-w-[82%] flex-col gap-2">
        <Skeleton className={wide ? "h-5 w-full" : "h-5 w-2/3"} />
        <Skeleton className="h-5 w-5/6" />
        <Skeleton className="h-5 w-1/2" />
      </div>
    </div>
  );
}
