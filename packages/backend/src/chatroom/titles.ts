import { NoObjectGeneratedError, Output, generateText, type LanguageModel } from "ai";
import * as z from "zod";

const titleSchema = z.object({
  emoji: z.string().emoji().describe("Exactly one emoji that represents the user's first message."),
  title: z.string().min(1).max(32).describe("A concise chat title, no emoji, 2 to 5 words."),
});

type GeneratedChatTitle = z.infer<typeof titleSchema>;

const TITLE_SYSTEM_PROMPT = [
  "Generate a compact chat title from the user's initial message only.",
  "Return JSON only with keys emoji and title.",
  "The emoji value must contain exactly one emoji. The title value must contain one short title.",
  "The title must be 2 to 5 words, at most 32 characters, and fit in a narrow sidebar.",
  "Do not mention assistant responses, because none exist yet.",
].join(" ");

/** Reusable AI SDK title generator for chat-like first prompts. */
export async function generateChatTitle({
  model,
  initialUserMessage,
}: {
  model: LanguageModel;
  initialUserMessage: string;
}): Promise<GeneratedChatTitle> {
  try {
    const result = await generateText({
      model,
      instructions: TITLE_SYSTEM_PROMPT,
      prompt: initialUserMessage,
      output: Output.object({
        schema: titleSchema,
        name: "chat_title",
        description: "Short chat title with one emoji.",
      }),
      temperature: 0.2,
      maxOutputTokens: 80,
    });

    return sanitizeTitle(result.output ?? { emoji: "💬", title: "New chat" });
  } catch (error) {
    if (NoObjectGeneratedError.isInstance(error) && error.text) {
      return titleFromText(error.text);
    }
    throw error;
  }
}

/** Extract the initial prompt without including assistant or later user turns. */
export function firstUserMessageText(chat: {
  messages: ReadonlyArray<{ role: string; parts: readonly unknown[] }>;
  messages_queue?: { text: string } | null;
}) {
  const queuedText = chat.messages_queue?.text.trim();
  if (queuedText) return queuedText;

  const firstUserMessage = chat.messages.find((message) => message.role === "user");
  if (!firstUserMessage) return "";

  return firstUserMessage.parts.map(textFromMessagePart).filter(Boolean).join(" ").trim();
}

function textFromMessagePart(part: unknown) {
  if (!part || typeof part !== "object") return "";

  const record = part as Record<string, unknown>;
  if (typeof record.text === "string") return record.text.trim();
  if (typeof record.content === "string") return record.content.trim();
  if (typeof record.input === "string") return record.input.trim();
  if (typeof record.output === "string") return record.output.trim();

  return "";
}

export function sanitizeTitle(title: GeneratedChatTitle): GeneratedChatTitle {
  return {
    emoji: Array.from(title.emoji.trim())[0] ?? "💬",
    title:
      title.title
        .replace(/[\r\n]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 32) || "New chat",
  };
}

function titleFromText(text: string): GeneratedChatTitle {
  const trimmed = text.trim();

  try {
    const parsed = titleSchema.safeParse(JSON.parse(trimmed));
    if (parsed.success) return sanitizeTitle(parsed.data);
  } catch {}

  const [first = "", ...rest] = Array.from(trimmed);
  const title = rest.join("").replace(/^[\s:.-]+/, "");
  return sanitizeTitle({ emoji: first || "💬", title: title || trimmed || "New chat" });
}

export function isTitleGenerationModel(
  model: {
    type: string;
    architecture: { input_modalities: readonly string[]; output_modalities: readonly string[] };
  } | null,
) {
  return (
    model?.type === "chat" &&
    model.architecture.input_modalities.includes("text") &&
    model.architecture.output_modalities.includes("text")
  );
}
