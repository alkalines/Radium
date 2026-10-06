# Radium Worker

The Worker package implements local machine identity setup and a narrowly scoped
authenticated Convex subscription. It does not execute commands, expose an agent
protocol, or receive deployment/admin credentials.

## Setup and run

Obtain a `radium-worker-v1.` setup code from **Chatroom → Workers** in the website.
The whole code is a one-time secret. Run setup in a terminal to paste it into a
masked `@clack/prompts` input, or use stdin/a protected file for automation.
It is never accepted as a command-line value or environment variable:

```bash
# Interactive setup (masked input)
bun run --cwd packages/worker setup

# The input file must be owned by the current user and mode 0600 (or stricter).
bun run --cwd packages/worker setup --setup-file /secure/path/worker-setup-code

# Or provide the code on stdin from a protected source.
bun run --cwd packages/worker setup < /secure/path/worker-setup-code

bun run --cwd packages/worker start
```

Run `bun run --cwd packages/worker cli` for an interactive command menu, or
`bun run --cwd packages/worker cli --help` for command/option help.

| Command                   | Purpose                                                                                                         |
| ------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `setup` / `add-token`     | Enroll with a one-time setup code; refuses to overwrite an identity.                                            |
| `start`                   | Run health and the authenticated control subscription.                                                          |
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
revocation. No privileged work is implemented in this package. The public `GET /health` endpoint returns only
`{"health":"ok"}` and listens on port `3001` by default; change it with
`bun run --cwd packages/worker start --port 3100`. Health reports process
liveness, not backend authentication state.

The setup code's `backendUrl` and `convexUrl` are treated as explicit origins and
are never rewritten. HTTP redirects are rejected, request timeouts are bounded,
and response bodies are size-limited. Setup codes, proofs, machine JWTs, private
keys, and response bodies are not logged.

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

```bash
# Watch/restart the enrolled Worker independently of Vite and Convex
bun run dev:worker

bun run --cwd packages/worker test
bun run --cwd packages/worker typecheck
```

`dev:worker` delegates to `bun run --cwd packages/worker dev` (`bun --watch`).
Enroll first, then run it alongside root `bun run dev`. Enrollment state lives
outside the watched source tree and survives process restarts. `--state-dir` and
`--port` can be passed to the package's `dev` script just as with `start`.

`convex`, `jose`, `@clack/prompts`, and `@napi-rs/keyring` are direct Worker dependencies. Install them with
`bun install --frozen-lockfile` from the repository root.

## Implemented and not implemented

- **Implemented:** P-256 key persistence, enrollment and recovery over the
  `/api/worker/auth/challenge` and `/api/worker/auth/complete` endpoints, short-lived
  machine-token refresh, current-Worker subscription, OS credential storage with
  explicit protected-file fallback, interactive lifecycle CLI, and
  public liveness health.
- **Not implemented:** agent job commands, ACP, execution, approvals, filesystem access,
  output persistence, sandboxing, or privileged control mutations.
- **Known limitation:** deployed JWT verifier configuration, TLS/proxy routing,
  and recovery across separately deployed processes require deployment integration
  testing. See the [machine-authentication contract](../../docs/Worker/Machine_Authentication.md)
  and [Convex transport design](../../docs/Worker/Convex_Transport.md).
