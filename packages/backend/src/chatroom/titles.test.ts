import { expect, test } from "vitest";
import { firstUserMessageText } from "./titles";

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
