# ACP Sessions

Status: **implemented** (backend, Worker and Chatroom). Overview: [ACP Agents](../ACP.md). Sessions are created with `acp.CreateSession` (owner only) from a New session whose Run target is an ACP agent; the binding validator is `acpChatAgentValidator` in `packages/backend/src/acp/contract.ts`. Before the ACP session exists, `acp.GetSession` also returns the agent's last advertised `defaultConfig` and commands, so draft choices can be shown and changed.

A Radium Session (`aisdk_chats` row) with an ACP agent is bound to exactly one
ACP session on one Worker. Radium keeps the binding and a small status record;
the conversation lives in the agent.

## Binding

`aisdk_chats.agent` (optional; absent means the built-in agent):

```ts
type ChatAgent = {
  kind: "acp";
  worker: string; // Worker identity ID, same workspace as the chat
  agentId: string; // registry id or custom id, e.g. "claude-acp"
  profile: "native"; // launch profile; "gateway" arrives with Gateway mode (Agents.md#gateway-mode)
  agentVersion: string; // version that created the session
  cwd: string; // absolute directory on the Worker (Project folder or explicit)
  sessionId?: string; // ACP session ID, set by the Worker after session/new
};
```

Invariants, enforced server-side:

- `agent` is set only by `acp.CreateSession` (including import) or `acp.Fork`, and
  no mutation changes `kind`, `worker`, `agentId`, `profile` or `cwd` afterwards.
  `sessionId` is written once, by the bound Worker (`ACP_SESSION_BOUND` otherwise),
  unless an import set it at creation.
- `SetChatWorker` rejects ACP chats; Worker tool selections (`aisdk_chats.worker`,
  `tools`) do not apply to them. The built-in agent's Worker tools stay editable
  as today.
- Forking an ACP chat produces an ACP chat with the same `worker`, `agentId` and
  `cwd`. A built-in chat cannot fork into an ACP chat and vice versa.
- `POST /api/aisdk/chat` rejects ACP chats with 409; ACP turns go only through
  `acp_commands` ([Transport](Transport.md)).
