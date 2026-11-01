import {
  CodeMode,
  Namespace,
  Tool,
  ToolError,
  searchSignature,
  toolError,
} from "@opencode/codemode";
import { asSchema, tool, type ModelMessage, type ToolSet } from "ai";
import { Effect } from "effect";
import { z } from "zod";
import {
  CODE_MODE_INTERACTION_TIMEOUT_MS,
  type CodeModeCall,
  type CodeModeInteractionKind,
  type CodeModeInteractionResponse,
  type CodeModeOutput,
} from "./code-mode";

/**
 * Code Mode runtime for one chat request: the `execute` tool and its catalog instructions over the
 * chat's tools. Programs run in `@opencode/codemode`, an interpreter for a JavaScript subset with no
 * timers, `process`, filesystem, network, imports, or modules; the only way out is `tools.*`. Inner
 * calls run the same AI SDK tools the model can call directly, with the same approvals: a call that
 * needs the user opens a `codemode_interactions` prompt and waits for the answer in-stream.
 * See docs/research/OpenCode_Code_Mode.md for the design this follows.
 */

/** One tool a program can call. */
export type CodeModeTool = {
  tool: ToolSet[string];
  /**
   * `approval`: every call waits for the user's approval before it runs (Worker tools that need
   * approval). `question`: the user answers the call instead of `execute` (the `question` tool).
   */
  interaction?: CodeModeInteractionKind;
  /** MCP tools return a `CallToolResult`; programs get its structured content or text instead. */
  mcp?: boolean;
};

/**
 * The tools of one request. Top-level names must not collide with namespace names; callers keep
 * them unique like direct tool names.
 */
export type CodeModeInventory = {
  /** The chat's direct tools, callable by the same name (`tools.worker_bash`). */
  tools: Record<string, CodeModeTool>;
  /** Code Mode namespaces, one per MCP server, keyed by namespace name (`tools.github.search`). */
  namespaces: Record<string, { description?: string; tools: Record<string, CodeModeTool> }>;
};

/** Persistence for in-stream prompts (`convex/code_mode.ts`), injected by the chat action. */
export type CodeModeInteractions = {
  open: (kind: CodeModeInteractionKind) => Promise<string>;
  /** The answer, or `null` while unanswered. */
  response: (id: string) => Promise<CodeModeInteractionResponse | null>;
  close: (id: string) => Promise<void>;
};

/**
 * Explicit bounds, since the interpreter has none by default. The timeout includes time spent
 * waiting for the user, so it stays well inside the chat action's own lifetime.
 */
const LIMITS = { timeoutMs: 10 * 60_000, maxToolCalls: 100, maxOutputBytes: 64 * 1024 };
/** Unanswered prompts are refused; the UI counts down to the same deadline. */
const INTERACTION_TIMEOUT_SECONDS = CODE_MODE_INTERACTION_TIMEOUT_MS / 1000;
const INTERACTION_POLL_MS = 1_000;
/** Progress snapshots replace each other; send at most one per interval. */
const PROGRESS_INTERVAL_MS = 100;
/** Inline catalog budget for namespaced tools, in estimated tokens (4 characters each). */
const CATALOG_BUDGET_TOKENS = 2_000;
const CATALOG_DESCRIPTION_LIMIT = 120;

/** Model-facing text for a dismissed `question`, matching the direct tool's. */
const QUESTION_DISMISSED_MESSAGE = "The user dismissed these questions without answering.";

// Invariant, so the tool definition stays cache-stable; the changing catalog goes in the system
// prompt (or is appended here only when the workspace turned the system prompt off).
const EXECUTE_DESCRIPTION = [
  "Run JavaScript in a confined Code Mode runtime to script tool calls and compose their results.",
  "Imports, modules, timers (there is no `setTimeout` or sleep), `process`, the filesystem, and the network are unavailable. All external access goes through `tools`.",
  "Within `{ code }`, the only callable tools are those listed in the Code Mode catalog instructions or returned by the `search` function.",
  'Call tools through `tools` using only exact paths and signatures from the catalog. Do not infer or normalize tool names; preserve bracket notation such as `tools.<namespace>["tool-name"](input)`.',
  "Prefer an explicit `return`; if omitted, the final top-level expression becomes the result.",
  "Await every call whose completion matters; pending calls are interrupted when execution ends. Run independent calls concurrently with `Promise.allSettled`.",
  "Calls that need the user's approval or answer wait for it; a denial rejects that call's promise.",
].join("\n");

