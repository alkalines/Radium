import { describe, expect, test } from "bun:test";
import type { ToolUIPart, UIMessage } from "ai";
import { acpAnswerError, type AcpConfig, type AcpToolContent } from "backend/src/acp/contract";
import { getLatestTodos, getToolKind, getToolRunState } from "../tool-parts";
import { countDiffLines } from "../tool-diff";
import { acpModelConfig, applyAcpDraft } from "./config-controls";
import {
  choicesFor,
  formContent,
  formatError,
  initialValues,
  type FormRequest,
} from "./elicitation-values";
import { ACP_TOOL_KINDS, acpToolPart, type AcpToolItem } from "./parts";
import {
  acpCommand,
  acpDiffFile,
  acpPermissionContent,
  acpRawValue,
  acpToolSubject,
} from "./tool-content";

const tool: AcpToolItem = {
  kind: "tool",
  id: "tool:a",
  order: 1,
  toolCallId: "a",
  title: "Agent tool",
};

describe("ACP tool mapping", () => {
  test("every kind branches before built-in tool names", () => {
    for (const kind of ACP_TOOL_KINDS)
      expect(getToolKind(acpToolPart({ ...tool, toolKind: kind }, false))).toBe(kind);
    expect(getToolKind(acpToolPart({ ...tool, toolKind: "unknown" }, false))).toBe("other");
  });
  test("reported states are independent of browser stream liveness", () => {
    const expected = {
      pending: "queued",
      in_progress: "executing",
      completed: "succeeded",
      failed: "failed",
    } as const;
    for (const status of ["pending", "in_progress", "completed", "failed"] as const) {
      for (const live of [true, false])
        expect(getToolRunState(acpToolPart({ ...tool, status }, false), live)).toBe(
          expected[status],
        );
    }
    expect(getToolRunState(acpToolPart(tool, false), false)).toBe("queued");
  });
  test("cancellation only overrides open statuses", () => {
    for (const status of [undefined, "pending", "in_progress"] as const)
      expect(getToolRunState(acpToolPart({ ...tool, status }, true), true)).toBe("cancelled");
    expect(getToolRunState(acpToolPart({ ...tool, status: "completed" }, true), false)).toBe(
      "succeeded",
    );
    expect(getToolRunState(acpToolPart({ ...tool, status: "failed" }, true), false)).toBe("failed");
  });
  test("machine subjects use paths, command and URL input", () => {
    expect(
      acpToolSubject({
        ...tool,
        toolKind: "move",
        locations: [{ path: "a.ts" }, { path: "b.ts" }],
      }),
    ).toBe("a.ts → b.ts");
    expect(
      acpToolSubject({
        ...tool,
        toolKind: "edit",
        content: [{ type: "diff", path: "x.ts", newText: "" }],
      }),
    ).toBe("x.ts");
    expect(acpCommand({ ...tool, rawInput: '{"command":"pwd"}' })).toBe("pwd");
    expect(acpCommand(tool)).toBe(tool.title);
    expect(
      acpToolSubject({ ...tool, toolKind: "fetch", rawInput: '{"url":"https://example.test"}' }),
    ).toBe("https://example.test");
    expect(acpRawValue("not JSON")).toBe("not JSON");
  });
});

describe("ACP content", () => {
  test("permission content accepts normalized blocks and tolerates incomplete JSON", () => {
    const content: AcpToolContent[] = [
      { type: "text", text: "$ pwd" },
      { type: "diff", path: "x.ts", oldText: "a", newText: "b" },
    ];
    expect(acpPermissionContent(JSON.stringify(content))).toEqual(content);
    expect(
      acpPermissionContent('[{"type":"diff","path":"x"},{"type":"text","text":"ok"}]'),
    ).toEqual([{ type: "text", text: "ok" }]);
    expect(acpPermissionContent("partial")).toEqual([{ type: "text", text: "partial" }]);
    expect(acpPermissionContent(undefined)).toEqual([]);
  });
  test("per-file diffs preserve context and count changed lines", () => {
    const content = {
      type: "diff" as const,
      path: "x.ts",
      oldText: "same\nold\nend\n",
      newText: "same\nnew\nend\n",
    };
    const file = acpDiffFile(content);
    expect(file.lines.map((line) => line.kind)).toEqual(["context", "removed", "added", "context"]);
    expect(countDiffLines(file.lines)).toEqual({ added: 1, removed: 1 });
    expect(acpDiffFile(content)).toBe(file);
  });
  test("new, empty and blank-line files do not invent diff lines", () => {
    expect(
      countDiffLines(acpDiffFile({ type: "diff", path: "x", newText: "a\nb\n" }).lines),
    ).toEqual({ added: 2, removed: 0 });
    expect(acpDiffFile({ type: "diff", path: "x", newText: "" }).lines).toEqual([]);
    expect(countDiffLines(acpDiffFile({ type: "diff", path: "x", newText: "\n" }).lines)).toEqual({
      added: 1,
      removed: 0,
    });
    expect(
      countDiffLines(acpDiffFile({ type: "diff", path: "x", oldText: "a\n", newText: "" }).lines),
    ).toEqual({ added: 0, removed: 1 });
  });
});

