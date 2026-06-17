import { NoObjectGeneratedError, Output, generateText, type LanguageModel } from "ai";
import { v } from "convex/values";
import * as z from "zod";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery, type QueryCtx } from "./_generated/server";
import { createInternalGatewayProvider } from "./ai_gateway";

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
      system: TITLE_SYSTEM_PROMPT,
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

export function firstUserMessageText(
  chat: Pick<Doc<"aisdk_chats">, "messages" | "messages_queue">,
) {
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

export const generateForChat = internalAction({
  args: { chatId: v.id("aisdk_chats"), force: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const chat = await ctx.runQuery(internal.chat_titles.titleGenerationInfo, {
      chatId: args.chatId,
    });
    if (!chat || (!args.force && chat.title) || !chat.initialUserMessage.trim()) return null;

    const provider = createInternalGatewayProvider(ctx, chat.balance, () =>
      Response.json({ error: { message: "Internal gateway request failed", code: 500 } }, { status: 500 }),
    );

    try {
      const title = await generateChatTitle({
        model: provider(chat.model),
        initialUserMessage: chat.initialUserMessage,
      });
      await ctx.runMutation(internal.chat_titles.saveGeneratedTitle, {
        chatId: args.chatId,
        force: args.force,
        ...title,
      });
    } catch (error) {
      console.error("Failed to generate chat title:", error);
    }

    return null;
  },
});

export const titleGenerationInfo = internalQuery({
  args: { chatId: v.id("aisdk_chats") },
  handler: async (ctx, args) => {
    const chat = await ctx.db.get("aisdk_chats", args.chatId);
    if (!chat) return null;

    const initialUserMessage = firstUserMessageText(chat);
    if (!initialUserMessage) return null;

    const settings = await ctx.db
      .query("chatroom_settings")
      .withIndex("by_userId", (q) => q.eq("userId", chat.userId))
      .unique();

    const model = await firstAvailableModel(ctx, settings?.titleModel ?? settings?.defaultModel);
    if (!model) return null;

    return {
      balance: chat.balance,
      initialUserMessage,
      model,
      title: chat.title,
    };
  },
});

export const saveGeneratedTitle = internalMutation({
  args: {
    chatId: v.id("aisdk_chats"),
    emoji: v.string(),
    title: v.string(),
    force: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const chat = await ctx.db.get("aisdk_chats", args.chatId);
    if (!chat || (!args.force && chat.title)) return null;

    await ctx.db.patch("aisdk_chats", args.chatId, sanitizeTitle(args));
    return null;
  },
});

async function firstAvailableModel(ctx: QueryCtx, preferred?: string) {
  if (preferred) {
    const model = await ctx.db
      .query("models")
      .withIndex("by_slug", (q) => q.eq("slug", preferred))
      .unique();
    if (isTitleGenerationModel(model)) return preferred;
  }

  const models = await ctx.db.query("models").take(200);
  return models.find(isTitleGenerationModel)?.slug ?? null;
}

function sanitizeTitle(title: GeneratedChatTitle): GeneratedChatTitle {
  return {
    emoji: Array.from(title.emoji.trim())[0] ?? "💬",
    title: title.title.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 32) || "New chat",
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

function isTitleGenerationModel(model: Doc<"models"> | null) {
  return (
    model?.type === "chat" &&
    model.architecture.input_modalities.includes("text") &&
    model.architecture.output_modalities.includes("text")
  );
}