const executeInputSchema = z.object({
  code: z.string().min(1).describe("The JavaScript program to run."),
});

type Runner = (
  path: string,
  entry: CodeModeTool,
  input: unknown,
  signal: AbortSignal,
) => Promise<unknown>;

type ResolvedTool = {
  path: string;
  entry: CodeModeTool;
  input: Tool.JsonSchema;
  output: Tool.JsonSchema | undefined;
};

/** A rejected inner call the user denied or did not answer, as opposed to a failure. */
class DeniedCall extends Error {}

/**
 * Build Code Mode for one request. Returns `undefined` when there is nothing to call. Otherwise
 * `tool` is the `execute` tool and `instructions` the `# Code Mode` system prompt section; with
 * `catalogInDescription` (no system prompt is sent) the section is appended to the tool
 * description instead and `instructions` is `undefined`.
 */
export async function createCodeMode(options: {
  inventory: CodeModeInventory;
  interactions: CodeModeInteractions;
  catalogInDescription: boolean;
}): Promise<{ tool: ToolSet[string]; instructions?: string } | undefined> {
  const resolved = await resolveTools(options.inventory);
  if (resolved.length === 0) return undefined;

  const catalogRuntime = CodeMode.make({
    tools: programTools(options.inventory, resolved, () => Promise.resolve(null)),
  });
  const instructions = renderInstructions(options.inventory, catalogRuntime.catalog);

  const executeTool = tool({
    description: options.catalogInDescription
      ? `${EXECUTE_DESCRIPTION}\n\n${instructions}`
      : EXECUTE_DESCRIPTION,
    inputSchema: executeInputSchema,
    execute: ({ code }, { toolCallId, abortSignal, messages }) =>
      runProgram({
        code,
        toolCallId,
        abortSignal,
        messages,
        inventory: options.inventory,
        resolved,
        interactions: options.interactions,
      }),
    toModelOutput: ({ output }) => ({ type: "text", value: output.output }),
  });

  return {
    tool: executeTool as ToolSet[string],
    ...(options.catalogInDescription ? {} : { instructions }),
  };
}

/** Flatten the inventory with JSON Schemas resolved once; they only shape signatures. */
async function resolveTools(inventory: CodeModeInventory): Promise<ResolvedTool[]> {
  const entries: Array<[string, CodeModeTool]> = [
    ...Object.entries(inventory.tools),
    ...Object.entries(inventory.namespaces).flatMap(([namespace, { tools }]) =>
      Object.entries(tools).map(([name, entry]): [string, CodeModeTool] => [
        `${namespace}.${name}`,
        entry,
      ]),
    ),
  ];
  return Promise.all(
    entries.map(async ([path, entry]) => ({
      path,
      entry,
      // AI SDK JSON Schema 7 and CodeMode's render-only subset describe the same documents.
      input: (await asSchema(entry.tool.inputSchema).jsonSchema) as Tool.JsonSchema,
      output: entry.tool.outputSchema
        ? ((await asSchema(entry.tool.outputSchema).jsonSchema) as Tool.JsonSchema)
        : undefined,
    })),
  );
}

/** The program's `tools` object, with every call routed through `run`. */
function programTools(
  inventory: CodeModeInventory,
  resolved: ResolvedTool[],
  run: Runner,
): Record<string, Tool.Tool | Namespace.Namespace> {
  const byPath = new Map(resolved.map((item) => [item.path, item]));
  const make = (path: string) => {
    const item = byPath.get(path)!;
    const { description } = item.entry.tool;
    return Tool.make({
      // Chat tools take no tool context, so a context-dependent description gets none.
      description:
        typeof description === "function"
          ? description({ context: undefined })
          : (description ?? ""),
      input: item.input,
      // An empty schema renders `Promise<unknown>`; omitting it would claim `Promise<void>`.
      output: item.output ?? {},
      execute: (input) =>
        Effect.tryPromise({
          try: (signal) => run(path, item.entry, input, signal),
          catch: (error) => (error instanceof ToolError ? error : toolError(errorMessage(error))),
        }),
    });
  };

  const tools: Record<string, Tool.Tool | Namespace.Namespace> = {};
  for (const name of Object.keys(inventory.tools)) tools[name] = make(name);
  for (const [namespace, { description, tools: namespaceTools }] of Object.entries(
    inventory.namespaces,
  )) {
    tools[namespace] = Namespace.make({
      description,
      tools: Object.fromEntries(
        Object.keys(namespaceTools).map((name) => [name, make(`${namespace}.${name}`)]),
      ),
    });
  }
  return tools;
}

