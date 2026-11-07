# E2EE Data

Status: **planned.** Part of [End-to-end encryption](../E2EE.md). Keys and the envelope format are in [Keys](Keys.md). Table references are `packages/backend/convex/schema.ts` unless stated.

## Classes

| Class | Meaning                                                                                               | Who reads it                             |
| ----- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| **E** | Encrypted by a client (browser, app, Worker) to a chat, workspace, user or Worker key                 | Clients holding that key                 |
| **S** | Plaintext reaches the backend during a request; the backend seals it to a public key before writing   | Clients holding the matching private key |
| **P** | Plaintext because the backend needs it to authorize, route, schedule, enforce limits or account usage | Backend and authorized clients           |
| **K** | Secrets the backend must use (upstream credentials): Secret Store, server-decryptable by design       | Backend                                  |

## Current State

Everything user-authored is plaintext today: `chat_messages.message`, `aisdk_chats.title` and queued prompts, `chat_frames.payload` (ACP transcripts while warm), `acp_commands.payload`, `acp_interactions`, `worker_tasks` requests and results, `worker_chat_calls` receipts, project names and folders, `notifications.title`/`body`, `telemetry_blobs.content` and Convex File Storage (attachments, large telemetry blobs). Secret Store encrypts credentials with a deployment-held KEK, which protects ciphertext at rest but not from the backend.

## Classification

