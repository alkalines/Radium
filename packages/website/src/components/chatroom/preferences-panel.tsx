import { useCallback, useState } from "react";
import { convexQuery } from "@convex-dev/react-query";
import { useQuery } from "@tanstack/react-query";
import { useMutation } from "convex/react";
import { ChevronsUpDownIcon } from "lucide-react";
import { toast } from "sonner";

import {
  ModelSelector,
  ModelSelectorContent,
  ModelSelectorEmpty,
  ModelSelectorGroup,
  ModelSelectorInput,
  ModelSelectorItem,
  ModelSelectorList,
  ModelSelectorName,
} from "@/components/ai-elements/model-selector";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { api } from "../../../convex/_generated/api";

/**
 * Chatroom → Preferences. Currently a single setting: the default model new
 * chats pre-select in the composer. When unset, the composer falls back to the
 * first available model.
 */
export function PreferencesPanel() {
  const { data: userInfo } = useQuery(convexQuery(api.auth.userInfo, {}));
  const signedIn = userInfo !== undefined && typeof userInfo !== "string";
  const { data: models } = useQuery(convexQuery(api.models.availableModels, {}));
  const { data: defaultModel } = useQuery(
    convexQuery(api.chatroom.getModelDefault, signedIn ? {} : "skip"),
  );
  const { data: titleModel } = useQuery(
    convexQuery(api.chatroom.getTitleModelDefault, signedIn ? {} : "skip"),
  );
  const { data: chainOfThoughtEnabled } = useQuery(
    convexQuery(api.chatroom.getChainOfThoughtEnabled, signedIn ? {} : "skip"),
  );
  const setModelDefault = useMutation(api.chatroom.setModelDefault);
  const setTitleModelDefault = useMutation(api.chatroom.setTitleModelDefault);
  const setChainOfThoughtEnabled = useMutation(api.chatroom.setChainOfThoughtEnabled);

  const [open, setOpen] = useState(false);
  const [titleOpen, setTitleOpen] = useState(false);
  const selected = models?.find((model) => model.slug === defaultModel);
  const selectedTitleModel = models?.find((model) => model.slug === titleModel);
  const titleModels =
    models?.filter(
      (model) =>
        model.type === "chat" &&
        model.architecture.input_modalities.includes("text") &&
        model.architecture.output_modalities.includes("text"),
    ) ?? [];

  const persist = useCallback(
    async (model: string | undefined) => {
      if (!signedIn) return;
      try {
        await setModelDefault({ model });
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Failed to update default model.");
      }
    },
    [signedIn, setModelDefault],
  );

  const persistTitleModel = useCallback(
    async (model: string | undefined) => {
      if (!signedIn) return;
      try {
        await setTitleModelDefault({ model });
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Failed to update title model.");
      }
    },
    [signedIn, setTitleModelDefault],
  );

  const persistChainOfThought = useCallback(
    async (enabled: boolean) => {
      if (!signedIn) return;
      try {
        await setChainOfThoughtEnabled({ enabled });
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "Failed to update Chain of Thought setting.",
        );
      }
    },
    [signedIn, setChainOfThoughtEnabled],
  );

  return (
    <div className="flex flex-col gap-4">
      <section className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold tracking-tight">Default model</h2>
          <p className="text-sm text-muted-foreground">
            The model new chats start with. When unset, the composer uses the first available model.
          </p>
        </div>

        {userInfo !== undefined && typeof userInfo === "string" ? (
          <Alert>
            <AlertTitle>Sign in required</AlertTitle>
            <AlertDescription>Sign in to set a default model.</AlertDescription>
          </Alert>
        ) : userInfo === undefined || models === undefined ? (
          <Skeleton className="h-10 w-full max-w-sm" />
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <ModelSelector onOpenChange={setOpen} open={open}>
              <ModelSelectorContent className="w-[min(calc(100vw-2rem),34rem)]">
                <ModelSelectorInput placeholder="Search models..." />
                <ModelSelectorList>
                  <ModelSelectorEmpty>No models found.</ModelSelectorEmpty>
                  <ModelSelectorGroup heading="Models">
                    {titleModels.map((model) => {
                      const displayName = model.author
                        ? `${model.author.name}: ${model.name}`
                        : model.name;
                      return (
                        <ModelSelectorItem
                          key={model.slug}
                          data-checked={model.slug === defaultModel}
                          keywords={[displayName, model.name, model.author?.name ?? ""]}
                          onSelect={() => {
                            void persist(model.slug);
                            setOpen(false);
                          }}
                          value={model.slug}
                        >
                          {model.author ? (
                            <img
                              alt={`${model.author.name} logo`}
                              className="size-5 shrink-0 rounded-full bg-white p-0.5 ring-1 ring-border/70"
                              height={16}
                              src={`https://models.dev/logos/labs/${model.author.slug}.svg`}
                              width={16}
                            />
                          ) : null}
                          <ModelSelectorName>{displayName}</ModelSelectorName>
                        </ModelSelectorItem>
                      );
                    })}
                  </ModelSelectorGroup>
                </ModelSelectorList>
              </ModelSelectorContent>
              <Button
                variant="outline"
                className="w-full max-w-sm justify-between font-normal"
                disabled={!signedIn}
                onClick={() => setOpen(true)}
              >
                <span className="truncate">
                  {selected
                    ? selected.author
                      ? `${selected.author.name}: ${selected.name}`
                      : selected.name
                    : "Auto (first available)"}
                </span>
                <ChevronsUpDownIcon className="size-4 shrink-0 opacity-60" />
              </Button>
            </ModelSelector>

            {defaultModel ? (
              <Button variant="ghost" onClick={() => void persist(undefined)} disabled={!signedIn}>
                Reset
              </Button>
            ) : null}
          </div>
        )}
      </section>

      <section className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold tracking-tight">Title model</h2>
          <p className="text-sm text-muted-foreground">
            The model that names new chats from your first message. When unset, it follows your
            default model, then falls back to the first available model.
          </p>
        </div>

        {userInfo !== undefined && typeof userInfo === "string" ? (
          <Alert>
            <AlertTitle>Sign in required</AlertTitle>
            <AlertDescription>Sign in to set a title generator model.</AlertDescription>
          </Alert>
        ) : userInfo === undefined || models === undefined ? (
          <Skeleton className="h-10 w-full max-w-sm" />
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <ModelSelector onOpenChange={setTitleOpen} open={titleOpen}>
              <ModelSelectorContent className="w-[min(calc(100vw-2rem),34rem)]">
                <ModelSelectorInput placeholder="Search models..." />
                <ModelSelectorList>
                  <ModelSelectorEmpty>No models found.</ModelSelectorEmpty>
                  <ModelSelectorGroup heading="Models">
                    {models.map((model) => {
                      const displayName = model.author
                        ? `${model.author.name}: ${model.name}`
                        : model.name;
                      return (
                        <ModelSelectorItem
                          key={model.slug}
                          data-checked={model.slug === titleModel}
                          keywords={[displayName, model.name, model.author?.name ?? ""]}
                          onSelect={() => {
                            void persistTitleModel(model.slug);
                            setTitleOpen(false);
                          }}
                          value={model.slug}
                        >
                          {model.author ? (
                            <img
                              alt={`${model.author.name} logo`}
                              className="size-5 shrink-0 rounded-full bg-white p-0.5 ring-1 ring-border/70"
                              height={16}
                              src={`https://models.dev/logos/labs/${model.author.slug}.svg`}
                              width={16}
                            />
                          ) : null}
                          <ModelSelectorName>{displayName}</ModelSelectorName>
                        </ModelSelectorItem>
                      );
                    })}
                  </ModelSelectorGroup>
                </ModelSelectorList>
              </ModelSelectorContent>
              <Button
                variant="outline"
                className="w-full max-w-sm justify-between font-normal"
                disabled={!signedIn}
                onClick={() => setTitleOpen(true)}
              >
                <span className="truncate">
                  {selectedTitleModel
                    ? selectedTitleModel.author
                      ? `${selectedTitleModel.author.name}: ${selectedTitleModel.name}`
                      : selectedTitleModel.name
                    : "Auto (default chat model)"}
                </span>
                <ChevronsUpDownIcon className="size-4 shrink-0 opacity-60" />
              </Button>
            </ModelSelector>

            {titleModel ? (
              <Button
                variant="ghost"
                onClick={() => void persistTitleModel(undefined)}
                disabled={!signedIn}
              >
                Reset
              </Button>
            ) : null}
          </div>
        )}
      </section>

      <section className="flex max-w-xl items-center justify-between gap-6">
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold tracking-tight">Enable Chain of Thought</h2>
          <p className="text-sm text-muted-foreground">
            Combine model reasoning, tool activity, and web search results into a single timeline.
          </p>
        </div>
        {userInfo === undefined || chainOfThoughtEnabled === undefined ? (
          <Skeleton className="h-5 w-8 shrink-0" />
        ) : (
          <Switch
            aria-label="Enable Chain of Thought"
            checked={chainOfThoughtEnabled}
            disabled={!signedIn}
            onCheckedChange={(checked) => void persistChainOfThought(checked)}
          />
        )}
      </section>
    </div>
  );
}