/**
 * Run one program, yielding a progress snapshot whenever its calls change (at most one per
 * {@link PROGRESS_INTERVAL_MS}) and the final output last. The AI SDK streams every yield but the
 * last as a preliminary result.
 */
async function* runProgram(options: {
  code: string;
  toolCallId: string;
  abortSignal: AbortSignal | undefined;
  messages: ModelMessage[];
  inventory: CodeModeInventory;
  resolved: ResolvedTool[];
  interactions: CodeModeInteractions;
}): AsyncGenerator<CodeModeOutput> {
  const { toolCallId, abortSignal, interactions } = options;
  const calls: CodeModeCall[] = [];
  // `changed` settles on the next publish; `dirty` covers publishes while a snapshot is yielded.
  let dirty = false;
  let changed = Promise.withResolvers<void>();
  const publish = () => {
    dirty = true;
    const current = changed;
    changed = Promise.withResolvers<void>();
    current.resolve();
  };

  async function ask(
    call: CodeModeCall,
    kind: CodeModeInteractionKind,
    signal: AbortSignal,
  ): Promise<CodeModeInteractionResponse | undefined> {
    const id = await interactions.open(kind);
    call.status = "awaiting";
    const deadline = Date.now() + CODE_MODE_INTERACTION_TIMEOUT_MS;
    call.interaction = { id, kind, expiresAt: deadline };
    publish();
    try {
      while (!signal.aborted && Date.now() < deadline) {
        const response = await interactions.response(id);
        if (response) return response;
        await sleep(INTERACTION_POLL_MS, signal);
      }
      return undefined;
    } finally {
      delete call.interaction;
      call.status = "running";
      publish();
      // The prompt is single-use either way; a failed delete only leaves an inert row behind.
      await interactions.close(id).catch(() => undefined);
    }
  }

  async function callTool(
    call: CodeModeCall,
    entry: CodeModeTool,
    rawInput: unknown,
    signal: AbortSignal,
  ): Promise<unknown> {
    // CodeMode only renders JSON Schemas, so validate like a direct call would.
    let input = rawInput;
    const schema = asSchema(entry.tool.inputSchema);
    if (schema.validate) {
      const validation = await schema.validate(rawInput);
      if (!validation.success) {
        throw new Error(`Invalid input for tools.${call.tool}: ${validation.error.message}`);
      }
      input = validation.value;
    }

    if (entry.interaction === "question") {
      const response = await ask(call, "question", signal);
      if (!response) {
        throw new DeniedCall(
          `The user did not answer within ${INTERACTION_TIMEOUT_SECONDS} seconds, so the questions were dismissed.`,
        );
      }
      if (response.kind !== "question" || "dismissed" in response) {
        throw new DeniedCall(QUESTION_DISMISSED_MESSAGE);
      }
      return { answers: response.answers };
    }

    if (entry.interaction === "approval") {
      const response = await ask(call, "approval", signal);
      if (!response) {
        throw new DeniedCall(
          `The user did not answer within ${INTERACTION_TIMEOUT_SECONDS} seconds, so this tool call was denied.`,
        );
      }
      if (response.kind !== "approval" || !response.approved) {
        throw new DeniedCall(
          response.kind === "approval" && response.reason?.trim()
            ? `The user denied this tool call: ${response.reason.trim()}`
            : "The user denied this tool call.",
        );
      }
    }

    if (!entry.tool.execute) throw new Error(`tools.${call.tool} cannot run inside Code Mode.`);
    let result: unknown = entry.tool.execute(input, {
      toolCallId: call.id,
      messages: options.messages,
      abortSignal: signal,
      context: undefined,
    });
    if (isAsyncIterable(result)) {
      let last: unknown;
      for await (const value of result) last = value;
      result = last;
    } else {
      result = await result;
    }
    return entry.mcp ? mcpValue(result, entry.tool.outputSchema !== undefined) : result;
  }

  let callIndex = 0;
  const run: Runner = async (path, entry, input, interrupt) => {
    // Worker receipts are keyed by call id; derive a unique, bounded one per inner call.
    const call: CodeModeCall = {
      id: `${toolCallId}-${callIndex++}`,
      tool: path,
      status: "running",
      ...(input === undefined ? {} : { input }),
    };
    calls.push(call);
    publish();

    const signal = linkedSignal(interrupt, abortSignal);
    try {
      const value = await callTool(call, entry, input, signal.signal);
      call.status = "completed";
      return value;
    } catch (error) {
      const message = errorMessage(error);
      call.status = error instanceof DeniedCall ? "denied" : "error";
      call.error = message;
      // The program sees the same text the model gets for a failed direct call. No cause: the
      // interpreter would append it to the message.
      throw toolError(message);
    } finally {
      signal.dispose();
      publish();
    }
  };

  const runtime = CodeMode.make({
    tools: programTools(options.inventory, options.resolved, run),
    limits: LIMITS,
  });
  let settled = false;
  const program = Effect.runPromise(runtime.execute(options.code), { signal: abortSignal });
  const done = program.then(
    () => void (settled = true),
    () => void (settled = true),
  );

  while (true) {
    if (!dirty) await Promise.race([changed.promise, done]);
    if (settled) break;
    dirty = false;
    yield { output: "", calls: snapshot(calls) };
    await Promise.race([sleep(PROGRESS_INTERVAL_MS, abortSignal), done]);
  }

  const result = await program;
  yield {
    output: formatResult(result),
    calls: snapshot(calls),
    ...(result.ok ? {} : { error: true as const }),
  };
}

