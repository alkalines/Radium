import { describe, expect, test } from "bun:test";

import type { Id } from "../../convex/_generated/dataModel";
import type { AttributedCompletion } from "../../convex/chat_observability";
import { isGatewayCompletionWithoutChat, isOwnerManagedGatewayTrace } from "./policy";

const apiKey = "api_key_1" as Id<"api_keys">;
const legacyKey = "legacy_key_1" as Id<"keys">;

describe("observability attribution policy", () => {
  test("keeps keyed, no-chat Gateway completions visible", () => {
    const bill = {} as AttributedCompletion["bill"];

    expect(isGatewayCompletionWithoutChat({ bill: { ...bill, apiKey } })).toBe(true);
    expect(isGatewayCompletionWithoutChat({ bill: { ...bill, key: legacyKey } })).toBe(true);
  });

  test("hides unknown or Chatroom-attributed completions", () => {
    const bill = {} as AttributedCompletion["bill"];
    const chatId = "chat_1" as Id<"aisdk_chats">;

    expect(isGatewayCompletionWithoutChat({ bill })).toBe(false);
    expect(isGatewayCompletionWithoutChat({ bill: { ...bill, apiKey }, chatId })).toBe(false);
    expect(isGatewayCompletionWithoutChat({ bill: { ...bill, apiKey }, userId: "alice" })).toBe(
      false,
    );
  });

  test("only owner-attributed no-chat Gateway traces use management visibility", () => {
    expect(
      isOwnerManagedGatewayTrace(
        { chatId: undefined, source: "gateway", userId: "alice" },
        "alice",
      ),
    ).toBe(true);
    expect(
      isOwnerManagedGatewayTrace({ chatId: undefined, source: "gateway", userId: "bob" }, "alice"),
    ).toBe(false);
    expect(
      isOwnerManagedGatewayTrace(
        { chatId: undefined, source: "chatroom", userId: "alice" },
        "alice",
      ),
    ).toBe(false);
    expect(
      isOwnerManagedGatewayTrace(
        { chatId: "chat_1" as Id<"aisdk_chats">, source: "gateway", userId: "alice" },
        "alice",
      ),
    ).toBe(false);
  });
});
