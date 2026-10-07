# Radium Worker

The Worker package implements local machine identity setup, a narrowly scoped
authenticated Convex subscription, and an edit-task consumer that lazily loads its
native file-editing service for valid requests. It does not expose an agent protocol
or receive deployment/admin credentials.

## Setup and run

Obtain a `radium-worker-v1.` setup code from **Chatroom → Workers** in the website.
The whole code is a one-time secret. Run setup in a terminal to paste it into a
masked `@clack/prompts` input, or pipe it on stdin for automation. It is never
accepted as a command-line value or read from the Worker's environment:

```bash
# Interactive setup (masked input)
bun run --cwd packages/worker setup

# Pipe the code from a protected source; it is not echoed or logged.
printf '%s\n' "$SETUP_CODE" | bun run --cwd packages/worker setup

bun run --cwd packages/worker start
```

Run `bun run --cwd packages/worker cli` for an interactive command menu, or
`bun run --cwd packages/worker cli --help` for command/option help.

| Command                   | Purpose                                                                                                         |
| ------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `setup` / `add-token`     | Enroll with a one-time setup code; refuses to overwrite an identity.                                            |
| `start`                   | Run the authenticated outbound Convex control subscription and consume assigned edit tasks.                     |
| `status`                  | Inspect local enrollment state and identifiers; no network access.                                              |
| `refresh`                 | Recover pending identity if needed, then verify a fresh backend token exchange. Prints expiry, never the token. |
| `forget` / `forget-token` | Remove local identity and credentials. Does not revoke the backend record.                                      |

Commands and aliases are available as package scripts, for example
`bun run --cwd packages/worker add-token`, or through `cli add-token`.
Stop the Worker before forgetting its identity: a running process has an in-memory
copy of its key. Revoke the remote Worker on the Workers page to remove its authority.
Interactive removal asks for confirmation; automation requires `forget --yes`.