| Domain            | Tables and fields                                                                                                      | Class | Notes                                                                                                                                |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Accounts          | Better Auth `user` (email, name), `session`, `account` (OPAQUE record)                                                 | P     | Needed to sign in. The OPAQUE record is not a password hash usable without the OPRF key.                                             |
| Keys              | New: user keys, AMK wrappers, workspace key grants, chat keys, roster, Worker certificates                             | E / P | Wrapped keys are E; public keys, fingerprints and signatures are P.                                                                  |
| Workspaces        | `workspaces.name`, icon; `workspace_members`                                                                           | E / P | Name under the member key; membership and roles stay P.                                                                              |
| Chats             | `aisdk_chats`: title, emoji, queued prompt and files, legacy embedded messages                                         | E / S | Client writes E; generated titles are S. Scope, pinned, project, timestamps, Worker ID stay P.                                       |
| Messages          | `chat_messages.message`                                                                                                | S     | Built-in Chatroom messages are written by the turn's action, sealed to the chat key. Position and chat stay P.                       |
| Attachments       | Convex `_storage` bytes, `chat_files` filename                                                                         | E     | Encrypted before upload; media type and size stay P (size is padded).                                                                |
| Projects          | `projects` name, icon, per-Worker folders                                                                              | E     | Folders are also sealed to each listed Worker so it can resolve directories ([Worker tasks](#worker-tasks-from-the-built-in-agent)). |
| ACP               | `chat_frames.payload`, `acp_commands.payload`/`result`/`error`, `acp_interactions.request`/`answer`                    | E     | Browser ↔ Worker; Convex relays ciphertext.                                                                                          |
| ACP               | `acp_agent_sessions.title`, `cwd`; `acp_sessions.cwd`, `history`, `draft`, error text                                  | E     | Session index sealed by the Worker to the owner key. The full-text `search_title` index is removed.                                  |
| ACP               | `acp_sessions` status, config option IDs, usage; `acp_usage`; `acp_streams` counters                                   | P     | Run state, notifications and usage totals need them.                                                                                 |
| Worker tools      | `worker_tasks.editRequest`/`bashRequest`/`result`; `worker_chat_calls.result`, `directory`                             | S / E | Requests sealed to the Worker; results to the request key; receipts to the chat key.                                                 |
| Workers           | `worker_presence.tempDirectory`, `worker_agents` reports                                                               | E / P | Local paths E (owner key); availability and capabilities P.                                                                          |
| Notifications     | `notifications.title`, `body`                                                                                          | S / E | Sealed to the recipient's identity key. Kind, chat ID, delivery state P.                                                             |
| Push              | `push_subscriptions` endpoint and keys                                                                                 | P     | Needed to deliver; payloads are encrypted (below).                                                                                   |
| Gateway config    | `workspace_configurations`, `workspace_credentials` metadata, `api_keys`, `mcp_servers` URL, `workspace_settings`      | P     | The router reads them on every request.                                                                                              |
| Credentials       | Secret Store secrets (provider, MCP, Exa, export headers)                                                              | K     | Unchanged.                                                                                                                           |
| Usage             | `chat_completions`, `local_usage`, `credential_limits`, `limit_events`, routing state                                  | P     | Budgets, limits, per-Project totals, routing and cost estimates.                                                                     |
| Telemetry content | `telemetry_blobs.content` and `meta`, File Storage blobs, request error text                                           | S     | Sealed to the workspace owner key ([Telemetry](#telemetry)).                                                                         |
| Telemetry shape   | `telemetry_nodes`, `telemetry_requests` metadata, `telemetry_sessions`                                                 | P     | Hashes become keyed (below).                                                                                                         |
| Logging           | Logging component `events`                                                                                             | P     | Already excludes prompts and responses by contract ([logging](../logging.md)); keep it that way.                                     |
| Preferences       | `user_preferences` pinned/hidden models, notification settings                                                         | P     | Low sensitivity; notification delivery reads the notification settings server-side.                                                  |
| Local models      | Runtime snapshots, model references, published slugs ([local models](../Local_Models/Management.md#runtime-discovery)) | P     | The router needs them; catalog data, not user content.                                                                               |

## Server Flows

### Built-in Chatroom

The built-in agent loop runs in `POST /api/aisdk/chat` (`src/http/aisdk.chat.ts`) inside Convex, so the backend must see the conversation during a turn. The request keeps the AI SDK shape it has today: the client sends the whole message history with every turn.

1. The browser already holds the decrypted history it displays. It sends it, plus the new user message, as plaintext AI SDK messages, exactly as `useChat` does now. The server does not read stored messages to build the context.
2. Attachments keep today's flow: the browser uploads them to Convex File Storage, never into a table (`src/chatroom/files.ts`), and the message's file part references the stored file; `inlineStoredFiles` then gives the provider the bytes, since providers cannot fetch the deployment's storage URL. Under E2EE the browser encrypts the file before uploading, the file part also carries that file's 32-byte object key ([Keys § Envelope format](Keys.md#envelope-format)), and `inlineStoredFiles` decrypts before inlining. As a side effect, a leaked storage URL (an unguessable capability URL today) no longer exposes the file.
3. The action runs the turn as today, then creates one key capsule to the chat public key and seals what it persists: the new user message and the assistant output with its tool parts. Creating the capsule needs randomness, which the HTTP action has. The action then drops all keys and plaintext.
4. `saveChatMessages` (`src/chatroom/messages.ts`) stops comparing canonical plaintext to detect changed positions, because stored content is no longer readable; it uses client-assigned message IDs plus revisions.

The chat private key never leaves the client. The server sees the conversation for the duration of the turn, as it must to call the provider; it keeps none of it.

### Titles

Title generation (`src/chatroom/titles.ts`) runs inside the first turn, from the first user message in that request; the result is sealed with the turn's capsule (class S). Regenerating a title (`convex/aisdk.ts`) becomes a request in which the client sends the first user message. The ACP fallback title (`src/acp/browser.ts`) already receives first-prompt text from the browser.

### Search

Server-side full-text search over titles ends (`acp_agent_sessions` `search_title`). Home loads the session list it already pages through, decrypts titles in the client and filters locally. Lists are workspace-scoped and small enough for this; if they stop being small, the fallback is a client-maintained encrypted search index, not a server index of plaintext.

### ACP

The Worker is a client, so ACP becomes end-to-end (browser ↔ Worker) except in [Gateway mode](../ACP/Agents.md#gateway-mode), where the agent's model calls pass through the Gateway like any API request.

- **Commands and answers** (`acp_commands`, `acp_interactions`): the browser seals the payload to the Worker's encryption key and signs it with the user's identity key. The Worker verifies the signature against the roster before acting ([Keys § Workers](Keys.md#workers)).
- **Frames** (`chat_frames`): for each stream epoch the Worker creates one key capsule to the chat public key (referenced from the epoch row) and encrypts each frame with AES-256-GCM under the derived stream key and counter nonces. Viewers open the capsule once per epoch. Identical-retry detection in `appendFrames` (`src/acp/machine.ts`) keeps working because the Worker retries the exact same ciphertext bytes.
- **Session index**: titles, `cwd` and history pointers are sealed by the Worker to the owner key.

### Worker Tasks From The Built-In Agent

Edit and Bash tool calls are decided by the agent loop in Convex, so the backend authors them.

- The action seals the request to the target Worker's encryption key and polls for a result encrypted under its request key ([Keys § Request keys](Keys.md#request-keys)); `worker_tasks` holds ciphertext only.
- The Worker seals the durable receipt (`worker_chat_calls`) to the chat public key, which the action passes along with the task.
- Directories come from Project folders, which are E. Each folder entry is also sealed to the Worker it belongs to; the backend passes the sealed entry through and the Worker resolves it.
- **Approvals are signed by the user.** Today they use a server-derived HMAC (`src/worker/chat-tools.ts`), which a compromised backend could mint. Under E2EE a Worker runs a Chatroom tool call only with a user signature over the exact request, or under a user-signed auto-approve grant scoped to chat, Worker, tools and directory with an expiry.

### Notifications

`src/notifications/session.ts` builds bodies from chat titles, which the backend can no longer read. Notifications store a kind, chat ID and sealed `title`/`body` written by the client or Worker that caused them (for example the Worker seals "agent is waiting for you" with the session title it knows). Limit notifications built by the backend (`src/limits/events.ts`) only contain P data (provider, credential label, meters) plus the workspace name, which the client fills in.

Web Push payloads carry the notification ID and the sealed fields (well under the ~4 KiB payload limit). The service worker opens them with the key in IndexedDB; when the device is locked it shows a generic "Session finished" text.

### Telemetry

Capture (`src/telemetry/capture.ts`) runs inside the Gateway request, where plaintext is available.

- **Content** (`telemetry_blobs.content`, File Storage blobs, blob `meta` such as roles and tool names, upstream error text): sealed to the workspace **owner key**. Owner-only reads become cryptographic. Requests from members' personal chats keep recording no content, as today.
- **Deduplication** keeps working: equality is decided on hashes, not ciphertext. Hashes change from SHA-256 over `workspaceId + canonical JSON` (`src/telemetry/hash.ts`) to HMAC-SHA-256 under a per-workspace key derived from a new deployment secret, so a leaked database cannot be checked against guessed content. A live compromised backend still sees content while capturing; the keyed hash does not change that. The same applies to node chain hashes and the first-message routing session fallback (`src/routing/session.ts`).
- **Lineage and changes** compare hashes and stay server-side. Text diffs of system prompts and tool definitions move to the client, which decrypts both versions.
- **Reads**: `getRequest` and `getRequestMessages` return ciphertext; the Gateway → Telemetry pages decrypt with the owner key.
- **Export**: scheduled exports (`convex/observability/telemetryExport.ts`) read stored rows and therefore can only send metadata (today's privacy mode). Content export becomes an explicit owner choice executed **inside the capturing request** after the response finishes, from memory, so content is never persisted in plaintext and never placed in scheduler arguments. The destination then receives plaintext; that is the owner's decision.
- **Metadata** (model, provider, attempts, timings, tokens, costs, tiers, API key) stays P; budgets, limits and usage totals depend on it.

## Residual Leakage

Even with every content field encrypted, the backend learns:

- Who belongs to which workspace, who created which chat, chat scope and Project membership.
- When each message, frame and request happened, and approximate sizes (bucketed by padding).
- Models, providers, token counts, costs, tool call counts and timings.
- Which telemetry blobs are equal within a workspace (keyed hashes reveal equality, not content).
- Worker availability, capabilities and which Worker serves which chat.

## Migration

Existing plaintext was always visible to the backend, so sealing it on the backend gives the same protection as client-side encryption for that data, at much lower cost than downloading and re-uploading everything. **Nothing is deleted.**

### Custody key

The backend cannot create keys for a user: whatever it created, it would know. Content of users and workspaces that have no keys yet is therefore sealed to a **custody key**, a deployment-held MLKEM768-X25519 key pair created at cutover, with its private half in Secret Store (`e2ee/custody`). Custody is honest about what it is: the backend can read custodial content, exactly as it can read all content today, and the UI marks such chats as "Not yet end-to-end encrypted".

- **Release.** When a user sets up encryption ([Authentication § Migrating](Authentication.md#migrating-existing-accounts)), an internal action opens their custodial rows (personal chats, notifications) and re-seals them to their new keys. Workspace content is released when an owner of the workspace has created workspace keys and their clients have created chat keys. Released capsules are deleted.
- **Unmigrated workspaces.** Until an owner of a workspace migrates, workspace keys do not exist; migrated members' new workspace chats in it are also sealed to custody and released with the rest.
- **Resets.** An unmigrated account that goes through [Forgot password](Authentication.md#forgot-password) loses nothing: custodial content is released to whatever new keys it sets up.
- **End of custody.** An operator query reports custodial rows per account and workspace. When it reaches zero, an internal mutation run from the CLI deletes the custody key; Radium refuses to create new custodial rows after that. Until then, a backend compromise exposes custodial content, as today.

The backend decapsulates only with the custody key; every other private key stays on clients and Workers.

### Steps

1. **Widen.** Add encrypted fields alongside plaintext ones and the new key tables; new writes go encrypted as soon as the writer has keys.
2. **Keys.** Users migrate their accounts; the owner client creates workspace keys and grants them to members, through access links, the workspace phrase or after the [trust prompt](Keys.md#trust-system); clients create chat keys for existing chats (public-key operations and wrapping only, no content reads).
3. **Seal.** A resumable job seals each plaintext field to the matching chat, workspace or user public key when it exists, otherwise to the custody key, writes the envelope and clears the plaintext. Sealing needs randomness, so an internal action drives it: it reads a page through an internal query, seals, and writes through an internal mutation that checks the row is unchanged; progress is recorded like the existing `@convex-dev/migrations` jobs (`convex/migrations.ts`).
4. **Verify.** Paginated checks prove no plaintext content fields remain.
5. **Narrow.** Remove the plaintext fields and the `search_title` index in a later deploy. Custodial rows are envelopes like any other, so narrowing does not wait for every user.
6. **Release** continues per user as above until custody ends.

Clearing plaintext does not remove it from earlier Convex snapshots or backups; operators should expire those after the migration. Like the [ownership migration](../Radium_Gateway/Ownership.md), this is forward-only and needs an explicitly authorized run against each deployment.
