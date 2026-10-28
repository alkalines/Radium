import { expect, test } from "vitest";
import type {
  ChatCompletions_NotStreaming_ResponseBody_Type,
  ChatCompletions_Streaming_Chunk_Type,
} from "@/types/openai/types";
import {
  assembleOutputMessage,
  decomposeRequest,
  messageMeta,
  StreamOutputAssembler,
  toolMeta,
} from "./decompose";

type Delta = ChatCompletions_Streaming_Chunk_Type["choices"][number]["delta"];

function chunk(
  delta: Partial<Delta>,
  finishReason: "stop" | "tool_calls" | null = null,
): ChatCompletions_Streaming_Chunk_Type {
  return {
    id: "provider-id",
    created: 1,
    model: "m",
    object: "chat.completion.chunk",
    choices: [
      {
        index: 0,
        finish_reason: finishReason,
        delta: { content: "", role: "assistant", ...delta },
      },
    ],
  };
}

test("only leading system and developer messages leave the chain, and unknown fields survive", () => {
  const body = {
    model: "m",
    temperature: 0.1,
    vendor_extension: { nested: [1, 2] },
    messages: [
      { role: "system", content: "a" },
      { role: "developer", content: "b" },
      { role: "user", content: "c" },
      { role: "system", content: "late" },
    ],
    tools: [{ type: "function", function: { name: "lookup" } }],
  };

  const parts = decomposeRequest(body);

  expect(parts.system).toEqual(body.messages.slice(0, 2));
  expect(parts.chain).toEqual(body.messages.slice(2));
  expect(parts.tools).toEqual(body.tools);
  expect(parts.params).toEqual({
    model: "m",
    temperature: 0.1,
    vendor_extension: { nested: [1, 2] },
  });
});

test("malformed bodies decompose to empty parts instead of throwing", () => {
  expect(decomposeRequest(null)).toMatchObject({ system: [], chain: [], tools: [], params: {} });
  expect(decomposeRequest({ messages: "x", tools: 3 })).toMatchObject({ chain: [], tools: [] });
});

test("only allowlisted headers are kept, lowercased, never credentials", () => {
  const headers = new Headers({
    Authorization: "Bearer secret",
    Cookie: "session=secret",
    "X-Api-Key": "secret",
    "User-Agent": "agent/1",
    "X-Claude-Code-Session-Id": "s1",
    "X-Stainless-Lang": "js",
    "Anthropic-Beta": "tools",
  });

  expect(decomposeRequest({}, headers).headers).toEqual({
    "user-agent": "agent/1",
    "x-claude-code-session-id": "s1",
    "x-stainless-lang": "js",
    "anthropic-beta": "tools",
  });
});

test("redacted meta keeps roles, tool-call names, and tool-call IDs", () => {
  expect(
    messageMeta({
      role: "assistant",
      content: "secret",
      tool_calls: [{ id: "c1", type: "function", function: { name: "lookup", arguments: "{}" } }],
    }),
  ).toEqual({ role: "assistant", names: ["lookup"] });
  expect(messageMeta({ role: "tool", tool_call_id: "c1", content: "secret" })).toEqual({
    role: "tool",
    toolCallId: "c1",
  });
  expect(
    toolMeta({ type: "function", function: { name: "lookup", description: "secret" } }),
  ).toEqual({
    names: ["lookup"],
  });
});

test("streamed text, reasoning, and interleaved tool-call fragments assemble by index", () => {
  const assembler = new StreamOutputAssembler();
  assembler.push(chunk({ reasoning: "think" }));
  assembler.push(chunk({ reasoning: "ing", content: "Hel" }));
  assembler.push(chunk({ content: "lo" }));
  assembler.push(
    chunk({
      tool_calls: [
        { index: 1, id: "b", type: "function", function: { name: "second", arguments: '{"y"' } },
        { index: 0, id: "a", type: "function", function: { name: "first", arguments: "{" } },
      ],
    }),
  );
  assembler.push(
    chunk(
      {
        tool_calls: [
          { index: 0, type: "function", function: { arguments: '"x":1}' } },
          { index: 1, type: "function", function: { arguments: ":2}" } },
        ],
      },
      "tool_calls",
    ),
  );

  expect(assembler.providerId).toBe("provider-id");
  expect(assembler.finishReason).toBe("tool_calls");
  expect(assembler.message()).toEqual({
    role: "assistant",
    content: "Hello",
    reasoning: "thinking",
    tool_calls: [
      { id: "a", type: "function", function: { name: "first", arguments: '{"x":1}' } },
      { id: "b", type: "function", function: { name: "second", arguments: '{"y":2}' } },
    ],
  });
});

test("a stream with no output assembles no message", () => {
  const assembler = new StreamOutputAssembler();
  assembler.push(chunk({}, "stop"));
  expect(assembler.message()).toBeUndefined();
});

test("a non-streaming response assembles its assistant message", () => {
  const response = {
    id: "r",
    created: 1,
    model: "m",
    object: "chat.completion",
    usage: {},
    choices: [
      {
        index: 0,
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: null,
          reasoning: "why",
          tool_calls: [
            { id: "c", type: "function", function: { name: "lookup", arguments: "{}" } },
          ],
        },
      },
    ],
  } satisfies ChatCompletions_NotStreaming_ResponseBody_Type;

  expect(assembleOutputMessage(response)).toEqual({
    role: "assistant",
    content: null,
    reasoning: "why",
    tool_calls: [{ id: "c", type: "function", function: { name: "lookup", arguments: "{}" } }],
  });
});

test("opaque-only reasoning survives assembly and final metadata replaces earlier state", () => {
  const assembler = new StreamOutputAssembler();
  assembler.push(
    chunk({
      reasoning_details: [
        {
          type: "reasoning.encrypted",
          index: 0,
          id: "r",
          format: "openai-responses-v1",
          data: "partial",
        },
      ],
    }),
  );
  assembler.push(
    chunk({
      reasoning_details: [
        {
          type: "reasoning.encrypted",
          index: 0,
          id: "r",
          format: "openai-responses-v1",
          data: "complete",
        },
      ],
    }),
  );
  expect(assembler.message()).toEqual({
    role: "assistant",
    content: "",
    reasoning_details: [
      {
        type: "reasoning.encrypted",
        index: 0,
        id: "r",
        format: "openai-responses-v1",
        data: "complete",
      },
    ],
  });
});

test("custom input retains exact string semantics alongside interleaved function calls", () => {
  const assembler = new StreamOutputAssembler();
  assembler.push(
    chunk({
      tool_calls: [
        { index: 1, id: "custom", type: "custom", custom: { name: "edit", input: '{"x":' } },
        {
          index: 0,
          id: "function",
          type: "function",
          function: { name: "lookup", arguments: '{"q":' },
        },
      ],
    }),
  );
  assembler.push(
    chunk({
      tool_calls: [
        { index: 0, function: { arguments: '"query"}' } },
        { index: 1, custom: { input: "1}\\nraw code" } },
      ],
    }),
  );
  expect(assembler.message()?.tool_calls).toEqual([
    { id: "function", type: "function", function: { name: "lookup", arguments: '{"q":"query"}' } },
    { id: "custom", type: "custom", custom: { name: "edit", input: '{"x":1}\\nraw code' } },
  ]);
});