test("draft config overlays valid values without mutating defaults", () => {
  const config: AcpConfig = {
    options: [
      {
        id: "model",
        name: "Model",
        type: "select",
        currentValue: "a",
        choices: [
          { value: "a", name: "A" },
          { value: "b", name: "B" },
        ],
      },
      { id: "flag", name: "Flag", type: "boolean", currentValue: false },
    ],
    modes: {
      currentModeId: "ask",
      available: [
        { id: "ask", name: "Ask" },
        { id: "code", name: "Code" },
      ],
    },
  };
  const next = applyAcpDraft(config, {
    config: [
      { configId: "model", value: "b" },
      { configId: "flag", value: true },
    ],
    modeId: "code",
  });
  expect(next?.options.map((option) => option.currentValue)).toEqual(["b", true]);
  expect(next?.modes?.currentModeId).toBe("code");
  expect(config.options.map((option) => option.currentValue)).toEqual(["a", false]);
  expect(
    applyAcpDraft(config, {
      config: [
        { configId: "model", value: "missing" },
        { configId: "flag", value: "wrong type" },
      ],
      modeId: "missing",
    }),
  ).toEqual(config);
  expect(applyAcpDraft(config, undefined)).toBe(config);
  expect(applyAcpDraft(undefined, { config: [] })).toBeUndefined();
});

