# E2EE Data

Status: **partly implemented.** Part of [End-to-end encryption](../E2EE.md). Keys and the envelope format are in [Keys](Keys.md). Table references are `packages/backend/convex/schema.ts` unless stated. Built-in Chatroom content is encrypted for chats created by accounts with keys; paired Workers encrypt ACP content and built-in tool persistence ([task 11 phases 5–7](../tasks/11_E2EE.md)). Telemetry, notifications and legacy-data migration remain planned.

## Classes

| Class | Meaning                                                                                               | Who reads it                             |
| ----- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| **E** | Encrypted by a client (browser, app, Worker) to a chat, workspace, user or Worker key                 | Clients holding that key                 |
| **S** | Plaintext reaches the backend during a request; the backend seals it to a public key before writing   | Clients holding the matching private key |
| **P** | Plaintext because the backend needs it to authorize, route, schedule, enforce limits or account usage | Backend and authorized clients           |
| **K** | Secrets the backend must use (upstream credentials): Secret Store, server-decryptable by design       | Backend                                  |

## Current State

Encrypted today, for Chatroom chats created by an account with keys (`aisdk_chats.e2eeId` set): `chat_messages.sealed` (per-turn capsules in `e2ee_capsules`), `aisdk_chats.sealedTitle` and `sealedQueue`, and attachment bytes in File Storage (`chat_files.capsule`). Workspace-scope chats are encrypted only once their workspace has keys. Telemetry never records content of encrypted chats.

Paired Workers persist ACP frames, commands, interactions, titles and session errors as ciphertext; built-in tool requests, request-key results and durable receipts are sealed. Session-specific config and available commands travel inside encrypted frames, not plaintext session patches. Keyless workspaces with unpaired Workers retain legacy plaintext behavior and trust their backend.

Still plaintext: legacy chats and attachments awaiting migration; workspace/project names and folders; Worker/ACP directories, installation reports and availability; routing, audience, status and usage metadata; notifications and telemetry (encrypted chats suppress content capture and notification titles). Secret Store encrypts credentials with a deployment-held KEK, which protects ciphertext at rest but not from the backend.

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
| ACP               | `acp_agent_sessions.title`; `acp_sessions` error text; `aisdk_chats` ACP title                                          | E     | Index titles sealed to the owner key, errors and titles to the chat key. No server title-search index. Directories and history availability stay P. |
| ACP               | `acp_sessions` status and usage; `acp_usage`; `acp_streams` counters                                                   | P     | Session config values and commands are inside encrypted frames; run state and usage stay readable. |
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
2. Attachments keep today's flow: the browser uploads them to Convex File Storage, never into a table (`src/chatroom/files.ts`), and the message's file part references the stored file; `inlineStoredFiles` then gives the provider the bytes, since providers cannot fetch the deployment's storage URL. Under E2EE the browser creates one capsule per file to the chat key (stored on the `chat_files` row) and encrypts the file under the derived object key before uploading. The file part carries that 32-byte object key ([Keys § Envelope format](Keys.md#envelope-format)) in the URL fragment (`#rf1.<fileId>.<chat>.<key>`), so the key exists only inside sealed messages and in the turn request; `inlineStoredFiles` decrypts before inlining and every other server path strips the fragment. Forks reuse the file without re-encrypting it. As a side effect, a leaked storage URL (an unguessable capability URL today) no longer exposes the file.
3. The action runs the turn as today, then creates one key capsule to the chat public key and seals what it persists: the new user message and the assistant output with its tool parts, and the title on the first turn. Creating the capsule needs randomness, which the HTTP action has. The action then drops all keys and plaintext.
4. `saveChatMessages` (`src/chatroom/messages.ts`) no longer compares canonical plaintext to detect changed positions, because stored content is not readable; each row has the AI SDK message ID and a revision. The request carries the revision the client loaded for each message, and the action seals only positions whose ID or revision differs, new positions and the response message.

The browser writes the rest itself: the queued first prompt and renamed titles are boxes sealed to the chat key, and forks re-seal the decrypted history for the new chat's key. Chats without keys (accounts or workspaces that have not set up encryption) keep the plaintext path until the [migration](#migration); rows of one chat may mix both forms.

The chat private key never leaves the client. The server sees the conversation for the duration of the turn, as it must to call the provider; it keeps none of it.

### Titles

Title generation (`src/chatroom/titles.ts`) runs inside the first turn of an encrypted chat, concurrently with the response, from the first user message in that request; the result is stored as a title box sealed to the chat key (class S). Regenerating a title is the `aisdk.regenerateTitle` action, to which the client sends the decrypted first user message; renaming is done by the client, which seals the new title itself. Encrypted ACP chats never send the first prompt to the server: the browser seals a fallback title from it (`acp.SetFallbackTitle`), and titles the agent reports are sealed by the Worker to the chat key (a user rename still wins).

