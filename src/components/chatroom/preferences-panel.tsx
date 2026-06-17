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
  const setModelDefault = useMutation(api.chatroom.setModelDefault);

  const [open, setOpen] = useState(false);
  const selected = models?.find((model) => model.slug === defaultModel);

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

  return (
    <div className="flex flex-col gap-4">
      <section className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold tracking-tight">Default model</h2>
          <p className="text-sm text-muted-foreground">
            The model new chats start with. When unset, the composer uses the first available
            model.
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
                    {models.map((model) => {
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
    </div>
  );
}
