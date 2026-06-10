import { useMutation, useQuery } from "convex/react";
import { ensureSession as ensureSessionClient } from "@better-auth-ui/react";
import { ensureSession as ensureSessionServer } from "@better-auth-ui/react/server";
import {
  createFileRoute,
  Outlet,
  redirect,
  useRouterState,
} from "@tanstack/react-router";
import { createIsomorphicFn } from "@tanstack/react-start";
import { getRequestHeaders, getRequestUrl } from "@tanstack/react-start/server";
import { useCallback, useState } from "react";

import {
  ChatPromptInput,
  type ReasoningEffort,
} from "@/components/chat/chat-prompt-input";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { api } from "../../convex/_generated/api";
import { auth } from "@/lib/auth";
import { authClient } from "@/lib/auth-client";

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
        })
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
  const userInfo = useQuery(api.auth.userInfo);
  const models = useQuery(api.models.availableModels);
  const createChat = useMutation(api.aisdk.CreateChat);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [model, setModel] = useState<string>();
  const [reasoningBudget, setReasoningBudget] = useState<number>();
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>("medium");

  const userName =
    typeof userInfo === "string"
      ? "there"
      : (userInfo?.name ?? "there");
  const balance = typeof userInfo === "string" ? undefined : userInfo?.balances[0];
  const canSubmit = Boolean(balance && model && !isSubmitting);
  const selectedModelData = models?.find((item) => item.slug === model);
  const handleModelChange = useCallback((nextModel: string) => {
    setModel(nextModel);
  }, []);

  return (
    <main className="flex min-h-[calc(100svh-var(--header-height))] flex-col items-center justify-center gap-8 p-4 md:p-8">
      <section className="flex w-full max-w-3xl items-center justify-center gap-4 text-center">
        <img alt="Radium" className="size-12 md:size-16" src="/letters/R.svg" />
        <h1 className="text-3xl font-semibold tracking-tight md:text-5xl">
          Welcome back, {userName}
        </h1>
      </section>

      <section className="w-full max-w-3xl">
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

            if (!balance || !model) {
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
                  model,
                  ...(selectedModelData?.reasoning
                    ? { reasoningEffort }
                    : {}),
                  ...(selectedModelData?.features?.reasoning_budget && reasoningBudget
                    ? { reasoningBudget }
                    : {}),
                  webSearch: false,
                },
              });

              if (chatId === "Not logged in!") {
                throw new Error("Please sign in again.");
              }

              await navigate({
                to: "/chat/$chatId",
                params: { chatId },
              });
            } catch (caughtError) {
              setError(
                caughtError instanceof Error
                  ? caughtError.message
                  : "Something went wrong."
              );
            } finally {
              setIsSubmitting(false);
            }
          }}
          placeholder="Ask Radium anything..."
          reasoningBudget={reasoningBudget}
          reasoningEffort={reasoningEffort}
          selectedModel={model}
          status={isSubmitting ? "submitted" : "ready"}
        />
      </section>
    </main>
  );
}