- Rename, pin and delete follow ACP visibility: anyone who can see the chat may
  act ([Who Can Use It](../ACP.md#who-can-use-it)).

### `acp_sessions`

One row per ACP chat, kept apart from `aisdk_chats` so frequent changes (config,
usage, pending interactions) do not invalidate the Home `ListChats`
subscription. Only turn boundaries touch `aisdk_chats` (`activeStream`,
`lastInteractionAt`, `interruption`, `title`).

| Field                                           | Meaning                                                                                                                   |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `chat`, `worker`, `agentId`, `cwd`, `sessionId` | Owning chat, its bound Worker (indexed for the Worker's subscriptions) and a copy of the binding fields the Worker needs  |
| `status`                                        | `starting`, `idle`, `running`, `awaiting`, `failed`, `ended`                                                              |
| `epoch`                                         | Stream epoch; bumped on each snapshot so stale frames are ignored                                                         |
| `stopReason`                                    | Last `session/prompt` stop reason                                                                                         |
| `config`                                        | Current `configOptions` (ids, categories, choices, selected values), `modes`, `currentModeId`                             |
| `commands`                                      | Latest `available_commands_update` (names, descriptions, input hints)                                                     |
| `usage`                                         | Latest `usage_update`: context `used`/`size`, optional cumulative `cost`                                                  |
| `warm`                                          | Whether content is currently held in Convex ([Transport](Transport.md#warm-and-cold-sessions)); flips only on transitions |
| `history`                                       | `full` (load), `resumed` (resume, no replay) or `none`                                                                    |
| `draft`                                         | Config and mode chosen before the ACP session exists, applied after `session/new`                                         |
| `turnBy`, `userTitled`                          | Who sent the running prompt (notifications); whether a user renamed the chat                                              |

None of these fields contain conversation content. `acp.GetSession` returns them
with the agent's name and capabilities.

Home's session list shows the configured agent name next to the row's actions
for ACP Sessions; built-in Radium Sessions have no extra label. `ListChats.agent`
is `{agentId, name}` for ACP Sessions and `null` for the built-in agent. A deleted
definition falls back to its stable agent ID rather than changing the binding.

## Creating A Session

The draft shows the agent's last known config (`worker_agents.defaults`) so the
owner can pick a model and mode before any ACP session exists. The ACP session
is created on the first prompt, never on draft selection, so abandoned drafts
leave nothing in the agent's store.

```mermaid
sequenceDiagram
    autonumber
    participant UI as Chatroom
    participant CX as Convex
    participant W as Worker
    participant A as Agent

    UI->>CX: CreateChat {agent: {worker, agentId, cwd}, config choices}
    UI->>CX: acp.Prompt {chat, content, clientId}
    CX->>CX: acp_commands insert (prompt)<br/>acp_sessions status=starting, warm=true
    CX-->>W: assigned command (subscription)
    W->>CX: claim (payload removed from Convex)
    W->>A: session/new {cwd, mcpServers}
    A-->>W: sessionId, configOptions, modes
    W->>CX: bind sessionId, config
    opt draft choices differ
        W->>A: session/set_config_option (per changed option)
    end
    W->>A: session/prompt {content}
    W->>CX: status=running, activeStream=true
    loop while running and watched
        A-->>W: session/update ...
        W->>CX: chat_frames batch (≈250–500 ms)
    end
    A-->>W: prompt response {stopReason}
    W->>CX: status=idle, stopReason, activeStream=false,<br/>notify session finished
```

Only one prompt is in flight per session. `acp.Prompt` is accepted only while
the session is `idle` or `failed`; it sets `starting` until the Worker sends the
prompt, so `starting` means "admitted, not yet running" for every prompt. While
`starting`, `running` or `awaiting`, the Composer offers Stop; queued sends are
not supported because agents differ in how they handle a second `session/prompt`.

## Status

```mermaid
stateDiagram-v2
    [*] --> starting: first prompt command
    starting --> running: session/new ok, prompt sent
    starting --> failed: auth_required / spawn error
    idle --> running: prompt
    running --> awaiting: permission or elicitation
    awaiting --> running: answered / cancelled
    running --> idle: stopReason end_turn / cancelled
    running --> failed: refusal / max_tokens / max_turn_requests / process exit / Worker restart
    failed --> running: next prompt
    idle --> ended: session cannot be resumed or loaded
    failed --> ended: session cannot be resumed or loaded
    ended --> [*]
```

`acp_sessions.status` is the backend status mapped once to `RunState` at the
data boundary ([mapping](Interactions.md#run-state)).

## Config, Model And Mode

The agent, not Radium, defines which models and modes exist:

| ACP                                                           | Composer control                                                                 |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| config option, category `model`                               | Shared `ModelPicker` lists the agent's choices instead of Gateway models         |
| config option, category `thought_level`                       | Reasoning options in the same `ModelPicker`, using the agent's values and labels |
| `modes` / `current_mode_update` (or a `mode` category option) | Mode chip next to Model                                                          |
| Other config options (select, boolean)                        | Overflow menu in the Composer                                                    |

Changing a value sends a `set_config` command; the Worker calls
`session/set_config_option` (or `session/set_mode`), and the response's complete
config replaces `acp_sessions.config`. An agent-initiated
`config_option_update` or `current_mode_update` does the same. The shared picker
uses the same adapter in drafts and open Sessions. Gateway providers, service
tiers, Pro/Normal presets, reasoning budgets and workspace model preferences
do not apply to agent-owned choices and are hidden. The shared Tools trigger
remains visible but disabled: **The agent brings its own tools**.

## Reopening And Recovery

Opening a Session asks for content; it does not assume the agent still has a
live session.

```mermaid
flowchart TD
    Open["Tab opens ACP Session<br/>(heartbeat)"] --> Warm{"Already warm<br/>in Convex?"}
    Warm -- yes --> Read["Read current epoch from Convex<br/>(no Worker round trip)"]
    Warm -- no --> Online{"Worker online?"}
    Online -- no --> Offline["Show metadata + status<br/>'Content lives on Worker X'"]
    Online -- yes --> Live{"Live timeline<br/>in Worker memory?"}
    Live -- yes --> Snap["Snapshot frame:<br/>latest window + current turn"]
    Live -- no --> Load{"agent loadSession?"}
    Load -- yes --> DoLoad["session/load<br/>replay consumed on the Worker<br/>rebuilds timeline"] --> Snap
    Load -- no --> Resume{"sessionCapabilities.resume?"}
    Resume -- yes --> DoResume["session/resume<br/>history = resumed"] --> Notice["Notice: earlier history<br/>not available from this agent"]
    Resume -- no --> Ended["status = ended<br/>read-only metadata"]
    Snap --> Read
    Read --> Older["Scroll up → shared history pages"]
```

- A reload, a second Tab or another device within five minutes of the last
  heartbeat finds the Session warm and reads it straight from Convex.
- `session/load` replays the entire conversation as `session/update`
  notifications before it returns. The Worker consumes that replay to rebuild its
  in-memory timeline and sends only the requested window to Convex, so reopening
  a long session costs one bounded snapshot, not the full transcript.
- Older content is fetched page by page on scroll ([history pages](Transport.md#history-pages)).
- A Worker or agent restart during a turn loses that turn: ACP v1 cannot
  re-attach to an in-flight `session/prompt`. The Worker marks it `failed`
  (`Worker restarted` / `Agent process exited`) when it next starts, and the next
  prompt resumes or loads the session first. Nothing is re-sent automatically.
- The live timeline is evicted when the session goes idle past the idle window,
  together with `session/close`.

## Title

The agent's `session_info_update.title` wins whenever present, including later
updates (`updateSession` writes it to `aisdk_chats.title`). A user rename sets the
Radium title and stops agent titles from overwriting it (`acp_sessions.userTitled`).
When the agent sends no title, Radium's title generator names the Session: the
client that sent the first prompt calls `acp.GenerateTitle({chat, text})` right after
`acp.Prompt`. The action holds the prompt (trimmed, at most 4,000 characters) only in
memory, uses the workspace title model like built-in chats, and saves without force,
so an agent title or user rename that arrived meanwhile wins.

## MCP Servers

Status: **not implemented**; the Worker passes `mcpServers: []`.

ACP sets a session's MCP servers in `session/new`, `session/load` and
`session/resume` (`mcpServers`). Radium passes the workspace's HTTP MCP servers
there when the agent advertises `mcpCapabilities.http`.

- **Per server:** each MCP server's settings get **Available to ACP agents**
  (`mcp_servers.acp`, absent means on).
- **Per Session (planned):** an MCP servers menu will list available servers,
  all on by default. Today the shared Tools trigger stays disabled with
  **The agent brings its own tools**; there is no ACP-specific replacement.
- **Overlap:** ACP does not report which MCP servers an agent already has in its
  own config, so Radium cannot detect duplicates; two copies of a server mean
  duplicated tools and possible name clashes in the agent. The Session menu is
  the fix, and Chatroom → Agents can keep a per-agent default exclusion list
  ("this agent already has GitHub").
- **Applying changes:** servers are fixed at session setup. A change mid-Session
  applies the next time the Worker sets the session up (load/resume after
  eviction or restart); **Apply now** closes and resumes it immediately when the
  agent supports `close` and `resume`, and is hidden otherwise.
- **Secrets:** bearer tokens go from Secret Store to the Worker through a
  machine-authorized query at session setup and are handed to the agent process.
  They never pass through the browser, commands or frames. Passing a server to
  an agent means trusting that agent with its token.

## Import

Sessions created outside Radium (Zed, the agent's own CLI) are not listed
automatically. New session → Run target → **Open existing** runs `session/list`
on demand:

1. The owner picks Worker, agent and directory; the browser calls
   `acp.ListAgentSessions` (a `list` command with `cwd` set to that directory).
2. The Worker calls `session/list` and returns one page (`sessionId`, `title`,
   `updatedAt`) in the command's transient `result`, read through
   `acp.GetCommand` by the owner only and pruned five minutes later. The opaque
   `nextCursor` stays inside that result and browser memory only; ACP forbids
   persisting cursors.
3. Choosing one calls `acp.CreateSession` with that `sessionId` (no
   `session/new`); the reopen flow above loads it.

Requires `sessionCapabilities.list`. Without it the action is hidden.

## Fork

`session/fork` is unstable in ACP v1 and gated by
`sessionCapabilities.fork`. Behind a flag, the message footer Fork on the
**latest** assistant turn creates a new ACP chat bound to the forked session.
Forking from an older turn is not offered: ACP has no "fork at message".

## Delete

The Chatroom asks both questions before deleting: the normal delete
confirmation, then, when the agent advertises `sessionCapabilities.delete`,
**Also delete this session in Claude Agent?** (the agent's name), explaining that
the conversation disappears from the agent and from other clients such as Zed.
`DeleteChat({chatId, deleteInAgent})` then removes the Radium rows
(`aisdk_chats`, and through `acp.cleanupChat` `acp_sessions`, pending commands,
frames, viewers, interactions) and queues a `delete` command when confirmed, a
`close` command otherwise, carrying the binding (`agentId`, `cwd`, `sessionId`).

Both commands outlive the chat and expire after seven days if the Worker never
comes back.

## Unsupported Chatroom Actions

| Action                                           | Built-in                                | ACP                                                                                   | Why                                                  |
| ------------------------------------------------ | --------------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Revert / Restore                                 | Yes                                     | Hidden                                                                                | ACP has no history truncation                        |
| Edit and resend                                  | Yes                                     | Hidden                                                                                | Same                                                 |
| Regenerate                                       | Yes                                     | Hidden                                                                                | Same                                                 |
| Retry (interruption card)                        | Continues after the last completed step | Hidden; the card keeps Copy error                                                     | No partial-step semantics; the next prompt continues |
| Switch model (interruption card)                 | Opens Model                             | Opens the agent's Model option                                                        | Model is an agent config option                      |
| Fork                                             | Any assistant turn                      | Latest turn, `VITE_ACP_FORK=true`, `fork` capability                                  | Unstable `session/fork`                              |
| Change Worker / Agent / directory                | Worker and tools editable               | Locked                                                                                | The session lives in that agent, on that machine     |
| Tools menu, Code Mode, web search, system prompt | Yes                                     | Hidden; the [MCP servers](#mcp-servers) menu replaces it once MCP pass-through exists | The agent brings its own tools and prompt            |
| Regenerate title (Home menu)                     | Yes                                     | Hidden                                                                                | The first prompt is not stored in Radium             |
| Attachments                                      | Yes                                     | Attach control disabled with its reason                                               | Prompt attachments are a later slice                 |
