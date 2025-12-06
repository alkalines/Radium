import {
  PromptInput,
  PromptInputActionAddAttachments,
  PromptInputActionMenu,
  PromptInputActionMenuContent,
  PromptInputActionMenuTrigger,
  PromptInputAttachment,
  PromptInputAttachments,
  PromptInputBody,
  PromptInputButton,
  PromptInputFooter,
  PromptInputHeader,
  PromptInputMessage,
  PromptInputSpeechButton,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from "@/components/ai-elements/prompt-input";
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
import { Button } from "@/components/ui/button";
import { GlobeIcon, CheckIcon } from "lucide-react";
import { Doc, Id } from "../../../../convex/_generated/dataModel";
import { Dispatch, SetStateAction, useRef, useState } from "react";
import { ChatStatus } from "ai";

const findAuthorByID = (
  authors: Doc<"authors">[] | undefined,
  modelAuthorID?: Id<"authors">
) => authors?.filter((a) => a._id === (modelAuthorID ?? ""))[0];

type useStateType<T> = [T, Dispatch<SetStateAction<T>>];

export default function ChatroomPromptInput({
  models,
  authors,
  handleSubmit,
  StateSelectedModel,
  StateUseWebSearch,
  StateText,
  chatStatus,
}: {
  models?: Doc<"models">[] | undefined;
  authors?: Doc<"authors">[] | undefined;
  handleSubmit: (message: PromptInputMessage) => void;
  StateSelectedModel: useStateType<string | undefined>;
  StateUseWebSearch: useStateType<boolean>;
  StateText: useStateType<string>;
  chatStatus: ChatStatus;
}) {
  /**
   * Model selector
   */
  const [selectedModel, setSelectedModel] = StateSelectedModel;
  const [modelSelectorOpen, setModelSelectorOpen] = useState(false);
  const selectedModelData = models?.find(
    (model) => model._id === selectedModel
  );
  const chefs = Array.from(
    new Set(models?.map((model) => findAuthorByID(authors, model.author)?.name))
  );

  /**
   * Prompt Input (root)
   */
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [useWebSearch, setUseWebSearch] = StateUseWebSearch;
  const [text, setText] = StateText;

  return (
    <PromptInput onSubmit={handleSubmit} className="mt-4" globalDrop multiple>
      <PromptInputHeader>
        <PromptInputAttachments>
          {(attachment) => <PromptInputAttachment data={attachment} />}
        </PromptInputAttachments>
      </PromptInputHeader>
      <PromptInputBody>
        <PromptInputTextarea
          onChange={(e) => setText(e.target.value)}
          ref={textareaRef}
          value={text}
        />
      </PromptInputBody>
      <PromptInputFooter>
        <PromptInputTools>
          <PromptInputActionMenu>
            <PromptInputActionMenuTrigger />
            <PromptInputActionMenuContent>
              <PromptInputActionAddAttachments />
            </PromptInputActionMenuContent>
          </PromptInputActionMenu>
          <PromptInputSpeechButton
            onTranscriptionChange={setText}
            textareaRef={textareaRef}
          />
          <PromptInputButton
            onClick={() => setUseWebSearch(!useWebSearch)}
            variant={useWebSearch ? "default" : "ghost"}
          >
            <GlobeIcon size={16} />
            <span>Search</span>
          </PromptInputButton>
        </PromptInputTools>
        <div className="flex items-center gap-1">
          <ModelSelector
            onOpenChange={setModelSelectorOpen}
            open={modelSelectorOpen}
          >
            <ModelSelectorTrigger asChild>
              <Button
                className="h-8 justify-between border-none bg-transparent shadow-none hover:bg-accent"
                variant="ghost"
              >
                {selectedModel ? (
                  <>
                    {findAuthorByID(authors, selectedModelData?.author) && (
                      <ModelSelectorLogo
                        className="size-5"
                        provider={
                          findAuthorByID(authors, selectedModelData?.author)
                            ?.slug || "openrouter"
                        }
                      />
                    )}
                    {findAuthorByID(authors, selectedModelData?.author) &&
                      selectedModelData?.name && (
                        <ModelSelectorName>
                          {
                            findAuthorByID(authors, selectedModelData?.author)
                              ?.name
                          }
                          : {selectedModelData?.name}
                        </ModelSelectorName>
                      )}
                  </>
                ) : (
                  <ModelSelectorName>Choose a Model</ModelSelectorName>
                )}
              </Button>
            </ModelSelectorTrigger>
            <ModelSelectorContent>
              <ModelSelectorInput placeholder="Search models..." />
              <ModelSelectorList>
                <ModelSelectorEmpty>No models found.</ModelSelectorEmpty>
                {chefs.map((chef) => (
                  <ModelSelectorGroup heading={chef} key={chef}>
                    {models
                      ?.filter(
                        (model) =>
                          findAuthorByID(authors, model.author)?.name === chef
                      )
                      .map((model) => (
                        <ModelSelectorItem
                          key={model._id}
                          onSelect={() => {
                            setSelectedModel(model._id);
                            setModelSelectorOpen(false);
                          }}
                          value={model._id}
                        >
                          <ModelSelectorLogo
                            provider={
                              findAuthorByID(authors, model.author)?.slug ||
                              "openrouter"
                            }
                          />
                          <ModelSelectorName>
                            {findAuthorByID(authors, model.author)?.name}:{" "}
                            {model.name}
                          </ModelSelectorName>
                          <ModelSelectorLogoGroup>
                            {model.providers.map((provider) => (
                              <ModelSelectorLogo
                                key={provider.id}
                                provider={provider.id}
                              />
                            ))}
                          </ModelSelectorLogoGroup>
                          {selectedModel === model._id ? (
                            <CheckIcon className="ml-auto size-4" />
                          ) : (
                            <div className="ml-auto size-4" />
                          )}
                        </ModelSelectorItem>
                      ))}
                  </ModelSelectorGroup>
                ))}
              </ModelSelectorList>
            </ModelSelectorContent>
          </ModelSelector>
          <PromptInputSubmit
            disabled={!(selectedModelData && chatStatus && text !== "")}
            status={chatStatus}
          />
        </div>
      </PromptInputFooter>
    </PromptInput>
  );
}
