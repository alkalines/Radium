import { useCallback, useState } from "react";
import { convexQuery } from "@convex-dev/react-query";
import { useQuery } from "@tanstack/react-query";
import { useMutation } from "convex/react";
import { ChevronDownIcon } from "lucide-react";
import { toast } from "sonner";

import { GroupList, Row, Tag } from "@/components/harness/group-list";
import { modelDisplayName, type ModelOption } from "@/components/models/model-options";
import { ModelList } from "@/components/models/model-list";
import { WorkspacePageHeader } from "@/components/settings/workspace-page-header";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { api } from "backend/convex/_generated/api";
import { useWorkspace } from "@/components/workspaces/workspace-provider";

/**
 * Chat defaults of the current workspace (owner-only; the route gates members): the model new
 * chats pre-select, the model that titles chats, the Chain of Thought timeline, and the system
 * prompt sent with every request. Unset models fall back to the first available model.
 */
export function PreferencesPanel() {
  const { workspaceId } = useWorkspace();
  const { data: userInfo } = useQuery(convexQuery(api.auth.userInfo, {}));
  const signedIn = userInfo !== undefined && typeof userInfo !== "string";
  const { data: models } = useQuery(
    convexQuery(api.models.availableModels, workspaceId ? { workspace: workspaceId } : "skip"),
  );
  const { data: defaultModel } = useQuery(
    convexQuery(
      api.chatroom.getModelDefault,
      signedIn && workspaceId ? { workspace: workspaceId } : "skip",
    ),
  );
  const { data: titleModel } = useQuery(
    convexQuery(
      api.chatroom.getTitleModelDefault,
      signedIn && workspaceId ? { workspace: workspaceId } : "skip",
    ),
  );
  const { data: chainOfThoughtEnabled } = useQuery(
    convexQuery(
      api.chatroom.getChainOfThoughtEnabled,
      signedIn && workspaceId ? { workspace: workspaceId } : "skip",
    ),
  );
  const { data: systemPrompt } = useQuery(
    convexQuery(
      api.chatroom.getSystemPromptSettings,
      signedIn && workspaceId ? { workspace: workspaceId } : "skip",
    ),
  );
  const setModelDefault = useMutation(api.chatroom.setModelDefault);
  const setTitleModelDefault = useMutation(api.chatroom.setTitleModelDefault);
  const setChainOfThoughtEnabled = useMutation(api.chatroom.setChainOfThoughtEnabled);
  const setSystemPromptSettings = useMutation(api.chatroom.setSystemPromptSettings);

  const [open, setOpen] = useState(false);
  const [titleOpen, setTitleOpen] = useState(false);
  const selected = models?.find((model) => model.slug === defaultModel);
  const selectedTitleModel = models?.find((model) => model.slug === titleModel);
  const chatModels =
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
        if (!workspaceId) return;
        await setModelDefault({ workspace: workspaceId, model });
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Failed to update default model.");
      }
    },
    [signedIn, setModelDefault, workspaceId],
  );

  const persistTitleModel = useCallback(
    async (model: string | undefined) => {
      if (!signedIn) return;
      try {
        if (!workspaceId) return;
        await setTitleModelDefault({ workspace: workspaceId, model });
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Failed to update title model.");
      }
    },
    [signedIn, setTitleModelDefault, workspaceId],
  );

  const persistChainOfThought = useCallback(
    async (enabled: boolean) => {
      if (!signedIn) return;
      try {
        if (!workspaceId) return;
        await setChainOfThoughtEnabled({ workspace: workspaceId, enabled });
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "Failed to update Chain of Thought setting.",
        );
      }
    },
    [signedIn, setChainOfThoughtEnabled, workspaceId],
  );

  const persistSystemPrompt = useCallback(
    async (settings: { enabled: boolean; modelIdentity: boolean }) => {
      if (!signedIn) return;
      try {
        if (!workspaceId) return;
        await setSystemPromptSettings({ workspace: workspaceId, ...settings });
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "Failed to update system prompt setting.",
        );
      }
    },
    [signedIn, setSystemPromptSettings, workspaceId],
  );

  const signInRequired = userInfo !== undefined && typeof userInfo === "string";
  const modelsLoading = userInfo === undefined || models === undefined;
  const chainOfThoughtLoading = userInfo === undefined || chainOfThoughtEnabled === undefined;
  const systemPromptLoading = userInfo === undefined || systemPrompt === undefined;

  return (
    <>
      <WorkspacePageHeader
        title="Chat defaults"
        description="How chats run: the models new chats start with, how the conversation is shown, and the system prompt."
      />

      <GroupList title="Model">
        <Row
          title="Default model"
          description="New chats start with it. Unset uses the first available model."
        >
          <ModelPicker
            models={chatModels}
            selectedSlug={defaultModel}
            label={selected ? modelDisplayName(selected) : "Auto (first available)"}
            isLoading={modelsLoading}
            signInRequired={signInRequired}
            disabled={!signedIn}
            open={open}
            onOpenChange={setOpen}
            onSelect={(slug) => void persist(slug)}
            onReset={() => void persist(undefined)}
          />
        </Row>
        <Row
          title="Title model"
          description="Names new chats from the first message. Unset follows the default model."
        >
          <ModelPicker
            models={models ?? []}
            selectedSlug={titleModel}
            label={
              selectedTitleModel
                ? modelDisplayName(selectedTitleModel)
                : "Auto (default chat model)"
            }
            isLoading={modelsLoading}
            signInRequired={signInRequired}
            disabled={!signedIn}
            open={titleOpen}
            onOpenChange={setTitleOpen}
            onSelect={(slug) => void persistTitleModel(slug)}
            onReset={() => void persistTitleModel(undefined)}
          />
        </Row>
      </GroupList>

      <GroupList title="Conversation">
        <Row
          title="Chain of Thought"
          description="Show reasoning, tool activity, and web search results as one timeline."
        >
          {chainOfThoughtLoading ? (
            <Skeleton className="h-5 w-8 shrink-0" />
          ) : (
            <Switch
              aria-label="Enable Chain of Thought"
              checked={chainOfThoughtEnabled}
              disabled={!signedIn}
              onCheckedChange={(checked) => void persistChainOfThought(checked)}
            />
          )}
        </Row>
      </GroupList>

      <GroupList title="System prompt">
        <Row
          title="System prompt"
          description="Tell the model it runs in Radium, how Radium is organized, and its rules."
        >
          {systemPromptLoading ? (
            <Skeleton className="h-5 w-8 shrink-0" />
          ) : (
            <Switch
              aria-label="Send the system prompt"
              checked={systemPrompt.enabled}
              disabled={!signedIn}
              onCheckedChange={(enabled) => void persistSystemPrompt({ ...systemPrompt, enabled })}
            />
          )}
        </Row>
        <Row
          title="Model identity"
          description="Include the model's name, author, and slug. Needs the system prompt."
        >
          {systemPromptLoading ? (
            <Skeleton className="h-5 w-8 shrink-0" />
          ) : (
            <Switch
              aria-label="Include the model identity"
              checked={systemPrompt.enabled && systemPrompt.modelIdentity}
              disabled={!signedIn || !systemPrompt.enabled}
              onCheckedChange={(modelIdentity) =>
                void persistSystemPrompt({ ...systemPrompt, modelIdentity })
              }
            />
          )}
        </Row>
      </GroupList>
    </>
  );
}