/**
 * The `# Code Mode` system prompt section. Direct tools are listed by name only (their schemas are
 * already in the tool list); namespaced tools are listed with signatures up to a token budget, and
 * a partial catalog points the model at `search(...)`. Selection follows OpenCode: every namespace
 * keeps its header, then the cheapest remaining listing of each namespace is added per round.
 */
export function renderInstructions(
  inventory: CodeModeInventory,
  catalog: ReadonlyArray<CodeMode.ToolDescription>,
): string {
  const namespaces = Object.entries(inventory.namespaces)
    .map(([name, { description }]) => {
      const listings = catalog
        .filter((item) => item.path.startsWith(`${name}.`))
        .map((item) => {
          const firstLine = item.description.split("\n", 1)[0]?.trim() ?? "";
          const summary =
            firstLine.length > CATALOG_DESCRIPTION_LIMIT
              ? `${firstLine.slice(0, CATALOG_DESCRIPTION_LIMIT - 3)}...`
              : firstLine;
          const line = `  - ${item.signature}${summary ? ` // ${summary}` : ""}`;
          return { path: item.path, line, cost: tokenCost(line) };
        })
        .sort((left, right) => left.cost - right.cost || compareText(left.path, right.path));
      return { name, description, listings, selected: 0 };
    })
    .sort((left, right) => compareText(left.name, right.name));

  const header = (namespace: (typeof namespaces)[number], shown: number) => {
    const total = namespace.listings.length;
    const count = total === 1 ? "1 tool" : `${total} tools`;
    let label = count;
    if (shown === 0) label = `${count}, none shown`;
    else if (shown < total) label = `${count}, ${shown} shown`;
    return `- ${namespace.name} (${label})${namespace.description ? ` // ${namespace.description}` : ""}`;
  };

  let remaining =
    CATALOG_BUDGET_TOKENS -
    namespaces.reduce((total, namespace) => total + tokenCost(header(namespace, 0)), 0);
  const active = new Set(namespaces.filter((namespace) => namespace.listings.length > 0));
  while (active.size > 0) {
    for (const namespace of active) {
      const candidate = namespace.listings[namespace.selected];
      if (!candidate || candidate.cost > remaining) {
        active.delete(namespace);
        continue;
      }
      remaining -= candidate.cost;
      namespace.selected += 1;
      if (namespace.selected === namespace.listings.length) active.delete(namespace);
    }
  }

  const total = namespaces.reduce((sum, namespace) => sum + namespace.listings.length, 0);
  const shown = namespaces.reduce((sum, namespace) => sum + namespace.selected, 0);
  const directNames = Object.keys(inventory.tools);

  const sections = [
    "# Code Mode",
    "The `execute` tool runs JavaScript that calls tools through `tools`. Use it to chain dependent calls, run independent calls together, or reduce large results before they reach you.",
  ];
  if (directNames.length > 0) {
    sections.push(
      `Your direct tools are also callable inside \`execute\` with the same name and input: ${directNames
        .map((name) => `\`tools.${name}\``)
        .join(", ")}. Call them directly when you need nothing else.`,
    );
  }
  if (namespaces.length > 0) {
    sections.push(
      "Namespaced tools come from MCP servers. They cannot be called directly: they only work as JavaScript inside `execute`.",
    );
    sections.push(
      shown < total
        ? `The catalog is partial. Before calling a tool that is not listed below, find it with the global \`search(...)\` function. Do not guess tool names. Each result's \`path\` is the complete call expression: write it out as code, for example \`await tools.ns.tool_name({ ... })\`. Do not use it as a key such as \`tools[path]\`.\n\n- ${searchSignature}`
        : "The catalog is complete. Do not guess tool names.",
    );
    sections.push(
      [
        "## Code Mode tools (call only inside `execute`)",
        ...namespaces.flatMap((namespace) => [
          header(namespace, namespace.selected),
          ...namespace.listings
            .slice(0, namespace.selected)
            .sort((left, right) => compareText(left.path, right.path))
            .map((listing) => listing.line),
        ]),
      ].join("\n"),
    );
  } else {
    sections.push("Do not guess tool names.");
  }
  return sections.join("\n\n");
}

