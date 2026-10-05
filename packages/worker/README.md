# Radium Worker

The Worker package implements local machine identity setup and a narrowly scoped
authenticated Convex subscription. It does not execute commands, expose an agent
protocol, or receive deployment/admin credentials.

## Setup and run

Obtain a `radium-worker-v1.` setup code from the workspace's Worker settings. The
whole code is a one-time secret. Pass it on standard input or through a protected
file; it is never accepted as a command-line value or environment variable:

```bash
# The input file must be owned by the current user and mode 0600 (or stricter).
bun run --cwd packages/worker setup -- --setup-file /secure/path/worker-setup-code

# Or provide the code on stdin from a protected source.
bun run --cwd packages/worker setup < /secure/path/worker-setup-code

bun run --cwd packages/worker start
```

The setup command validates the Convex origins (HTTPS, or loopback HTTP for local
development), creates a P-256 key pair and stable request ID, and durably saves
them before contacting the backend. State defaults to `~/.radium-worker`; pass
`--state-dir PATH` to either command to select another location. The state
directory is secured to mode `0700`, and its state file is created atomically with
mode `0600`. Existing state is never replaced by a new key. The setup token is
kept in memory only for initial enrollment and is omitted from saved state.

Setup always attempts proof-bound recovery before enrollment. If a completion
response was lost, run `start` with the existing pending state to recover the
committed identity, even if the setup token has since expired. If recovery says
the enrollment was not completed, rerun `setup` with the still-valid original
setup code to retry with the same saved key and request ID. A pending state does
not contain the setup token, so it cannot start a new enrollment on its own.

`start` creates one `ConvexClient`, obtains short-lived machine JWTs through
challenge/proof exchanges, and subscribes to the `workers:current` query. It
reports only `connected` or `disconnected`; a null/revoked identity, auth failure,
query error, or Convex transport outage is disconnected. Failed token authentication
re-arms the same client's auth callback with jittered exponential backoff, with a
nominal delay increasing from 5 to 60 seconds; successful authentication resets the delay and shutdown
cancels pending retries. Repeated denial remains disconnected, including after owner
revocation. No privileged work is implemented in this package. The public `GET /health` endpoint returns only
`{"health":"ok"}` and listens on port `3001` by default; change it with
`bun run --cwd packages/worker start -- --port 3100`. Health reports process
liveness, not backend authentication state.

The setup code's `backendUrl` and `convexUrl` are treated as explicit origins and
are never rewritten. HTTP redirects are rejected, request timeouts are bounded,
and response bodies are size-limited. Setup codes, proofs, machine JWTs, private
keys, and response bodies are not logged.

## Development checks

```bash
bun run --cwd packages/worker test
bun run --cwd packages/worker typecheck
```

`convex` and `jose` are direct Worker dependencies. Install them with
`bun install --frozen-lockfile` from the repository root.

## Implemented and not implemented

- **Implemented:** P-256 key persistence, enrollment and recovery over the
  `/api/worker/auth/challenge` and `/api/worker/auth/complete` endpoints, short-lived
  machine-token refresh, current-Worker subscription, protected local state, and
  public liveness health.
- **Not implemented:** commands, ACP, execution, approvals, filesystem access,
  output persistence, sandboxing, or privileged control mutations.
- **Known limitation:** deployed JWT verifier configuration, TLS/proxy routing,
  and recovery across separately deployed processes require deployment integration
  testing. See the [machine-authentication contract](../../docs/Worker/Machine_Authentication.md)
  and [Convex transport design](../../docs/Worker/Convex_Transport.md).