/**
 * Trigger plus searchable model list in a popover. Selecting a model closes the popover; `Reset`
 * appears while a model is saved and clears it back to the automatic choice.
 */
function ModelPicker({
  models,
  selectedSlug,
  label,
  isLoading,
  signInRequired,
  disabled,
  open,
  onOpenChange,
  onSelect,
  onReset,
}: {
  models: ModelOption[];
  selectedSlug: string | null | undefined;
  label: string;
  isLoading: boolean;
  signInRequired: boolean;
  disabled: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (slug: string) => void;
  onReset: () => void;
}) {
  if (signInRequired) {
    return <Tag>Sign in required</Tag>;
  }

  if (isLoading) {
    return <Skeleton className="h-8 w-40" />;
  }

  return (
    <div className="flex items-center gap-2">
      {selectedSlug ? (
        <Button variant="ghost" size="sm" onClick={onReset} disabled={disabled}>
          Reset
        </Button>
      ) : null}
      <Popover open={open} onOpenChange={onOpenChange}>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm" className="max-w-56" disabled={disabled}>
            <span className="truncate">{label}</span>
            <ChevronDownIcon data-icon="inline-end" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-80 p-0">
          <ModelList
            models={models}
            selectedSlug={selectedSlug ?? undefined}
            onSelect={(model) => {
              onSelect(model.slug);
              onOpenChange(false);
            }}
          />
        </PopoverContent>
      </Popover>
    </div>
  );
}