The setup command validates the Convex origins (HTTPS, or loopback HTTP for local
development), creates a P-256 key pair and stable request ID, and durably saves
them before contacting the backend. State defaults to `~/.radium-worker`; pass
`--state-dir PATH` to any command to select another location. The state
directory is secured to mode `0700`, and its state file is created atomically with
mode `0600`. Existing state is never replaced by a new key. The setup token is
kept in memory only for initial enrollment and is omitted from saved state.
The private key uses the OS credential store by default; headless hosts can select
the protected-file fallback described in [Credential storage](#credential-storage).

Setup always attempts proof-bound recovery before enrollment. If a completion
response was lost, run `start` with the existing pending state to recover the
committed identity, even if the setup token has since expired. If recovery says
the enrollment was not completed, rerun `setup` with the still-valid original
setup code to retry with the same saved key and request ID. A pending state does
not contain the setup token, so it cannot start a new enrollment on its own.
If the backend confirms enrollment was never completed and the original setup code
has expired, forget the pending local state and generate a new code on the Workers
page. Preserve pending state until recovery has been attempted: its key is what
recovers a successful enrollment whose response was lost.

`start` creates one `ConvexClient`, obtains short-lived machine JWTs through
challenge/proof exchanges, and subscribes to the `workers:current` query. It
reports only `connected` or `disconnected`; a null/revoked identity, auth failure,
query error, or Convex transport outage is disconnected. Failed token authentication
re-arms the same client's auth callback with jittered exponential backoff, with a
nominal delay increasing from 5 to 60 seconds; successful authentication resets the delay and shutdown
cancels pending retries. Repeated denial remains disconnected, including after owner
revocation. The same client always consumes authenticated edit assignments and
sends bounded results. Native editing is loaded lazily when a valid request supplies
its backend-selected directory. Filesystem operations stay local. The Worker opens
no inbound HTTP listener; the former `/health` endpoint and `--port` option have
been removed. Enrollment and token exchange still use outbound requests to the
Convex-hosted authentication endpoints.

The setup code's `backendUrl` and `convexUrl` are treated as explicit origins and
are never rewritten. HTTP redirects are rejected, request timeouts are bounded,
and response bodies are size-limited. Setup codes, proofs, machine JWTs, private
keys, and response bodies are not logged.

## Edit Tasks

`start` always consumes edit tasks; the execution directory comes from the
owner-authorized backend dispatch, not a CLI option. Public `dispatchEdit` requests
require `request.directory`, an absolute path on the target Worker. The Worker
canonicalizes the selected directory and confines edit paths to it; no local
directory allowlist is part of the contract. The native service is loaded only for
the first valid directory request. The edit tool supports reads that record native
snapshot provenance, staged patch previews, explicit application of a preview ID,
and session disposal. See
[native editing](../../docs/Worker/Native_Tools.md) and
[backend messaging](../../docs/Worker/Tasks.md) for contracts, bounds and limitations.

Owners dispatch via `api.worker_tasks.dispatchEdit` and subscribe to
`api.worker_tasks.outcome`; model-tool/Chatroom UI wiring is follow-up work. Sessions
are bound to a canonical directory and isolated by workspace, owner, chat and
runner session ID. A directory change during a live session fails with
`SESSION_DIRECTORY_CHANGED`; close it with its bound directory before reusing the
session ID elsewhere, which starts with fresh snapshots. At most 64 live edit
sessions are retained across all directories. Stored legacy tasks may omit
`request.directory`; those tasks fail with `DIRECTORY_REQUIRED` and never fall back
to the Worker current directory. Results may contain file
contents and diffs and are retained only in short-lived task records. No tool input
or output is printed to the terminal. Worker claims each task before touching files,
serializes edits, and retries only completion delivery. Process restart discards
snapshots/previews. Claimed tasks with unknown outcomes are never automatically
rerun; inspect the files and issue new read/preview requests.

The path policy is not an OS sandbox or a lock against other local processes changing
files. Deployed request/result transport remains unverified; local native, consumer
and backend authorization tests are separate.

## Credential storage

The durable authentication credential is the Worker's P-256 private key. Access
JWTs remain in memory and are renewed through fresh signed challenges.
`@napi-rs/keyring` stores the private key in the OS credential store. On Linux the
Worker explicitly selects the durable Secret Service backend, requiring an
available, unlocked Secret Service/keyring; macOS uses Keychain and Windows uses
Credential Manager. Linux Secret Service save/read/forget/re-enrollment has been
verified locally with isolated temporary credentials; macOS and Windows integration
remains unverified.
The adapter accepts both `null` and `undefined` for missing native entries; this
allows initial setup and fresh enrollment after `forget` without treating an empty
keyring entry as a conflicting key. A genuinely different saved key is still rejected.

Set `RADIUM_WORKER_CREDENTIAL_STORE` before initial setup or legacy-state migration:

| Value               | Policy                                                                       |
| ------------------- | ---------------------------------------------------------------------------- |
| `keyring` (default) | Require the OS store; fail if unavailable.                                   |
| `auto`              | Try the OS store; allow a protected-file fallback during creation/migration. |
| `file`              | Explicitly use a local private-key file, without encryption at rest.         |

For example, on a headless host:

```bash
RADIUM_WORKER_CREDENTIAL_STORE=file bun run --cwd packages/worker setup
```

The selected backend is saved with the recovery metadata and printed by setup,
`status`, and `start`. Version-2 `worker-state.json` contains public/recovery
metadata, never the private JWK. In file mode the key is stored separately as
`.worker-credential-<requestId>.json`, with mode `0600` inside the `0700` state
directory. This is a permissions-based fallback, not encrypted storage.
These file protections use POSIX ownership/modes; Windows ACL hardening is not implemented.

Existing version-1 state is migrated locally, preserving the original key, request
ID, setup selector, and identity. Migration completes before any authentication
request. Subsequent reads use the recorded backend; a missing or locked keyring
credential never causes creation of a replacement key or a downgrade. Reading a
saved identity with an explicit mode that conflicts with its backend is rejected. Changing this variable
does not relocate existing version-2 credentials.

`forget` deletes the selected OS/file credential and local metadata. Local file
overwriting is best-effort; it cannot guarantee erasure from snapshots, backups,
or copy-on-write storage. It does not revoke the remote identity.

## Development checks

### Source organization

| Path                                                                        | Responsibility                                                              |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `src/cli.ts`                                                                | Executable entry point and sanitized command-error output.                  |
| `src/cli/run.ts`                                                            | Lifecycle command dispatch and interactive menu.                            |
| `src/cli/options.ts`                                                        | Command aliases, option validation and help text.                           |
| `src/cli/input.ts`, `src/cli/prompt.ts`                                     | Protected setup input and terminal presentation.                            |
| `src/cli/start.ts`                                                          | Startup, status reporting and signal-driven shutdown.                       |
| `src/auth/enrollment.ts`                                                    | Initial enrollment and restart recovery using persisted keys.               |
| `src/auth/proof.ts`                                                         | Challenge validation and Worker-key proof signing.                          |
| `src/auth/token.ts`                                                         | Access-token exchange, cache and concurrent-refresh deduplication.          |
| `src/auth/state.ts`, `src/auth/credentials.ts`, `src/auth/private-files.ts` | Recovery metadata, credential adapters and protected local file operations. |
| `src/control.ts`                                                            | Typed Convex subscription, auth retry and connection cleanup.               |
| `src/tasks.ts`                                                              | Serialized edit claims, local execution and completion receipts.            |
| `src/edit/`                                                                 | Directory routing, native snapshot/preview sessions and local path policy.  |
| `src/protocol.ts`                                                           | Setup/HTTP boundary validation and shared wire types.                       |

`src/auth.ts` and `src/state.ts` retain small export facades for existing callers.
Future tool implementations should have their own domain modules and use the
control connection for coordination. Keep machine credentials and auth lifecycle
owned by `auth/`, outside executed workloads.

The backend's [task coordination contract](../../docs/Worker/Tasks.md) provides
assignment/status persistence, edit request/result transport and terminal cleanup.
Task consumption runs on every `start`; the backend dispatch selects each
target-Worker directory. Chatroom integration and additional tools remain follow-up
work.

### Commands

```bash
# Watch/restart the enrolled Worker independently of Vite and Convex
bun run dev:worker

bun run --cwd packages/worker test
bun run --cwd packages/worker test:unit tasks.test.ts
bun run --cwd packages/worker test:edit
bun run --cwd packages/worker typecheck
```

`dev:worker` delegates to `bun run --cwd packages/worker dev` (`bun --watch`).
Enroll first, then run it alongside root `bun run dev`. Enrollment state lives
outside the watched source tree and survives process restarts. `--state-dir`
can be passed to the package's `dev` script just as with `start`.

The Worker depends on `backend` through `workspace:*` for generated Convex API
references and return types. `control.ts` subscribes using `api.workers.current`;
changes to that backend contract are checked against the Worker at compile time.
`convex`, `jose`, `@clack/prompts`, `@napi-rs/keyring`, and pinned
`@oh-my-pi/pi-natives@18.8.3` are direct Worker dependencies. Native engine tests
run in Bun; auth/control/consumer tests run in Vitest. Install them with
`bun install --frozen-lockfile` from the repository root.

## Implemented and not implemented

- **Implemented:** P-256 key persistence, enrollment and recovery over the
  `/api/worker/auth/challenge` and `/api/worker/auth/complete` endpoints, short-lived
  machine-token refresh, current-Worker subscription, OS credential storage with
  explicit protected-file fallback, interactive lifecycle CLI, and locally scoped
  native edit sessions with authenticated task/result messaging.
- **Not implemented:** shell/eval execution, ACP, Chatroom model-tool dispatch,
  approval UI, durable chat outcomes, execution recovery, or OS sandboxing.
- **Known limitation:** deployed JWT verifier configuration, TLS/proxy routing,
  and recovery across separately deployed processes require deployment integration
  testing. See the [machine-authentication contract](../../docs/Worker/Machine_Authentication.md)
  and [Convex transport design](../../docs/Worker/Convex_Transport.md).
