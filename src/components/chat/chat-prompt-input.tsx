import type { ChatStatus, FileUIPart } from "ai";
import { BrainIcon, ChevronDownIcon, MicIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import {
  ModelSelector,
  ModelSelectorContent,
  ModelSelectorEmpty,
  ModelSelectorGroup,
  ModelSelectorInput,
  ModelSelectorItem,
  ModelSelectorList,
  ModelSelectorLogo,
  ModelSelectorLogoGroup,
  ModelSelectorName,
  ModelSelectorTrigger,
} from "@/components/ai-elements/model-selector";
import type { PromptInputMessage } from "@/components/ai-elements/prompt-input";
import {
  PromptInput,
  PromptInputActionAddAttachments,
  PromptInputActionMenu,
  PromptInputActionMenuContent,
  PromptInputActionMenuTrigger,
  PromptInputAttachments,
  PromptInputAttachment,
  PromptInputBody,
  PromptInputButton,
  PromptInputFooter,
  PromptInputProvider,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  usePromptInputController,
} from "@/components/ai-elements/prompt-input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ProviderLogo } from "@/components/gateway/provider-logo";

export type ReasoningEffort = string;

type ChatModelAuthor = {
  icon?: string;
  name: string;
  slug: string;
} | null;

type ChatModel = {
  author: ChatModelAuthor;
  features?: {
    reasoning_budget?: boolean;
    reasoning_efforts?: string[];
    reasoning_minimal?: boolean;
    reasoning_none?: boolean;
  };
  name: string;
  reasoning: boolean;
  slug: string;
  providers: Array<{ id: string; logo: string; name: string }>;
};

type ChatPromptInputProps = {
  disabled?: boolean;
  models: ChatModel[] | undefined;
  onModelChange: (model: string) => void;
  onProviderChange: (provider: string) => void;
  onReasoningBudgetChange: (budget: number | undefined) => void;
  onReasoningEffortChange: (effort: ReasoningEffort) => void;
  onStop?: () => void;
  onSubmit: (message: PromptInputMessage) => void | Promise<void>;
  placeholder: string;
  reasoningBudget: number | undefined;
  reasoningEffort: ReasoningEffort;
  selectedModel: string | undefined;
  selectedProvider: string | undefined;
  status: ChatStatus;
  /** Optional "Tools" submenu rendered inside the `+` action menu. */
  toolsMenu?: ReactNode;
};

export function ChatPromptInput({
  disabled,
  models,
  onModelChange,
  onProviderChange,
  onReasoningBudgetChange,
  onReasoningEffortChange,
  onStop,
  onSubmit,
  placeholder,
  reasoningBudget,
  reasoningEffort,
  selectedModel,
  selectedProvider,
  status,
  toolsMenu,
}: ChatPromptInputProps) {
  const [modelSelectorOpen, setModelSelectorOpen] = useState(false);
  const selectedModelData = models?.find((model) => model.slug === selectedModel);

  const handleModelSelect = useCallback(
    (model: ChatModel) => {
      onModelChange(model.slug);
      if (!model.providers.some((provider) => provider.id === selectedProvider)) {
        const firstProvider = model.providers[0]?.id;
        if (firstProvider) onProviderChange(firstProvider);
      }
      setModelSelectorOpen(false);
    },
    [onModelChange, onProviderChange, selectedProvider],
  );

  const isBusy = status === "submitted" || status === "streaming";
  const submitDisabled = disabled || !selectedModel || status === "submitted";
  const supportsReasoning = Boolean(selectedModelData?.reasoning);
  const supportsReasoningBudget = Boolean(selectedModelData?.features?.reasoning_budget);
  const reasoningEfforts = getReasoningEfforts(selectedModelData);
  const selectedReasoningLabel = supportsReasoning
    ? reasoningEffort === "none"
      ? "Off"
      : capitalize(reasoningEffort)
    : "Off";

  useEffect(() => {
    if (!supportsReasoning || reasoningEfforts.length === 0) {
      return;
    }

    if (!reasoningEfforts.includes(reasoningEffort)) {
      onReasoningEffortChange(reasoningEfforts[0]);
    }
  }, [onReasoningEffortChange, reasoningEffort, reasoningEfforts, supportsReasoning]);

  return (
    <PromptInputProvider>
      <PromptInput
        className="rounded-[1.125rem] bg-input/70 shadow-sm"
        globalDrop
        multiple
        onSubmit={onSubmit}
      >
        <PromptInputAttachments>
          {(attachment) => <PromptInputAttachment data={attachment} />}
        </PromptInputAttachments>
        <PromptInputBody>
          <PromptInputTextarea
            className="min-h-14 px-4 pt-4 text-sm placeholder:text-muted-foreground/80"
            disabled={submitDisabled}
            placeholder={placeholder}
          />
        </PromptInputBody>
        <PromptInputFooter className="px-3 pb-3 pt-0">
          <PromptInputTools>
            <PromptInputActionMenu>
              <PromptInputActionMenuTrigger />
              <PromptInputActionMenuContent>
                <PromptInputActionAddAttachments />
                {toolsMenu}
              </PromptInputActionMenuContent>
            </PromptInputActionMenu>
          </PromptInputTools>

          <PromptInputTools className="min-w-0 flex-1 justify-end">
            <ModelSelector onOpenChange={setModelSelectorOpen} open={modelSelectorOpen}>
              <ModelSelectorTrigger asChild>
                <PromptInputButton
                  className="max-w-[11rem] gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground sm:max-w-[15rem]"
                  disabled={!models?.length}
                  size="xs"
                >
                  {models === undefined ? (
                    <Skeleton className="h-3.5 w-28 sm:w-40" />
                  ) : (
                    <>
                      <ModelSelectorName className="min-w-0">
                        {selectedModelData?.name ?? "Select model"}
                      </ModelSelectorName>
                      {supportsReasoning ? (
                        <span className="shrink-0 text-muted-foreground/80">
                          {selectedReasoningLabel}
                        </span>
                      ) : null}
                      <ChevronDownIcon className="size-3 shrink-0 opacity-70" />
                    </>
                  )}
                </PromptInputButton>
              </ModelSelectorTrigger>
              <ModelSelectorContent className="w-[min(calc(100vw-2rem),34rem)] [&_[data-slot=dialog-close]]:right-2 [&_[data-slot=dialog-close]]:top-2">
                <div className="pr-12">
                  <ModelSelectorInput placeholder="Search models..." />
                </div>
                <ModelSelectorList>
                  <ModelSelectorEmpty>No models found.</ModelSelectorEmpty>
                  <ModelSelectorGroup heading="Models">
                    {models?.map((model) => (
                      <ModelItem
                        key={model.slug}
                        model={model}
                        onSelect={handleModelSelect}
                        selectedModel={selectedModel}
                      />
                    ))}
                  </ModelSelectorGroup>
                </ModelSelectorList>
                <div className="flex items-center justify-between gap-2 border-t p-2">
                  <ProviderDropdown
                    onProviderChange={onProviderChange}
                    providers={selectedModelData?.providers ?? []}
                    selectedProvider={selectedProvider}
                  />
                  <ReasoningDropdown
                    onReasoningBudgetChange={onReasoningBudgetChange}
                    onReasoningEffortChange={onReasoningEffortChange}
                    reasoningBudget={reasoningBudget}
                    reasoningEffort={reasoningEffort}
                    reasoningEfforts={reasoningEfforts}
                    selectedReasoningLabel={selectedReasoningLabel}
                    supportsReasoning={supportsReasoning}
                    supportsReasoningBudget={supportsReasoningBudget}
                  />
                </div>
              </ModelSelectorContent>
            </ModelSelector>

            <VoiceInputButton />

            <PromptInputSubmit
              className="bg-foreground text-background hover:bg-foreground/90"
              disabled={submitDisabled && !isBusy}
              onClick={status === "streaming" ? onStop : undefined}
              size="icon-xs"
              status={status}
            />
          </PromptInputTools>
        </PromptInputFooter>
      </PromptInput>
    </PromptInputProvider>
  );
}

type ModelItemProps = {
  model: ChatModel;
  onSelect: (model: ChatModel) => void;
  selectedModel: string | undefined;
};

type ProviderOption = ChatModel["providers"][number];

function ProviderDropdown({
  providers,
  selectedProvider,
  onProviderChange,
}: {
  providers: ProviderOption[];
  selectedProvider: string | undefined;
  onProviderChange: (provider: string) => void;
}) {
  const selected = providers.find((provider) => provider.id === selectedProvider) ?? providers[0];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          aria-label="Inference provider"
          className="flex h-8 min-w-0 items-center gap-1.5 rounded-xl border bg-background px-2 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
          disabled={providers.length === 0}
          type="button"
        >
          {selected ? <ProviderLogo className="size-4" slug={selected.logo} /> : null}
          <span className="max-w-36 truncate">{selected?.name ?? "No provider"}</span>
          <ChevronDownIcon className="size-3 opacity-70" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel>Inference provider</DropdownMenuLabel>
        <DropdownMenuRadioGroup onValueChange={onProviderChange} value={selected?.id}>
          {providers.map((provider) => (
            <DropdownMenuRadioItem key={provider.id} value={provider.id}>
              <ProviderLogo className="size-4" slug={provider.logo} />
              {provider.name}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

type ReasoningDropdownProps = {
  onReasoningBudgetChange: (budget: number | undefined) => void;
  onReasoningEffortChange: (effort: ReasoningEffort) => void;
  reasoningBudget: number | undefined;
  reasoningEffort: ReasoningEffort;
  reasoningEfforts: string[];
  selectedReasoningLabel: string;
  supportsReasoning: boolean;
  supportsReasoningBudget: boolean;
};

function ReasoningDropdown({
  onReasoningBudgetChange,
  onReasoningEffortChange,
  reasoningBudget,
  reasoningEffort,
  reasoningEfforts,
  selectedReasoningLabel,
  supportsReasoning,
  supportsReasoningBudget,
}: ReasoningDropdownProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          aria-label="Model options"
          className="flex h-8 shrink-0 items-center gap-1.5 rounded-xl border bg-background px-2 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
          type="button"
        >
          <BrainIcon className="size-3.5" />
          <span>{selectedReasoningLabel}</span>
          <ChevronDownIcon className="size-3 opacity-70" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>Reasoning amount</DropdownMenuLabel>
        {supportsReasoning ? (
          <DropdownMenuRadioGroup onValueChange={onReasoningEffortChange} value={reasoningEffort}>
            {reasoningEfforts.map((effort) => (
              <DropdownMenuRadioItem key={effort} value={effort}>
                {effort === "none" ? "Off" : capitalize(effort)}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        ) : (
          <DropdownMenuItem disabled>This model does not support reasoning.</DropdownMenuItem>
        )}

        {supportsReasoningBudget ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Budget</DropdownMenuLabel>
            <div className="px-1 pb-1">
              <Input
                aria-label="Reasoning budget"
                className="h-8 rounded-xl text-xs"
                min={1}
                onChange={(event) => {
                  const value = event.currentTarget.valueAsNumber;
                  onReasoningBudgetChange(Number.isFinite(value) ? value : undefined);
                }}
                placeholder="Token budget"
                type="number"
                value={reasoningBudget ?? ""}
              />
            </div>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ModelItem({ model, onSelect, selectedModel }: ModelItemProps) {
  const handleSelect = useCallback(() => onSelect(model), [model, onSelect]);
  const providerIds = model.providers.map((provider) => provider.id);
  const selected = selectedModel === model.slug;
  const modelDisplayName = getModelDisplayName(model);

  return (
    <ModelSelectorItem
      data-checked={selected}
      keywords={[
        modelDisplayName,
        model.name,
        model.author?.name ?? "",
        model.author?.slug ?? "",
        ...providerIds,
      ]}
      onSelect={handleSelect}
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
      <ModelSelectorName>{modelDisplayName}</ModelSelectorName>
      <ModelSelectorLogoGroup aria-label="Available providers" title="Available providers">
        {model.providers.map((provider) => (
          <ModelSelectorLogo key={provider.id} provider={provider.logo} title={provider.name} />
        ))}
      </ModelSelectorLogoGroup>
    </ModelSelectorItem>
  );
}

function getModelDisplayName(model: ChatModel) {
  return model.author ? `${model.author.name}: ${model.name}` : model.name;
}

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function getReasoningEfforts(model: ChatModel | undefined) {
  if (!model?.reasoning) {
    return [];
  }

  if (model.features?.reasoning_efforts?.length) {
    return model.features.reasoning_efforts;
  }

  return [
    ...(model.features?.reasoning_none === false ? [] : ["none"]),
    ...(model.features?.reasoning_minimal ? ["minimal"] : []),
    "low",
    "medium",
    "high",
  ];
}

type BrowserSpeechRecognition = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  onresult: ((event: { resultIndex: number; results: SpeechRecognitionResultList }) => void) | null;
  onstart: (() => void) | null;
  start: () => void;
  stop: () => void;
};

function VoiceInputButton() {
  const { textInput } = usePromptInputController();
  const textInputRef = useRef(textInput);
  const recognitionRef = useRef<BrowserSpeechRecognition | null>(null);
  const [isListening, setIsListening] = useState(false);
  const [isSupported, setIsSupported] = useState(false);

  textInputRef.current = textInput;

  useEffect(() => {
    const SpeechRecognitionConstructor =
      typeof window === "undefined"
        ? undefined
        : ((window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition);

    if (!SpeechRecognitionConstructor) {
      return;
    }

    const recognition = new SpeechRecognitionConstructor() as BrowserSpeechRecognition;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";
    recognition.onstart = () => setIsListening(true);
    recognition.onend = () => setIsListening(false);
    recognition.onerror = () => setIsListening(false);
    recognition.onresult = (event) => {
      let finalTranscript = "";

      for (let index = event.resultIndex; index < event.results.length; index++) {
        const result = event.results[index];
        if (result.isFinal) {
          finalTranscript += result[0]?.transcript ?? "";
        }
      }

      if (finalTranscript) {
        const currentTextInput = textInputRef.current;
        currentTextInput.setInput(
          currentTextInput.value + (currentTextInput.value ? " " : "") + finalTranscript,
        );
      }
    };

    recognitionRef.current = recognition;
    setIsSupported(true);

    return () => recognition.stop();
  }, []);

  const toggleListening = useCallback(() => {
    const recognition = recognitionRef.current;
    if (!recognition) {
      return;
    }

    if (isListening) {
      recognition.stop();
    } else {
      recognition.start();
    }
  }, [isListening]);

  return (
    <PromptInputButton
      aria-label="Voice input"
      className={isListening ? "bg-accent text-accent-foreground" : undefined}
      disabled={!isSupported}
      onClick={toggleListening}
      size="icon-xs"
    >
      <MicIcon className="size-3.5" />
    </PromptInputButton>
  );
}

export function filterFilesWithUrl<T extends { url?: string }>(file: T): file is T & FileUIPart {
  return Boolean(file.url);
}
