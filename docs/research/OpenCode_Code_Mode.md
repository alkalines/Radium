# OpenCode Code Mode Research

Research snapshot: 2026-10-31. Reference for a future Radium Code Mode or ACP
tool surface; **Radium has no Code Mode runtime**. Related: the Oh-My-Pi
[eval reference](../Worker/Eval_Tool.md), which runs real Bun/Python
subprocesses rather than an interpreter.

Sources:

- `anomalyco/opencode` `dev` at `dc4775a` (2026-10-31): `packages/codemode` and
  `packages/core/src/{codemode,tool,session}`.
- `@opencode/codemode@2.2.5` from npm, exercised with a throwaway script.
- A request captured from the locally installed OpenCode **v2.2.4** (isolated
  `XDG_*` dirs, OpenAI-compatible provider pointed at a local capture server,
  `opencode run --standalone "hello"`, no MCP servers, no experimental flags).

## Runtime: An Interpreter, Not A Sandbox

`@opencode/codemode` ("Effect-native confined code execution over
schema-described tools"; deps `acorn`, `effect`) is a pure TypeScript interpreter
for a JavaScript subset. Cloudflare's Code Mode runs code in V8 isolates; OpenCode
parses with `acorn` and evaluates only the features it implements
(`interpreter-support.md` is the checklist). From the README: _"Rather than trying
to sandbox arbitrary JavaScript, CodeMode only runs the language features we
implement."_

Program-visible globals:

| Global        | Source                                   | Notes                                                                      |
| ------------- | ---------------------------------------- | -------------------------------------------------------------------------- |
| `tools.*`     | Host tools, nested by namespace          | Inputs/outputs validated against Effect schemas                            |
| `search(...)` | Built in                                 | Always callable; only advertised in the prompt when the catalog is partial |
| `fetch`       | OpenCode extension (`codemode/fetch.ts`) | Same permission rules as `webfetch`; rejects `file:`; 30 s timeout         |
| JS built-ins  | Interpreter stdlib                       | `Promise.all/allSettled`, collections, `Map.groupBy`, `Date`, etc.         |

`search` signature (`searchSignature` export):

```ts
search({ query?: string, namespace?: string, limit?: number, offset?: number }): {
  items: Array<{ path: string, description: string, signature: string }>,
  remaining: number,
  next: { offset: number } | null,
}
```

Observed with the npm package:

| Program                                               | Result                                                        |
| ----------------------------------------------------- | ------------------------------------------------------------- |
| `Promise.all([tools.math.add(…), tools.math.add(…)])` | `ok`, both calls recorded in `toolCalls`                      |
| `typeof process / require / globalThis`               | all `undefined`                                               |
| `import fs from "node:fs"`                            | `ParseError: Imports and exports aren't available…`           |
| `eval("1+1")`                                         | `ExecutionFailure: ReferenceError: Unknown identifier 'eval'` |
| `while (true) {}` with `limits.timeoutMs: 2000`       | `TimeoutExceeded`                                             |
| `search("add")` (string argument)                     | `InvalidToolInput`; it takes an object                        |

Semantics: REPL-style result (final expression if no `return`, `undefined` →
`null`); un-awaited calls are interrupted when the program ends and their
rejections become warnings. Failures are data (`ok: false` with a diagnostic
kind such as `UnknownTool`, `InvalidToolInput`, `ToolFailure`), not exceptions.

**Limits are off in sessions.** `CodeMode.make` supports `timeoutMs`,
`maxToolCalls`, and `maxOutputBytes`, but `CodeModeTool.runtime()` passes none.
Only the scheduler's `if`/`until` checks (`schedule/check.ts`) set limits.

## Tool Split

Every registered tool has `options.codemode`, defaulting to `true`. Core
filesystem/shell tools opt out and stay native provider tools; the rest are only
reachable through `execute`.

| Native tool calls (`codemode: false`)                                                                                                         | Code Mode only (`codemode: true`)                                                                |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `read`, `write`, `edit`, `patch`, `glob`, `grep`, `shell`, `webfetch`, `websearch`, `question`, `todo`, `skill`, `subagent`, `image-generate` | `opencode.*` management tools, MCP tools (namespace = server name), `browser.*` (desktop plugin) |

`opencode` namespace (`core/src/tool/plugin/{opencode,mcp-resource,schedule,artifact}.ts`):

| Tool                                                  | Notes                                                                  |
| ----------------------------------------------------- | ---------------------------------------------------------------------- |
| `session_rename`, `session_move`                      | `session_move` pinned; current session moves at the next safe boundary |
| `worktree_create`, `worktree_list`, `worktree_remove` | All pinned; remove requires `edit` permission                          |
| `models`                                              | Model search with variants, tiered cost, status                        |
| `list_mcp_resources`, `read_mcp_resource`             |                                                                        |
| `schedule_create/list/pause/resume/delete`            | Only with `experimental.schedules`                                     |
| `artifact_create/read/update/delete`                  | Only with `experimental.artifacts`                                     |

MCP servers opt out per server with `codemode: false`. The built-in
`opencode.mcp.codemode.defaults` plugin disables OpenCode Code Mode for servers
that are Code Mode themselves (`executor.sh`, local `executor mcp`) and forces
PostHog into `tools` mode via `x-posthog-mcp-mode` so Code Mode is never nested.

Inner calls go through the same `beforeExecute` hook and permission path as
native calls (`tool.ts` → `executeTool`), and their error text matches what a
direct call would return. Each inner call and `fetch` becomes a progress row
(`running`/`completed`/`error`), throttled to one update per 100 ms.

**Denying `execute` re-exposes tools.** In `core/src/tool.ts`, when `execute` is
wholly denied, all Code Mode tools become native tools. The v2 docs page
(`opencode.ai/v2/docs/tools`) says denying `execute` removes them; the source does
the opposite.

## Prompt Assembly

`SessionModelRequest.baseTranscript` sends one system message built from two
parts:

1. Base prompt `session/runner/prompt/system.txt` (or `agent.system`), with tool
   guidance lines added only when `shell`, `write`, or `edit` are present.
2. Instruction sources joined in cache-friendly order (`session/context.ts`):
   Code Mode catalog, MCP, references, skills, project discovery, built-ins
   (model, date, environment), entries.

Captured tool list: `edit, glob, grep, question, read, shell, skill, subagent,
webfetch, websearch, write, execute`.

### `execute` Tool

Input schema `{ code: string }`. The description is invariant so the tool
definition stays cache-stable; the changing catalog lives in the system prompt:

```text
Run JavaScript in a confined Code Mode runtime to script tool calls and HTTP requests and compose their results.
`fetch` is available for HTTP requests. Imports, direct filesystem access, and timers are unavailable: there is no `setTimeout` or sleep. All other external access goes through `tools`.
Within `{ code }`, the only callable tools are those explicitly listed in the Code Mode catalog instructions or returned by the `search` function. Inside `{ code }`, ignore tools shown outside the Code Mode catalog. They are not available in the Code Mode runtime.
Call tools through `tools` using only exact paths and signatures from the catalog. Do not infer or normalize tool names; preserve bracket notation such as `tools.<namespace>["tool-name"](input)`.
Prefer an explicit `return`; if omitted, the final top-level expression becomes the result.
Await every call whose completion matters; pending calls are interrupted when execution ends. Run independent calls concurrently with `Promise.allSettled`.
```

Result to the model: formatted value (JSON unless a string), then `Warnings:`
and `Logs:` sections, plus any file parts returned by inner tools (e.g. images).
Metadata carries the inner `toolCalls` rows for the UI.

### Catalog Rendering

`codemode/catalog.ts` and `codemode/instructions.ts`:

- Inline budget of about 2,000 tokens (4 characters per token).
- Every namespace keeps a header line with its tool count and description.
- Pinned tools are always listed; others are added one per namespace per round,
  cheapest first, until the budget is spent.
- Descriptions use the first line, truncated to 120 characters.
- Signatures are TypeScript-like, generated from input/output schemas with
  annotations (`@pattern`, `@minLength`, `@integer`) as doc comments.
- Complete catalog → "The catalog is complete. Do not guess tool names."
- Partial catalog → instructs `search(...)` first, never guess names, and write
  each result's `path` as a call expression, not `tools[path]`.
- Zero tools → "No Code Mode tools are currently available… Do not call
  `execute`…"
- Mid-session catalog changes are sent as a delta (added, changed, removed
  tools or namespace counts) when shorter than a full replacement.

### Captured System Prompt

Verbatim from the v2.2.4 capture (environment values are from the isolated run):

```text
You are an AI agent running in OpenCode, a coding agent harness. Help the user accomplish their goals using the tools you have available.

# Harness
- Responses are rendered as GitHub-flavored Markdown.
- `<system-reminder>` blocks are harness instructions, not user-authored content. Read and follow them.
- Prefer parallelizing independent tool calls.
- Prefer dedicated tools over shell commands; fall back to the shell when a tool cannot do what you need.
- Do not chain shell commands with separators like `echo "====";` or `printf '---'`; the output becomes noisy in a way that makes the user's side of the conversation worse.
- Use the write tool to create files or completely replace their content. Prefer using the edit tool for targeted changes.
- Use the edit tool for targeted changes to existing text files. It replaces the exact text in `oldString` with `newString`, and the values must differ. By default, `oldString` must occur exactly once. If it occurs multiple times, include more surrounding context to make it unique or set `replaceAll` to true to replace every occurrence.

# Communication
- Use clear file paths when referring to files.
- Keep responses clear and concise, and avoid unnecessary technical jargon.

# Working in codebases
- Keep changes consistent with the structure, naming, style, and patterns of the surrounding code.
- Treat unfamiliar files or changes as potential user work and investigate before deleting or overwriting them.

# Your Model
- Name: Capture
- Provider ID: cap
- Model ID: cap
# Code Mode

The tools listed below cannot be called directly: they only work as JavaScript inside the `execute` tool. Every other tool you have is a normal tool call: call it directly, never inside `execute`.

The catalog is complete. Do not guess tool names.

## Code Mode tools (call only inside `execute`)

- opencode (8 tools) // Tools for managing OpenCode itself, such as working with sessions and worktrees, searching the available models, and reading MCP resources.
  - tools.opencode.list_mcp_resources({
  /** MCP server name as configured. Omit to list every server. */
  server?: string,
}): Promise<{
  resources: Array<{
      server: string,
      name: string,
      uri: string,
      description?: string,
      mimeType?: string,
    }>,
  templates: Array<{
      server: string,
      name: string,
      uriTemplate: string,
      description?: string,
      mimeType?: string,
    }>,
}> // List documents, records, and other data exposed by MCP servers. Use this when the user refers to something that is no...
  - tools.opencode.models({
  /** Text to search for in model names and IDs. */
  query?: string,
  /** Provider ID or name to filter by. Try your own provider first. */
  provider?: string,
  /**
   * Which kind of model to list. Defaults to "chat".
   * "chat": a language model (LLM). Powers sessions, agents and subagents, and can call tools.
   * "image": generates or edits images from a prompt. It can't chat or call tools.
   */
  type?: "chat" | "image",
  /** Include older versions of each model family. By default only the newest version is listed. */
  all?: boolean,
  /** Maximum number of models to return. Defaults to 20. @integer @minimum 1 @maximum 100 */
  limit?: number,
  /** Number of models to skip, for paging through results. @integer @minimum 0 */
  offset?: number,
}): Promise<{
  /** Matching models grouped by provider. Your own provider comes first. */
  providers: Array<{
      id: string,
      name: string,
      /** Newest first. */
      models: Array<{
          /** providerID/modelID */
          id: string,
          name: string,
          /** Release date as a Unix timestamp in milliseconds, or 0 when unknown. */
          released: number,
          variants: Array<string>,
          /** Pricing in USD per million tokens. */
          cost: Array<{
              tier?: {
                type: "context",
                /** @integer */
                size: number,
              },
              input: number,
              output: number,
              cache: {
                read: number,
                write: number,
              },
            }>,
          status: "alpha" | "beta" | "deprecated" | "active",
        }>,
    }>,
  /** Number of matching models across all pages. @integer */
  total: number,
  /** Offset of the next page, or null on the last page. */
  next: number | null,
}> // Search the models available to use. Use this to turn a model name the user mentions into an exact reference for a too...
  - tools.opencode.read_mcp_resource({
  /** The server field of the discovered resource. */
  server: string,
  /** Exact resource URI from discovery, an expanded uriTemplate, or the user. */
  uri: string,
}): Promise<{
  server: string,
  uri: string,
  contents: Array<{
        type: "text",
        uri: string,
        text: string,
        mimeType?: string,
      } | {
        type: "blob",
        uri: string,
        blob: string,
        mimeType?: string,
      }>,
}> // Read one MCP resource by server and URI. Not for local files. Always return the full contents rather than slicing or ...
  - tools.opencode.session_move({
  /** Omit to move the current session. @pattern ^ses */
  sessionID?: string,
  /** Destination directory, relative to the target session's directory or absolute. Supports ~. @minLength 1 */
  directory: string,
}): Promise<{
  /** @pattern ^ses */
  sessionID: string,
  directory: string,
}> // Move a session to another directory, or omit sessionID to move the current session. The current session moves at the ...
  - tools.opencode.session_rename({
  /** Omit to rename the current session. @pattern ^ses */
  sessionID?: string,
  /** New session title. @minLength 1 */
  title: string,
}): Promise<{
  /** @pattern ^ses */
  sessionID: string,
  title: string,
}> // Rename a session, or omit sessionID to rename the current session. Use a short, specific title that summarizes the wo...
  - tools.opencode.worktree_create({
  name: string,
}): Promise<{
  directory: string,
}> // Create a named worktree. Returns its directory.
  - tools.opencode.worktree_list(): Promise<{
  worktrees: Array<{
      directory: string,
      strategy?: string,
    }>,
}> // List a repository's worktrees.
  - tools.opencode.worktree_remove({
  /** Absolute path of the worktree to remove. @minLength 1 */
  directory: string,
  /** Discard modified and untracked files. Only set this when the user has confirmed forced removal. */
  force?: boolean,
}): Promise<{
  directory: string,
  removed: boolean,
}> // Remove a worktree. The repository location selects configuration; directory identifies the worktree to remove.

Skills provide specialized instructions and workflows for specific tasks.
Use the skill tool to load a skill when a task matches its description.
The user may also invoke a skill directly. When that happens, its instructions appear in the conversation as a <skill_content> block, the same shape the skill tool returns. A skill that is already present this way does not need to be invoked again.
<available_skills>
  <skill>
    <id>opencode</id>
    <name>OpenCode</name>
    <description>Use this skill for any question about OpenCode itself, including how OpenCode works, using or configuring it, migrating from V1 to V2, troubleshooting it, developing plugins or integrations, using the OpenCode SDK, clients, server, or API, and contributing to the OpenCode codebase. Also use it for OpenCode agents, commands, skills, tools, permissions, MCP servers, providers, models, themes, keybinds, formatters, the CLI, TUI, desktop app, and web app.</description>
  </skill>
  <skill>
    <id>report</id>
    <name>Report</name>
    <description>Use when the user wants to report an opencode issue or bug. Collect standard diagnostics, add user-specific reproduction context, and publish the issue with GitHub CLI.</description>
  </skill>
</available_skills>

Today's date: Sat Oct 31 2026

Here is some useful information about the environment you are running in:
<env>
  Working directory: /tmp/occap/proj
  Workspace root folder: /tmp/occap/proj
  Is directory a git repo: yes
  Platform: linux
  Prefer /tmp/opencode over generic system temporary directories such as /tmp; it is pre-created and approved for external access.
</env>
When you create a worktree outside the current working directory and intend to use it as your primary working directory, consider using `execute` to call `tools.opencode.session_move` and make the worktree the session's working directory.
```

The final line is a built-in instruction that steers the model across the
native/Code Mode boundary (create a worktree, then move the session into it).

## Takeaways For Radium

- Keep the `execute` definition invariant and deliver the catalog as system
  instructions, with a token budget, pinned entries, and `search` for overflow.
- Keep high-volume primitives (read/edit/shell) native; route management, MCP,
  and long-tail integrations through Code Mode.
- Run inner calls through the same permission and hook path as native calls, and
  return the same error text.
- An interpreter gives a confinement boundary without isolates or subprocesses,
  but timeouts and call caps must be set explicitly; OpenCode leaves them unset
  for sessions.
- Decide explicitly what denying the code tool does to its tools; OpenCode's
  docs and source disagree.

## References

- [`packages/codemode` README](https://github.com/anomalyco/opencode/blob/dev/packages/codemode/README.md)
- [`core/src/codemode/tool.ts`](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/codemode/tool.ts), [`instructions.ts`](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/codemode/instructions.ts), [`catalog.ts`](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/codemode/catalog.ts), [`fetch.ts`](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/codemode/fetch.ts)
- [`core/src/tool/plugin/opencode.ts`](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/tool/plugin/opencode.ts)
- [`core/src/session/runner/prompt/system.txt`](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/session/runner/prompt/system.txt)
- [OpenCode v2 tools docs](https://opencode.ai/v2/docs/tools/)
- [Cloudflare: Code Mode](https://blog.cloudflare.com/code-mode/)