describe("ACP shared model picker adapter", () => {
  test("models and reasoning retain agent values and labels without Gateway metadata", () => {
    const config: AcpConfig = {
      options: [
        {
          id: "agent-model",
          category: "model",
          name: "Model",
          type: "select",
          currentValue: "native/b",
          choices: [
            { value: "native/a", name: "Alpha", group: "Native" },
            { value: "native/b", name: "Beta" },
          ],
        },
        {
          id: "thinking",
          category: "thought_level",
          name: "Thinking",
          type: "select",
          currentValue: "deep",
          choices: [
            { value: "quick", name: "Quick response" },
            { value: "deep", name: "Think deeply", description: "More time to think" },
          ],
        },
        {
          id: "mode",
          category: "mode",
          name: "Mode",
          type: "select",
          currentValue: "ask",
          choices: [{ value: "ask", name: "Ask" }],
        },
        { id: "flag", name: "Flag", type: "boolean", currentValue: false },
      ],
    };
    const adapter = acpModelConfig(config);
    // The value's `provider/` prefix is where the agent routes the model; its group, else the
    // provider's display name, names it.
    expect(adapter.models).toEqual([
      {
        slug: "a",
        name: "Alpha",
        author: null,
        providers: [{ id: "native", name: "Native", logo: "native" }],
      },
      {
        slug: "b",
        name: "Beta",
        author: null,
        providers: [{ id: "native", name: "Native", logo: "native" }],
      },
    ]);
    expect(adapter.model?.currentValue).toBe("native/b");
    expect(adapter.selectedModel).toBe("b");
    expect(adapter.selectedProvider).toBe("native");
    expect(adapter.reasoning?.currentValue).toBe("deep");
    expect(adapter.reasoning?.choices).toEqual(
      config.options[1]!.type === "select" ? config.options[1]!.choices : [],
    );
    expect(adapter.mode?.id).toBe("mode");
    expect(adapter.extra.map((option) => option.id)).toEqual(["flag"]);
    expect(
      acpModelConfig(
        applyAcpDraft(config, {
          config: [{ configId: "thinking", value: "quick" }],
        }),
      ).reasoning?.currentValue,
    ).toBe("quick");
    expect(config.options[1]!.currentValue).toBe("deep");
  });

  test("one model routed through several providers is one row with a provider choice", () => {
    const adapter = acpModelConfig({
      options: [
        {
          id: "model",
          category: "model",
          name: "Model",
          type: "select",
          currentValue: "openrouter/anthropic/claude-sonnet-4.6",
          choices: [
            { value: "claude-agent/claude-sonnet-4-6", name: "claude-agent/Sonnet 4.6" },
            { value: "github-copilot/claude-sonnet-4.6", name: "github-copilot/Claude Sonnet 4.6" },
            {
              value: "openrouter/anthropic/claude-sonnet-4.6",
              name: "openrouter/Claude Sonnet 4.6",
            },
            { value: "claude-agent/claude-haiku-4-5-20251001", name: "claude-agent/Haiku 4.5" },
            { value: "openrouter/anthropic/claude-haiku-4.5", name: "openrouter/Claude Haiku 4.5" },
            { value: "openrouter/z-ai/glm-5", name: "openrouter/GLM-5" },
            { value: "openrouter/z-ai/glm.5", name: "openrouter/GLM.5" },
          ],
        },
      ],
    });
    // Alphabetical by `Lab: Model`; models.dev provider IDs get their names, unknown ones title-case.
    expect(
      adapter.models.map(({ slug, name, providers }) => [
        slug,
        name,
        providers?.map((p) => p.name),
      ]),
    ).toEqual([
      // On a tie the more descriptive name wins.
      ["claude-haiku-4-5", "Claude Haiku 4.5", ["Claude Agent", "OpenRouter"]],
      ["claude-sonnet-4-6", "Claude Sonnet 4.6", ["Claude Agent", "GitHub Copilot", "OpenRouter"]],
      ["glm-5", "GLM-5", ["OpenRouter"]],
      // Two choices of one provider never merge into one row.
      ["openrouter/z-ai/glm.5", "GLM.5", ["OpenRouter"]],
    ]);
    expect(adapter.selectedModel).toBe("claude-sonnet-4-6");
    expect(adapter.selectedProvider).toBe("openrouter");
    expect(adapter.valueFor("claude-sonnet-4-6", "github-copilot")).toBe(
      "github-copilot/claude-sonnet-4.6",
    );
    // A provider the model lacks falls back to its first provider.
    expect(adapter.valueFor("claude-haiku-4-5", "github-copilot")).toBe(
      "claude-agent/claude-haiku-4-5-20251001",
    );
  });

  test("an alias ID joins the versioned model with the same lab and name", () => {
    const select = (currentValue: string, choices: { value: string; name: string }[]) =>
      acpModelConfig({
        options: [
          { id: "model", category: "model", name: "Model", type: "select", currentValue, choices },
        ],
      });
    // OpenCode's Claude Agent names `claude-agent/haiku` "Haiku 5.5", without version or brand.
    const adapter = select("claude-agent/haiku", [
      { value: "claude-agent/haiku", name: "claude-agent/Haiku 5.5" },
      { value: "github-copilot/claude-haiku-5.5", name: "github-copilot/Claude Haiku 5.5" },
      { value: "openrouter/anthropic/claude-haiku-5.5", name: "openrouter/Claude Haiku 5.5" },
      { value: "claude-agent/claude-haiku-4-5", name: "claude-agent/Haiku 4.5" },
    ]);
    expect(adapter.models.map(({ slug, name }) => [slug, name])).toEqual([
      ["claude-haiku-5-5", "Claude Haiku 5.5"],
      ["claude-haiku-4-5", "Haiku 4.5"],
    ]);
    expect(adapter.selectedModel).toBe("claude-haiku-5-5");
    expect(adapter.selectedProvider).toBe("claude-agent");
    expect(adapter.valueFor("claude-haiku-5-5", "claude-agent")).toBe("claude-agent/haiku");
    // The same name through one provider stays two models: the agent offers both.
    expect(
      select("claude-agent/haiku", [
        { value: "claude-agent/haiku", name: "claude-agent/Haiku 5.5" },
        { value: "claude-agent/claude-haiku-5-5", name: "claude-agent/Haiku 5.5" },
      ]).models,
    ).toHaveLength(2);
  });

  test("missing and non-select primary options stay safe and visible in overflow", () => {
    expect(acpModelConfig(undefined).models).toEqual([]);
    expect(acpModelConfig(undefined).extra).toEqual([]);
    const boolean = {
      id: "thought-toggle",
      category: "thought_level",
      name: "Thinking",
      type: "boolean" as const,
      currentValue: true,
    };
    const adapter = acpModelConfig({ options: [boolean] });
    expect(adapter.reasoning).toBeUndefined();
    expect(adapter.extra).toEqual([boolean]);
  });
});

