"use client";
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
  type PromptInputMessage,
  PromptInputSelect,
  PromptInputSelectContent,
  PromptInputSelectItem,
  PromptInputSelectTrigger,
  PromptInputSelectValue,
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
import { LetterIcon } from "@/components/ui/Letters";
import { useQuery } from "convex/react";
import { GlobeIcon, CheckIcon, Loader2 } from "lucide-react";
import { useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { api } from "../../../convex/_generated/api";
import { Doc, Id } from "../../../convex/_generated/dataModel";

// ============================================
const findAuthorByID = (
  authors: Doc<"authors">[] | undefined,
  modelAuthorID?: Id<"authors">
) => authors?.filter((a) => a._id === (modelAuthorID ?? ''))[0];

export default function HomePage() {
  const userInfo = useQuery(api.auth.userInfo, {});
  if (userInfo === "Not logged in!" || !userInfo) return (
    <div className="flex h-full w-full flex-1 items-center justify-center">
      <Loader2 className="size-8 animate-spin text-muted-foreground" />
    </div>
  );
  const models = useQuery(api.models.availableModels);
  const authors = useQuery(api.authors.listAuthors)

  /**
   * @todo Dynamic day message
   */
  const welcomeMessage = `Hey, ${userInfo.name.split(" ")[0]}!`;

  /**
   * Model selector
   */
  const [modelSelectorOpen, setModelSelectorOpen] = useState(false);
  const [selectedModel, setSelectedModel] = useState<string>();
  const selectedModelData = models?.find(
    (model) => model._id === selectedModel
  );
  const chefs = Array.from(
    new Set(models?.map((model) => findAuthorByID(authors, model.author)?.name))
  );
  /**
   * Chat Input
   */
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [useWebSearch, setUseWebSearch] = useState<boolean>(false);
  const [text, setText] = useState<string>("");
  const { messages, status, sendMessage } = useChat({});
  const handleSubmit = (message: PromptInputMessage) => {
    const hasText = Boolean(message.text);
    const hasAttachments = Boolean(message.files?.length);
    if (!(hasText || hasAttachments)) {
      return;
    }
    sendMessage(
      {
        text: message.text || "Sent with attachments",
        files: message.files,
      },
      {
        body: {
          model: models?.find((m) => m._id === selectedModel)!.slug,
          webSearch: useWebSearch,
        },
      }
    );
    setText("");
  };

  return (
    <main className="mx-auto mt-4 w-full flex-1 px-4 md:px-8 lg:mt-6 max-w-7xl !mt-0 flex flex-col items-center gap-8 md:px-14 3xl:px-20 pt-[10vh] md:pt-[20vh] max-sm:!px-1 bg-bg-100">
      {/* Welcome Section */}
      <div className="mx-auto flex w-full flex-col items-center gap-7 max-md:pt-4 max-w-2xl relative">
        {/* Spacer to maintain spacing (replaces plan banner) */}
        <div className="h-8"></div>
        <div
          className="font-display text-text-200 w-full flex-col items-center text-center max-md:flex sm:-ml-0.5 sm:block transition-opacity duration-300 ease-in"
          style={{
            fontSize: "clamp(1.875rem, 1.2rem + 2vw, 2.5rem)",
            lineHeight: 1.5,
          }}
        >
          <LetterIcon letter="R" />
          <div
            className="font-normal font-serif inline-block max-w-full align-middle max-md:line-clamp-2 max-md:break-words md:overflow-hidden md:overflow-ellipsis select-none"
            style={{ opacity: 1 }}
          >
            {welcomeMessage}
          </div>
        </div>
      </div>

      {/* Chat Input and Categories grouped */}
      <div className="top-5 z-10 mx-auto w-full max-w-2xl">
        <PromptInput
          onSubmit={handleSubmit}
          className="mt-4"
          globalDrop
          multiple
        >
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
                              findAuthorByID(authors, model.author)?.name ===
                              chef
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
                                  findAuthorByID(authors, model.author)
                                    ?.slug || "openrouter"
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
              <PromptInputSubmit disabled={status && text === ''} status={status} />
            </div>
          </PromptInputFooter>
        </PromptInput>
        {/*<PromptCategories />*/}
      </div>
    </main>
  );
}
