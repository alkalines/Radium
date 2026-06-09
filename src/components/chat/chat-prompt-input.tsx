import type { ChatStatus, FileUIPart } from "ai";
import { CheckIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

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
} from "@/components/ai-elements/prompt-input";

type ChatModel = {
  name: string;
  slug: string;
  providers: Array<{ id: string }>;
};

type ChatPromptInputProps = {
  disabled?: boolean;
  models: ChatModel[] | undefined;
  onModelChange: (model: string) => void;
  onStop?: () => void;
  onSubmit: (message: PromptInputMessage) => void | Promise<void>;
  placeholder: string;
  selectedModel: string | undefined;
  status: ChatStatus;
};

export function ChatPromptInput({
  disabled,
  models,
  onModelChange,
  onStop,
  onSubmit,
  placeholder,
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

  return (
    <PromptInputProvider>
      <PromptInput globalDrop multiple onSubmit={onSubmit}>
        <PromptInputAttachments>
          {(attachment) => <PromptInputAttachment data={attachment} />}
        </PromptInputAttachments>
        <PromptInputBody>
          <PromptInputTextarea disabled={submitDisabled} placeholder={placeholder} />
        </PromptInputBody>
        <PromptInputFooter>
          <PromptInputTools>
            <PromptInputActionMenu>
              <PromptInputActionMenuTrigger />
              <PromptInputActionMenuContent>
                <PromptInputActionAddAttachments />
              </PromptInputActionMenuContent>
            </PromptInputActionMenu>

            <ModelSelector
              onOpenChange={setModelSelectorOpen}
              open={modelSelectorOpen}
            >
              <ModelSelectorTrigger asChild>
                <PromptInputButton disabled={!models?.length}>
                  {selectedModelData?.providers[0]?.id ? (
                    <ModelSelectorLogo
                      provider={selectedModelData.providers[0].id}
                    />
                  ) : null}
                  <ModelSelectorName>
                    {selectedModelData?.name ?? "Select model"}
                  </ModelSelectorName>
                </PromptInputButton>
              </ModelSelectorTrigger>
              <ModelSelectorContent>
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
          </PromptInputTools>

          <PromptInputSubmit
            disabled={submitDisabled && !isBusy}
            onClick={status === "streaming" ? onStop : undefined}
            status={status}
          />
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

export function filterFilesWithUrl<T extends { url?: string }>(
  file: T
): file is T & FileUIPart {
  return Boolean(file.url);
}
