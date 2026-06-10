import type { ChatStatus, FileUIPart } from "ai";
import { BrainIcon, CheckIcon, ChevronDownIcon, MicIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

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
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export type ReasoningEffort = "none" | "low" | "medium" | "high";

type ChatModel = {
  features?: {
    reasoning_minimal?: boolean;
    reasoning_none?: boolean;
  };
  name: string;
  reasoning: boolean;
  slug: string;
  providers: Array<{ id: string }>;
};

type ChatPromptInputProps = {
  disabled?: boolean;
  models: ChatModel[] | undefined;
  onModelChange: (model: string) => void;
  onReasoningEffortChange: (effort: ReasoningEffort) => void;
  onStop?: () => void;
  onSubmit: (message: PromptInputMessage) => void | Promise<void>;
  placeholder: string;
  reasoningEffort: ReasoningEffort;
  selectedModel: string | undefined;
  status: ChatStatus;
};

export function ChatPromptInput({
  disabled,
  models,
  onModelChange,
  onReasoningEffortChange,
  onStop,
  onSubmit,
  placeholder,
  reasoningEffort,
  selectedModel,
  status,
}: ChatPromptInputProps) {
  const [modelSelectorOpen, setModelSelectorOpen] = useState(false);
  const selectedModelData = models?.find((model) => model.slug === selectedModel);

  useEffect(() => {
    if (!selectedModel && models?.[0]) {
      onModelChange(models[0].slug);
    }
  }, [models, onModelChange, selectedModel]);

  const handleModelSelect = useCallback(
    (model: string) => {
      onModelChange(model);
      setModelSelectorOpen(false);
    },
    [onModelChange]
  );

  const isBusy = status === "submitted" || status === "streaming";
  const submitDisabled = disabled || !selectedModel || status === "submitted";
  const supportsReasoning = Boolean(selectedModelData?.reasoning);
  const selectedReasoningLabel = supportsReasoning
    ? reasoningEffort === "none"
      ? "Off"
      : capitalize(reasoningEffort)
    : "Off";

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
              </PromptInputActionMenuContent>
            </PromptInputActionMenu>
          </PromptInputTools>

          <PromptInputTools className="min-w-0 flex-1 justify-end">
            <ModelSelector
              onOpenChange={setModelSelectorOpen}
              open={modelSelectorOpen}
            >
              <ModelSelectorTrigger asChild>
                <PromptInputButton
                  className="max-w-[11rem] gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground sm:max-w-[15rem]"
                  disabled={!models?.length}
                  size="xs"
                >
                  <ModelSelectorName className="flex-none truncate">
                    {selectedModelData?.name ?? "Select model"}
                  </ModelSelectorName>
                  {supportsReasoning ? (
                    <span className="shrink-0 text-muted-foreground/80">
                      {selectedReasoningLabel}
                    </span>
                  ) : null}
                  <ChevronDownIcon className="size-3 shrink-0 opacity-70" />
                </PromptInputButton>
              </ModelSelectorTrigger>
              <ModelSelectorContent className="w-[min(calc(100vw-2rem),34rem)]">
                <ModelSelectorInput placeholder="Search models..." />
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
              </ModelSelectorContent>
            </ModelSelector>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <PromptInputButton
                  aria-label="Reasoning effort"
                  className="gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground"
                  disabled={!supportsReasoning}
                  size="xs"
                >
                  <BrainIcon className="size-3.5" />
                  <span className="hidden sm:inline">{selectedReasoningLabel}</span>
                </PromptInputButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {(["none", "low", "medium", "high"] as const).map((effort) => (
                  <DropdownMenuItem
                    key={effort}
                    onSelect={() => onReasoningEffortChange(effort)}
                  >
                    <span className="flex-1">{capitalize(effort)}</span>
                    {reasoningEffort === effort ? (
                      <CheckIcon className="size-4" />
                    ) : null}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>

            <VoiceInputButton />

            <PromptInputSubmit
              className="bg-primary text-primary-foreground hover:bg-primary/90"
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
  onSelect: (model: string) => void;
  selectedModel: string | undefined;
};

function ModelItem({ model, onSelect, selectedModel }: ModelItemProps) {
  const handleSelect = useCallback(() => onSelect(model.slug), [model.slug, onSelect]);
  const providerIds = model.providers.map((provider) => provider.id);

  return (
    <ModelSelectorItem onSelect={handleSelect} value={model.slug}>
      {providerIds[0] ? <ModelSelectorLogo provider={providerIds[0]} /> : null}
      <ModelSelectorName>{model.name}</ModelSelectorName>
      <ModelSelectorLogoGroup>
        {providerIds.map((provider) => (
          <ModelSelectorLogo key={provider} provider={provider} />
        ))}
      </ModelSelectorLogoGroup>
      {selectedModel === model.slug ? (
        <CheckIcon className="ml-auto size-4" />
      ) : (
        <div className="ml-auto size-4" />
      )}
    </ModelSelectorItem>
  );
}

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
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
        : ((window as any).SpeechRecognition ??
          (window as any).webkitSpeechRecognition);

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
          currentTextInput.value +
            (currentTextInput.value ? " " : "") +
            finalTranscript
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

export function filterFilesWithUrl<T extends { url?: string }>(
  file: T
): file is T & FileUIPart {
  return Boolean(file.url);
}