/** Model-facing result text: the value (JSON unless a string), then warnings and logs. */
function formatResult(result: CodeMode.Result): string {
  const output = result.ok
    ? typeof result.value === "string"
      ? result.value
      : (JSON.stringify(result.value, null, 2) ?? String(result.value))
    : [
        result.error.message,
        ...(result.error.suggestions ?? []).filter((hint) => !result.error.message.includes(hint)),
      ]
        .join("\n")
        .trim();
  const warnings =
    result.ok && result.warnings?.length
      ? `Warnings:\n${result.warnings.map((item) => `- [${item.kind}] ${item.message}`).join("\n")}`
      : undefined;
  const logs = result.logs?.length ? `Logs:\n${result.logs.join("\n")}` : undefined;
  return [output, warnings, logs].filter((part) => part !== undefined && part !== "").join("\n\n");
}

/** The parts of an MCP `CallToolResult` a program needs. */
const mcpCallResultSchema = z.object({
  content: z.array(
    z.looseObject({
      type: z.string(),
      text: z.string().optional(),
      mimeType: z.string().optional(),
    }),
  ),
  structuredContent: z.unknown().optional(),
  isError: z.boolean().optional(),
});

/**
 * What a program receives from an MCP tool. Error results reject; tools with an output schema
 * already return their validated structured content; otherwise structured content wins over the
 * text parts, and non-text parts are named but not inlined.
 */
function mcpValue(result: unknown, hasOutputSchema: boolean): unknown {
  const parsed = mcpCallResultSchema.safeParse(result);
  if (!parsed.success) return result;

  const text = parsed.data.content
    .map((part) =>
      part.type === "text" && part.text !== undefined
        ? part.text
        : `[${part.type}${part.mimeType ? ` ${part.mimeType}` : ""} omitted]`,
    )
    .join("\n");
  if (parsed.data.isError) throw new Error(text || "The MCP tool reported an error.");
  if (hasOutputSchema) return result;
  return parsed.data.structuredContent ?? text;
}

function snapshot(calls: CodeModeCall[]): CodeModeCall[] {
  return calls.map((call) => ({
    ...call,
    ...(call.interaction ? { interaction: { ...call.interaction } } : {}),
  }));
}

/** An abort signal that fires when either source does; `dispose` detaches the listeners. */
function linkedSignal(first: AbortSignal, second: AbortSignal | undefined) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (first.aborted || second?.aborted) abort();
  first.addEventListener("abort", abort, { once: true });
  second?.addEventListener("abort", abort, { once: true });
  return {
    signal: controller.signal,
    dispose: () => {
      first.removeEventListener("abort", abort);
      second?.removeEventListener("abort", abort);
    },
  };
}

function sleep(ms: number, signal: AbortSignal | undefined) {
  const { promise, resolve } = Promise.withResolvers<void>();
  if (signal?.aborted) {
    resolve();
    return promise;
  }
  const done = () => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", done);
    resolve();
  };
  const timer = setTimeout(done, ms);
  signal?.addEventListener("abort", done, { once: true });
  return promise;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return "The tool call failed.";
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    Symbol.asyncIterator in value &&
    typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function"
  );
}

function tokenCost(text: string) {
  return Math.round(text.length / 4);
}

function compareText(left: string, right: string) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
