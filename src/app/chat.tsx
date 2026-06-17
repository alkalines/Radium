import { convexQuery } from "@convex-dev/react-query";
import { useQuery } from "@tanstack/react-query";
import { useMutation } from "convex/react";
import { ensureSession as ensureSessionClient } from "@better-auth-ui/react";
import { ensureSession as ensureSessionServer } from "@better-auth-ui/react/server";
import { createFileRoute, Outlet, redirect, useRouterState } from "@tanstack/react-router";
import { createIsomorphicFn } from "@tanstack/react-start";
import { getRequestHeaders, getRequestUrl } from "@tanstack/react-start/server";
import { useCallback, useState } from "react";

import { ChatPromptInput, type ReasoningEffort } from "@/components/chat/chat-prompt-input";
import { ChatToolsMenu } from "@/components/chat/chat-tools-menu";
import {
  chatComposerViewTransitionName,
  rememberChatHandoff,
} from "@/components/chat/chat-loading";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "../../convex/_generated/api";
import { auth } from "@/lib/auth";
import { authClient } from "@/lib/auth-client";

const welcomeTexts = {
  anytime: [
    "{name} returns!",
    "Back at it, {name}",
    "Back at it!",
    "Greetings, whoever you are",
    "Hey there",
    "Hey there, {name}",
    "Hi {name}, how are you?",
    "Hi, how are you?",
    "How was your day, {name}?",
    "How was your day?",
    "How's it going, {name}?",
    "How's it going?",
    "Ready when you are, {name}.",
    "Start anywhere, {name}.",
    "Welcome",
    "Welcome, {name}",
    "What's new, {name}?",
    "What's new?",
    "What's on your mind, {name}?",
    "What's on your mind?",
  ],
  temporary: ["Let's chat incognito", "You're incognito"],
  morning: ["Good morning", "Good morning, {name}"],
  afternoon: ["Good afternoon", "Good afternoon, {name}"],
  evening: [
    "Coffee and Claude time?",
    "Evening",
    "Evening, {name}",
    "Good evening",
    "Good evening, {name}",
    "Hello, night owl",
    "What's on your mind tonight?",
  ],
  weekend: ["Welcome to the weekend", "Welcome to the weekend, {name}"],
  weekdays: [
    ["Happy Sunday", "Happy Sunday, {name}", "Sunday session?", "Sunday session, {name}?"],
    ["Happy Monday", "Happy Monday, {name}"],
    ["Happy Tuesday", "Happy Tuesday, {name}"],
    ["Happy Wednesday", "Happy Wednesday, {name}"],
    ["Happy Thursday", "Happy Thursday, {name}"],
    ["Happy Friday", "Happy Friday, {name}", "That Friday feeling", "That Friday feeling, {name}"],
    ["Happy Saturday!", "Happy Saturday, {name}"],
  ],
};

const welcomeTextCount = Object.values(welcomeTexts).reduce((count, value) => {
  if (value.length > 0 && Array.isArray(value[0])) {
    return count + (value as string[][]).flat().length;
  }

  return count + (value as string[]).length;
}, 0);

function getRandomWelcomeText(name: string | undefined, index: number, date = new Date()) {
  const hour = date.getHours();
  const day = date.getDay();
  const timeOfDayTexts =
    hour < 12 ? welcomeTexts.morning : hour < 17 ? welcomeTexts.afternoon : welcomeTexts.evening;
  const candidates = [
    ...welcomeTexts.anytime,
    ...timeOfDayTexts,
    ...welcomeTexts.weekdays[day],
    ...(day === 0 || day === 6 ? welcomeTexts.weekend : []),
  ].filter((text) => name || !text.includes("{name}"));
  const welcomeText = candidates[index % candidates.length] ?? "Welcome";

  return name ? welcomeText.replace("{name}", name) : welcomeText;
}

export const Route = createFileRoute("/chat")({
  staticData: {
    pageTitle: "Chat",
  },
  async beforeLoad({ context: { queryClient }, location }) {
    const ensureSession = createIsomorphicFn()
      .server(() =>
        ensureSessionServer(queryClient, auth as any, {
          baseURL: getRequestUrl().origin,
          headers: getRequestHeaders(),
        }),
      )
      .client(() => ensureSessionClient(queryClient, authClient));

    const session = await ensureSession();

    if (!session) {
      throw redirect({
        to: "/auth/$path",
        params: { path: "sign-in" },
        search: { redirectTo: location.href },
      });
    }

    return { session };
  },
  loader: ({ context: { queryClient } }) => {
    void queryClient.prefetchQuery(convexQuery(api.auth.userInfo, {}));
    void queryClient.prefetchQuery(convexQuery(api.models.availableModels, {}));
  },
  component: ChatRouteComponent,
});

