import { expect, test } from "vitest";
import { firstUserMessageText, isTitleGenerationModel, sanitizeTitle } from "./titles";

test("title prompts prefer a nonempty queue and otherwise use only the first user message", () => {
  const messages = [
    { role: "assistant", parts: [{ text: "Ignore assistant text" }] },
    {
      role: "user",
      parts: [{ text: "  First prompt " }, { content: " with context " }, { type: "file" }],
    },
    { role: "user", parts: [{ text: "Ignore later prompts" }] },
  ];
  expect(firstUserMessageText({ messages, messages_queue: { text: "  Queued prompt  " } })).toBe(
    "Queued prompt",
  );
  expect(firstUserMessageText({ messages, messages_queue: { text: "   " } })).toBe(
    "First prompt with context",
  );
  expect(firstUserMessageText({ messages, messages_queue: null })).toBe(
    "First prompt with context",
  );
  expect(firstUserMessageText({ messages: [messages[0]!] })).toBe("");
});

test("titles are normalized and only text-to-text chat models generate them", () => {
  expect(sanitizeTitle({ emoji: " 🚀🔥", title: "  A\n\nvery   long title that exceeds the limit " })).toEqual({
    emoji: "🚀",
    title: "A very long title that exceeds t",
  });
  expect(sanitizeTitle({ emoji: "", title: " " })).toEqual({ emoji: "💬", title: "New chat" });
  const text = { input_modalities: ["text"], output_modalities: ["text"] };
  expect(isTitleGenerationModel({ type: "chat", architecture: text })).toBe(true);
  expect(isTitleGenerationModel({ type: "embedding", architecture: text })).toBe(false);
  expect(
    isTitleGenerationModel({
      type: "chat",
      architecture: { input_modalities: ["text"], output_modalities: ["image"] },
    }),
  ).toBe(false);
  expect(isTitleGenerationModel(null)).toBe(false);
});