describe("ACP elicitation values", () => {
  const request: FormRequest = {
    kind: "elicitation",
    mode: "form",
    message: "Configure",
    required: ["enabled", "count"],
    fields: [
      { name: "enabled", type: "boolean", default: false },
      { name: "count", type: "integer", default: 2, minimum: 1, maximum: 5 },
      {
        name: "tags",
        type: "array",
        choices: [{ value: "a", title: "A" }],
        default: ["a"],
        maxItems: 1,
      },
      { name: "note", type: "string", minLength: 2, maxLength: 4 },
    ],
  };
  test("defaults preserve false, numbers and array choices", () => {
    const content = formContent(request, initialValues(request));
    expect(content).toEqual([
      { name: "enabled", value: false },
      { name: "count", value: 2 },
      { name: "tags", value: ["a"] },
    ]);
    expect(acpAnswerError(request, { kind: "elicitation", action: "accept", content })).toBeNull();
    expect(choicesFor(request.fields[0]!)).toEqual([
      { value: "true", title: "Yes" },
      { value: "false", title: "No" },
    ]);
  });
  test("skipped optional values are absent and required values still validate", () => {
    expect(formContent(request, { f0: "true", f1: "3", f2: undefined, f3: "" })).toEqual([
      { name: "enabled", value: true },
      { name: "count", value: 3 },
    ]);
    expect(
      acpAnswerError(request, {
        kind: "elicitation",
        action: "accept",
        content: formContent(request, {}),
      }),
    ).toBe("Missing answer for enabled.");
    expect(
      acpAnswerError(request, {
        kind: "elicitation",
        action: "accept",
        content: formContent(request, { ...initialValues(request), f1: "2.5" }),
      }),
    ).toContain("integer");
    expect(
      acpAnswerError(request, {
        kind: "elicitation",
        action: "accept",
        content: formContent(request, { ...initialValues(request), f1: "9" }),
      }),
    ).toContain("too large");
    expect(
      acpAnswerError(request, {
        kind: "elicitation",
        action: "accept",
        content: formContent(request, { ...initialValues(request), f3: "x" }),
      }),
    ).toContain("too short");
  });
  test("email, URI and date formats get trivial client validation", () => {
    const form: FormRequest = {
      ...request,
      required: [],
      fields: [
        { name: "email", type: "string", format: "email" },
        { name: "url", type: "string", format: "uri" },
        { name: "day", type: "string", format: "date" },
      ],
    };
    expect(formatError(form, [{ name: "email", value: "not an email" }])).toContain("email");
    expect(formatError(form, [{ name: "url", value: "/relative" }])).toContain("URL");
    expect(formatError(form, [{ name: "day", value: "2026-02-30" }])).toContain("date");
    expect(
      formatError(form, [
        { name: "email", value: "a@example.test" },
        { name: "url", value: "https://example.test/path" },
        { name: "day", value: "2026-11-01" },
      ]),
    ).toBeNull();
  });
});

test("built-in tool states, approvals and latest todos retain their existing path", () => {
  const bash: ToolUIPart = {
    type: "tool-worker_bash",
    toolCallId: "bash",
    state: "input-available",
    input: { command: "pwd" },
  };
  expect(getToolKind(bash)).toBe("bash");
  expect(getToolRunState(bash, true)).toBe("executing");
  expect(getToolRunState(bash, false)).toBe("cancelled");
  const approval: ToolUIPart = {
    ...bash,
    state: "approval-requested",
    approval: { id: "approval" },
  };
  expect(getToolRunState(approval, false)).toBe("awaiting");
  const messages: UIMessage[] = [
    {
      id: "a",
      role: "assistant",
      parts: [
        {
          type: "tool-todo_write",
          toolCallId: "todos",
          state: "output-available",
          input: { todos: [{ content: "Keep built-in todos", status: "in_progress" }] },
          output: undefined,
        },
        acpToolPart({ ...tool, toolKind: "other", status: "completed" }, false),
      ],
    },
  ];
  expect(getLatestTodos(messages)).toEqual([
    { content: "Keep built-in todos", status: "in_progress" },
  ]);
  const code: ToolUIPart = {
    type: "tool-execute",
    toolCallId: "code",
    state: "output-available",
    input: { code: "" },
    output: {
      output: "",
      calls: [
        {
          id: "inner",
          tool: "todo_write",
          input: { todos: [{ content: "Inner todos", status: "completed" }] },
          status: "completed",
        },
      ],
    },
  };
  expect(getToolKind(code)).toBe("code");
  expect(getLatestTodos([{ id: "b", role: "assistant", parts: [code] }])).toEqual([
    { content: "Inner todos", status: "completed" },
  ]);
});