function ChatRouteComponent() {
  const isChildRoute = useRouterState({
    select: (state) => state.location.pathname !== "/chat",
  });

  return isChildRoute ? <Outlet /> : <ChatHomePage />;
}

function ChatHomePage() {
  const navigate = Route.useNavigate();
  const { data: userInfo } = useQuery(convexQuery(api.auth.userInfo, {}));
  const { data: models } = useQuery(convexQuery(api.models.availableModels, {}));
  const createChat = useMutation(api.aisdk.CreateChat);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [model, setModel] = useState<string>();
  const [reasoningBudget, setReasoningBudget] = useState<number>();
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>("medium");
  const [welcomeIndex] = useState(() => Math.floor(Math.random() * welcomeTextCount));

  const userName = typeof userInfo === "string" ? undefined : userInfo?.name;
  const welcomeText = getRandomWelcomeText(userName, welcomeIndex);
  const balance = typeof userInfo === "string" ? undefined : userInfo?.balances[0];
  const signedIn = userInfo !== undefined && typeof userInfo !== "string";
  const { data: defaultModel } = useQuery(
    convexQuery(api.chatroom.getModelDefault, signedIn ? {} : "skip"),
  );
  // The composer's effective model: explicit choice, then the user's saved
  // default, then the first available model as a last resort.
  const selectedModel = model ?? defaultModel ?? models?.[0]?.slug;
  const canSubmit = Boolean(balance && selectedModel && !isSubmitting);
  const selectedModelData = models?.find((item) => item.slug === selectedModel);
  const handleModelChange = useCallback((nextModel: string) => {
    setModel(nextModel);
  }, []);

  return (
    <main className="flex min-h-[calc(100svh-var(--header-height))] flex-col items-center justify-center gap-8 px-4 pb-[calc(1rem+var(--header-height))] pt-4 md:px-8 md:pb-[calc(2rem+var(--header-height))] md:pt-8">
      <section className="flex w-full max-w-3xl items-center justify-center gap-4 text-center">
        <img alt="Radium" className="size-12 md:size-16" src="/letters/R.svg" />
        <h1 className="max-w-2xl text-balance text-[clamp(1.5rem,4vw,2.5rem)] font-semibold leading-tight tracking-tight">
          {userInfo === undefined ? (
            <Skeleton className="mx-auto h-[1.2em] w-56 max-w-[60vw] md:w-96" />
          ) : (
            welcomeText
          )}
        </h1>
      </section>

      <section
        className="w-full max-w-3xl"
        style={{ viewTransitionName: chatComposerViewTransitionName }}
      >
        {error ? (
          <Alert className="mb-4" variant="destructive">
            <AlertTitle>Unable to start chat</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        <ChatPromptInput
          disabled={!canSubmit}
          models={models}
          onModelChange={handleModelChange}
          onReasoningBudgetChange={setReasoningBudget}
          onReasoningEffortChange={setReasoningEffort}
          onSubmit={async ({ text, files }) => {
            const trimmedText = text.trim();

            if (!trimmedText && files.length === 0) {
              return;
            }

            if (!balance || !selectedModel) {
              setError("Your account is not ready for chat yet.");
              return;
            }

            setError(null);
            setIsSubmitting(true);

            try {
              const chatId = await createChat({
                balance: balance._id,
                messages_queue: {
                  text: trimmedText,
                  files,
                  model: selectedModel,
                  ...(selectedModelData?.reasoning ? { reasoningEffort } : {}),
                  ...(selectedModelData?.features?.reasoning_budget && reasoningBudget
                    ? { reasoningBudget }
                    : {}),
                  webSearch: false,
                },
              });

              if (chatId === "Not logged in!") {
                throw new Error("Please sign in again.");
              }

              rememberChatHandoff(chatId, trimmedText);

              await navigateWithChatTransition(() =>
                navigate({
                  to: "/chat/$chatId",
                  params: { chatId },
                }),
              );
            } catch (caughtError) {
              setError(
                caughtError instanceof Error ? caughtError.message : "Something went wrong.",
              );
            } finally {
              setIsSubmitting(false);
            }
          }}
          placeholder="Ask Radium anything..."
          reasoningBudget={reasoningBudget}
          reasoningEffort={reasoningEffort}
          selectedModel={selectedModel}
          status={isSubmitting ? "submitted" : "ready"}
          toolsMenu={<ChatToolsMenu balance={balance?._id} />}
        />
      </section>
    </main>
  );
}

function navigateWithChatTransition(navigateToChat: () => Promise<void>) {
  if (typeof document === "undefined" || !("startViewTransition" in document)) {
    return navigateToChat();
  }

  return document.startViewTransition(() => navigateToChat()).finished;
}