### Search

Server-side full-text search over titles ends (`acp_agent_sessions` `search_title`). Home loads the session list it already pages through, decrypts titles in the client and filters locally. Lists are workspace-scoped and small enough for this; if they stop being small, the fallback is a client-maintained encrypted search index, not a server index of plaintext.

### ACP

The Worker is a client, so ACP is end-to-end (browser ↔ Worker) in workspaces with keys, except in [Gateway mode](../ACP/Agents.md#gateway-mode), where the agent's model calls pass through the Gateway like any API request. Implemented in phase 7 (`src/acp/sealed.ts` and the `signed`/`sealed` arguments in `src/acp/{browser,machine}.ts`; Worker `packages/worker/src/acp/`; web `components/session/acp/`). Keyless workspaces with unpaired Workers keep the plaintext path.

- **Binding**: the chat's creator signs `acpBindingStatement` (Worker, agent, profile, directory, scope, members, version) at creation and re-signs it with a higher version on every scope or member change; `acp_sessions.binding` stores it. The Worker pins the creator per chat, refuses lower versions, takes the directory, agent and profile only from it, and authorizes signers by it: personal → creator, shared → creator and members, workspace → roster. Agent-level commands (`authenticate`, `logout`, `sync_sessions`) need the owner. Shared ACP chats are allowed.
- **Executable definitions**: the owner explicitly reviews and signs the full launch command, arguments, environment and Gateway template before paired Workers probe or execute it. Workers persist per-agent issuance marks and reject changed or older definitions. A signed disable advances the mark before stopping execution. Removing a server row is not cryptographic revocation: a relay can withhold a newer disable or replay an authorization the Worker has not superseded; stop the local Worker for immediate revocation.
- **Commands and answers** (`acp_commands.signed`, `acp_interactions.sealedAnswer`): the browser seals the payload to the Worker's encryption key and signs it with the user's identity key; Convex retains routing, kind, issuer and client ID, never keyed-session config values. The Worker verifies signature, signer and freshness before acting, applies pre-session choices only from signed commands (never the draft), and re-opens an interaction whose answer is forged, unauthorized or invalid (`acp.reopenInteraction`). `close`/`delete` after chat deletion carry a binding snapshot. Worker errors are fixed codes or sealed to the chat key (`acp_sessions.sealedError`).
- **Frames** (`chat_frames`): for each stream epoch the Worker creates one key capsule to the verified chat public key, signs it and stores it on `acp_streams`; each frame seals `{seqTo, kind, ops}` under that capsule and its frame AAD. Viewers verify the capsule signature against the roster's Worker, open it once per epoch and authenticate routing metadata before advancing their cursor. Retries use the exact same ciphertext bytes.
- **Session index**: titles are sealed by the Worker to the owner key with a Worker-keyed tag for diffing; Home decrypts and filters them locally. `cwd` stays plaintext (residual leakage, see below).
- **Legacy bindings**: a pre-encryption session ID has no authenticated ownership proof. Pairing never silently signs that server-supplied ID; use owner-authorized re-import from the agent index or create a new session. Existing plaintext records are not migrated by phase 7.

### Worker Tasks From The Built-In Agent

Edit and Bash tool calls are decided by the agent loop in Convex, so the backend authors them.

- The action seals each stage to the paired Worker's certified encryption key and polls for a result encrypted under its request key ([Keys § Request keys](Keys.md#request-keys)); `worker_tasks` holds ciphertext only (`sealed`, `sealedResult`). Plaintext tasks remain only for workspaces without keys and chats without keys with an unpaired Worker; an encrypted chat never dispatches one.
- The Worker seals the durable receipt (`worker_chat_calls.sealedResult`) to the chat public key epoch the action passes inside the sealed request. A replayed call stage gets a fixed "already executed" outcome, never plaintext.
- Directories stay plaintext metadata in phase 7 (residual leakage); the Worker takes the directory only from the user-signed approval or grant.
- **Approvals are signed by the user.** Edit/Create/Bash run only with the owner's signature over `toolApprovalStatement` (exact input JSON the user saw, chat, Worker, directory, tool, call ID, `approvedAt`), accepted for 24 hours and once. Read runs under the owner's standing grant (`toolGrantStatement`, no expiry; a newer `issuedAt` replaces it and the Worker refuses older ones), signed whenever the owner changes the selection or opens the chat unlocked. The AI SDK approval HMAC remains only as the SDK's replay guard, keyed by an HKDF-derived key, not the issuer key.

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
