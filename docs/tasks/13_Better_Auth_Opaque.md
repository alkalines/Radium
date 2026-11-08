# 13 `@alkalines/better-auth-opaque`

Status: **not started.** Implements [task 11 phase 2](11_E2EE.md#phase-2-alkalinesbetter-auth-opaque) in the new repository `alkalines/better-auth-opaque`. Contract: [E2EE authentication](../E2EE/Authentication.md#plugin-alkalinesbetter-auth-opaque). Research: [OPAQUE](../research/OPAQUE_Authentication.md).

This file holds the prompts for the sessions that create that repository. Each prompt is self-contained: agents there cannot read Radium unless `/home/arthu/Projects/alkalines-radium` exists on the same machine.

## Sessions

| #   | Session                      | Runs in               | Model / effort                       | Depends on |
| --- | ---------------------------- | --------------------- | ------------------------------------ | ---------- |
| 1   | Human setup                  | GitHub, npm           | you                                  |            |
| 2   | `AGENTS.md`                  | new repo              | `anthropic/claude-sonnet-5-5` medium | 1          |
| 3   | Implementation lead + agents | new repo              | `anthropic/claude-opus-5-5` high     | 2          |
| 4   | First release                | new repo, then Radium | `anthropic/claude-sonnet-5-5` low    | 3          |

Session 3 owns scaffold, CI, code, tests and the example app through subagents (waves below), so no session ends with placeholder code. [Task 11 phase 1](11_E2EE.md#phase-1-better-auth-17) (Radium's Better Auth 1.7 upgrade) is not a prerequisite; the plugin targets 1.7 on its own.

## Facts Checked 2026-11-07

- `@serenity-kit/opaque` 1.1.0 (`index.d.ts`, `esm/index.js`): `server.startLogin` takes `registrationRecord: string | null | undefined`, so unknown users get a built-in fake response; this settles the **[INFERENCE]** in the plugin contract. `keyStretching` is a parameter of `client.finishRegistration` and `client.finishLogin`. `identifiers` are cryptographically bound into the record. The WASM is inlined as base64 and compiled at runtime with `WebAssembly.compile` (Node path via `Buffer`); runtimes that forbid compiling WASM from bytes (Cloudflare Workers; **[INFERENCE]** possibly other edge runtimes) are unverified.
- `better-auth` 1.7.18: `internalAdapter.consumeVerificationValue(identifier)` (atomic single use), adapter `consumeOne`, endpoint metadata `SERVER_ONLY`, `better-auth/adapters/memory`. `getTestInstance` exists under `dist/test-utils` but `./test-utils` is not in the package `exports`.
- `@convex-dev/better-auth` 0.13.0 adapter declares `transaction: false` and implements `consumeOne` natively. Under Convex, the user, account and app payload writes of one Better Auth endpoint are **separate mutations**; "one transaction" in the plugin contract cannot hold as written. Decision 2 below replaces it.
- npm trusted publishing (OIDC) needs npm ≥ 11.5.1 and Node ≥ 22.14; the package must already exist before a trusted publisher can be configured, so the first publish uses a token ([npm docs](https://docs.npmjs.com/trusted-publishers/)).

## Decisions In The Prompts

1. **Credential identifier.** The sign-up challenge mints a random `credentialId`, stored as `account.accountId` and used as the OPAQUE `userIdentifier`, so an email change does not invalidate the record. Unknown emails use `HMAC(secret, normalizedEmail)` with `registrationRecord: null`, so repeated probes get consistent fake responses. No client identifier binding (it would bind the record to the email).
2. **Atomicity without transactions.** Every flow passes `credentialVersion = base64url(SHA-256(registrationRecord))` to the app hooks. The app stores its payload keyed by that version next to older ones; the plugin writes the account record only after the payload commit succeeded, then calls `activatePayload` so the app can drop older versions. A crash at any point leaves either the old or the new credential with a matching payload. Adapters with `transaction: true` additionally run the plugin's own writes in one transaction. Radium's [authentication](../E2EE/Authentication.md) doc must be corrected to this when Radium adopts it (phase 4).
3. **Key stretching per account.** The stretching profile is stored on the account and returned by the sign-in challenge, so changing the default later does not lock out older accounts.
4. **Entry points.** `@alkalines/better-auth-opaque` (server plugin), `@alkalines/better-auth-opaque/client` (client plugin), and a `better-auth-opaque create-setup` binary built on the pinned Serenity version (the original plugin told users to run `@latest`).
5. **Publishing.** One tarball, built once per tag, published to npm (OIDC, provenance) and GitHub Packages, then attached to a GitHub release.
6. **CI cost.** Pull requests run one job (lint, typecheck, unit tests in Node and edge runtimes, build, package checks). The local Convex backend and Playwright Chromium run only on release tags, manual dispatch, or a PR labelled `full-ci`.

## 1. Human Setup

1. Create the public repository `alkalines/better-auth-opaque` (default branch `main`, MIT). Provenance needs a public repository.
2. Confirm the npm organization `alkalines` exists and you can publish to it.
3. Create the label `full-ci`, a GitHub environment `npm` (optionally with you as required reviewer), and a temporary repository secret `NPM_TOKEN` (granular, publish-only to `@alkalines/*`, short expiry) for the first release only.
4. Clone the repository next to Radium: `/home/arthu/Projects/alkalines-better-auth-opaque`.

## 2. Prompt: `AGENTS.md`

```text
Create AGENTS.md at the root of this new, empty repository (alkalines/better-auth-opaque). Write only that file; do not scaffold code, configs or CI.

Source of rules: read /home/arthu/Projects/alkalines-radium/AGENTS.md. Keep its rules and its voice (terse bullet rules, bold only for hazards, no hard-wrapped prose). Copy these Radium sections nearly verbatim, replacing Radium paths and names: "Code clarity and documentation" and the generic parts of "Verification" and "Deployment, generated files, and workflow". Drop everything about Chatroom, Gateway, Worker, workspaces, UI and motion.

What the repository is:
- `@alkalines/better-auth-opaque`: a Better Auth (1.7.x) plugin for OPAQUE password authentication (RFC 9807) built on `@serenity-kit/opaque` pinned exactly at 1.1.x. One package with a server plugin (`.`), a client plugin (`./client`) and a `better-auth-opaque` binary (`create-setup`). MIT; credit TheUntraceable/better-auth-opaque if any of its code is adapted.
- Generic and reusable by any alkalines project. Radium (github.com/alkalines/Radium) is the first consumer and pins exact versions; nothing here may reference Radium's keys, schema or flows. App-specific data travels through generic hooks.
- Bun is the package manager and script runner (`bun install`, `bun run <script>`); the published code must run in Node, Bun, browsers, and serverless runtimes (Convex default runtime required; edge runtimes only as verified).

Sections and rules the file must contain:

1. Package boundaries
- The password never reaches the server; the export key never leaves the client. Return the export key only after the server's finish step succeeded (RFC 9807 §10.4). Never substitute the session key for the export key.
- Web APIs only in published code: no `node:*` imports, no `Buffer`, no `fs`, no top-level await, no import-time side effects other than declaring exports. ESM only, `sideEffects: false`. The client entry must not import server code.
- Missing or invalid server setup fails closed. Never generate a setup implicitly at runtime.
- Login, sign-up and reset state is single use (Better Auth `verification` rows consumed with `consumeVerificationValue`), short-lived, and never sent to the client when it contains server secrets.
- Responses for unknown emails must be indistinguishable from wrong passwords (shape, status, error code; timing as far as reasonable).
- Server-only APIs (`createPasswordResetToken`) use Better Auth's `SERVER_ONLY` endpoint metadata and are never HTTP-reachable.
- Do not claim a runtime, adapter or browser is supported until a test in this repository runs there.

2. Commands and setup
- List the scripts by name with one line each: `lint`, `format` / `format:check` (oxlint, oxfmt), `typecheck`, `test` (Vitest: Node and edge-runtime projects), `test:convex` (real local Convex backend, `test/convex`), `test:e2e` (Playwright Chromium, `examples/tanstack-start`), `build` (tsdown), `check:package` (publint + Are The Types Wrong). Mark the scripts "added in the implementation session" instead of inventing flags.
- Workspaces: the root is the published package; `examples/*` and `test/convex` are private workspaces and never published.
- `OPAQUE_SERVER_SETUP` for examples and fixtures comes from `bun run create-setup`; never commit a real setup; `.env*` files are gitignored except `.env.example`.

3. Code ownership
- `src/contract.ts` owns endpoint request/response schemas, error codes and hook types, shared by server and client. `src/server/` owns endpoints, state and storage; `src/client/` owns the client plugin; `src/cli.ts` the binary.
- Use Better Auth primitives instead of copies: `createAuthEndpoint`, `sessionMiddleware`, `internalAdapter` (createUser/createAccount/createSession, verification values), `setSessionCookie`, plugin `schema`, `rateLimit`, `$ERROR_CODES`. Read the installed `better-auth` sources for signatures; do not guess.
- Dependencies: `@serenity-kit/opaque` exact pin; `better-auth` and `zod` as peer dependencies with tested ranges; no other runtime dependencies without recording why in the PR.

4. Code clarity and documentation (copied from Radium, adapted)
- `README.md` is the user guide (install, server/client setup, hooks, setup generation and backup, Convex local install, supported runtimes table with evidence). `docs/` holds design decisions and security notes only. `CHANGELOG.md` records every released change.

5. Security review triggers
- Any change to endpoint shapes, stored fields, state lifetime, identifiers, key stretching, enumeration behavior or error codes needs a test of the security property and a CHANGELOG entry flagged **security**.

6. Compatibility and releases
- Semver. Breaking: endpoint paths or bodies, stored fields, hook signatures, error codes, stretching defaults, supported peer ranges. Stored-data changes need a documented migration.
- `version` in package.json changes only in a release PR. CI publishes on `v*.*.*` tags to npm and GitHub Packages; never run `npm publish` locally after the first bootstrap release.

7. Verification (adapt Radium's)
- Unit tests use Better Auth with the memory adapter; they are not integration verification. Convex claims need `test:convex` against a real local backend; browser claims need `test:e2e`. Report which of unit, runtime, Convex and browser checks ran, and which were skipped and why.
- Tests check observable behavior and security boundaries (single use, enumeration, export key equality between registration and login, fail-closed setup), not mock call counts.

8. Workflow
- Task branches and PRs to `main`; no direct commits to `main`. Do not commit, push, open or merge PRs, tag, or publish without explicit authorization.

Acceptance: one AGENTS.md, under 90 lines, every rule above present, no Radium-only content, no rule claiming a script or runtime already works.
```

## 3. Prompt: Implementation Lead

````text
You are the lead for building `@alkalines/better-auth-opaque` in this repository. Read AGENTS.md first; it is binding for you and every subagent. You own the plan, the shared contract and final integration. Use subagents only as organized below, each with an explicit model and effort, and pass every subagent the "Spec" section of this prompt verbatim plus its own task. Do not commit, push, tag or publish.

# Spec

Versions: better-auth 1.7.x (peer `>=1.7.16 <1.8.0`, matching @convex-dev/better-auth 0.13), @serenity-kit/opaque 1.1.0 exact, zod 4 peer, TypeScript 7, tsdown for build (ESM + .d.ts; prefer isolated declarations so no tsc API is needed), Vitest, oxlint/oxfmt, Bun as package manager.

Known facts (verified 2026-11-07, re-check in installed sources before relying on them):
- serenity `server.startLogin({ serverSetup, userIdentifier, registrationRecord: null, startLoginRequest })` returns a fake response for unknown users. `keyStretching` is passed to `client.finishRegistration` and `client.finishLogin`. Call and await `ready` before any function.
- serenity compiles its inlined WASM with `WebAssembly.compile` at runtime.
- better-auth 1.7: `ctx.context.internalAdapter.consumeVerificationValue(identifier)`; endpoint metadata `{ SERVER_ONLY: true }`; `better-auth/adapters/memory`.
- @convex-dev/better-auth 0.13 adapter has `transaction: false` and native `consumeOne`.

Server plugin `opaque(options)` (id `opaque`):
- `serverSetup: string` required; constructing without it throws. Validate with `server.getPublicKey` on first use and expose `auth.api.validateOpaqueSetup()` (SERVER_ONLY) for boot checks; invalid setup fails every flow with a stable error code.
- `keyStretching`: serenity profile, default `"rfc-recommended"`; stored per account (`opaqueKeyStretching`) and returned by the sign-in challenge, so a later default change keeps old accounts working.
- `hooks` (all optional except where noted; each receives the endpoint ctx and `flow`):
  - `validatePayload({ payload, flow, userId? })`: reject before anything is written.
  - `commitPayload({ userId, credentialVersion, payload, flow })`: store the app payload keyed by `credentialVersion` without replacing other versions. Required when the client sends a payload.
  - `activatePayload({ userId, credentialVersion, flow })`: called after the account record points to that version; the app may delete older versions.
  - `loadPayload({ userId, flow })`: returned to the client by sign-in complete and reset verify, so one round trip yields record-matched app data.
- `passwordReset: { expiresIn = 3600, url(token): string }`.
- Schema: account fields `registrationRecord` (string, not returned), `opaqueCredentialVersion`, `opaqueKeyStretching`. Accounts use `providerId: "opaque"`, `accountId = credentialId`.
- Rate limits on every challenge and complete path, stricter on sign-in and reset.

Identifiers and enumeration:
- Sign-up challenge mints a random 256-bit `credentialId`, stores `{ email, credentialId }` in a verification row (stateId, 5 minutes), and uses `credentialId` as `userIdentifier`.
- Sign-in challenge: email → user → opaque account → `accountId`. Unknown email or no opaque account: `userIdentifier = HMAC-SHA-256(betterAuthSecret, "opaque/fake/" + normalizedEmail)` and `registrationRecord: null`. Response shape identical in both cases; the stored server login state is a verification row the client only references by stateId.
- No client identifier binding. Optional `serverIdentifier` option, default unset, documented as breaking all records if changed.
- Sign-up for an existing email: behave like Better Auth email/password sign-up in the same configuration; document the residual enumeration exactly.

Ordering (decision: no reliance on multi-write transactions):
- Sign-up complete: consume state → validatePayload → createUser (internalAdapter, so database hooks run) → commitPayload → createAccount → activatePayload → session. On failure after createUser, delete what the plugin created (compensation) and rethrow. When the adapter supports transactions, wrap the plugin's own writes in one.
- Password change (session required, fresh proof): client runs an OPAQUE login for the current password and a new registration; complete verifies the login, then validatePayload → commitPayload(new version) → update account record/version → activatePayload → revoke the user's other sessions.
- Reset: `auth.api.createPasswordResetToken({ email })` (SERVER_ONLY) stores SHA-256 of a 256-bit token, returns `{ url, expiresAt }` or a stable not-found error. `/reset/opaque/verify` (no consume) returns `loadPayload` output; `/reset/opaque/challenge` and `/reset/opaque/complete` consume the token, then the same ordering as password change, then revoke all sessions.
- Required acceptance: for an injected failure at each step, the user can still sign in with either the old or the new password and receives the payload matching that credential; a sign-up never attaches to a user that has any other account.

Endpoints (POST, under the Better Auth base path; bodies are zod schemas in src/contract.ts):
- `/sign-up/opaque/challenge`, `/sign-up/opaque/complete`
- `/sign-in/opaque/challenge`, `/sign-in/opaque/complete`
- `/opaque/change-password/challenge`, `/opaque/change-password/complete`
- `/reset/opaque/verify`, `/reset/opaque/challenge`, `/reset/opaque/complete`

Client plugin `opaqueClient({ keyStretching? })` from `./client`:
- `authClient.signUp.opaque({ email, password, name, payload?, ...additionalFields })`, `authClient.signIn.opaque({ email, password })`, `authClient.opaque.changePassword({ currentPassword, newPassword, payload? })`, `authClient.opaque.resetPassword({ token, newPassword, payload? })`, `authClient.opaque.verifyResetToken({ token })`.
- Results use Better Auth's `{ data, error }` shape and accept `fetchOptions`. `data.exportKey` (base64url) appears only after the complete call succeeded; sign-in and reset verify also return `payload`. Payload builders that need the export key before the complete call (sign-up, change, reset) receive it through a `payload: (exportKey) => Promise<unknown>` callback, never through the network.
- `$InferServerPlugin` typing, `$ERROR_CODES`, session atom refresh after sign-in/sign-up/change.

CLI: `better-auth-opaque create-setup` prints a new setup from the pinned serenity version plus a backup warning.

# Waves

Wave 0 (you, inline, before spawning): package.json (name, exports `.`/`./client`, bin, files, peerDependencies, `packageManager: bun@<current>`, `repository` pointing at github.com/alkalines/better-auth-opaque, `publishConfig.access: public` and no `publishConfig.registry`), tsconfig, tsdown, Vitest projects (`node`, `edge` via @edge-runtime/vm), oxlint/oxfmt, workspaces `examples/*` and `test/convex`, `.gitignore`, LICENSE, and the complete src/contract.ts. Run `bun install` once.

Wave 1 (parallel, one batch):
- Core — anthropic/claude-opus-5-5, high. Owns src/server/, src/client/, src/cli.ts and test/unit/. Implements the Spec. Tests with the memory adapter through real HTTP requests (auth.handler) and the real client plugin: registration/login export keys equal; wrong password and unknown email indistinguishable; state replay rejected; expired state rejected; fail-closed setup; payload ordering under injected failures; password change revokes other sessions and old password stops working; reset token single use and expiry; SERVER_ONLY endpoint unreachable over HTTP; keyStretching per account survives a default change. The `edge` Vitest project must run the same flows; if serenity WASM cannot load there, report it, mark the project skipped with the reason, do not shim.
- CI — anthropic/claude-sonnet-5-5, medium. Owns .github/ only. Writes the three workflows below verbatim except for action major versions (use current majors) and validates with actionlint. Adds .github/dependabot.yml for github-actions (monthly, grouped).
- Example — anthropic/claude-sonnet-5-5, medium. Owns examples/tanstack-start/ (private). TanStack Start + Prisma (current stable release supported by Better Auth's Prisma adapter) + SQLite, Better Auth with this plugin via workspace dependency, pages: sign-up (with a demo payload: an AES-GCM key wrapped under HKDF(exportKey)), sign-in (shows that the demo payload unwraps), change password, reset (token from a server-only dev route guarded to localhost), sign-out. Minimal, unstyled forms. `bun run --cwd examples/tanstack-start dev` works from a fresh clone after `bun run create-setup` and the README's env step.

Wave 2 (parallel, after Core lands and you integrated it):
- Convex — anthropic/claude-sonnet-5-5, high. Owns test/convex/. Minimal Convex app using @convex-dev/better-auth 0.13 local install with this plugin; `test:convex` starts an anonymous local backend non-interactively (verify the exact Convex CLI flags/env from its docs; CI has no login), deploys, runs the sign-up/sign-in/reset/change flows over HTTP plus a concurrency test that two parallel completes of one state succeed at most once, and stops the backend. Record the bundle size and cold-start time of the auth HTTP action.
- E2E — anthropic/claude-sonnet-5-5, medium. Owns examples/tanstack-start/e2e/. Playwright, Chromium only. Flows: sign-up → sign-out → sign-in unwraps payload; wrong password and unknown email show the same error; change password keeps payload readable; reset link works once. Capture every request body and assert the password string never appears.

Wave 3: Review — security-reviewer, openai-codex/gpt-6.1-sol, high. Read-only review of src/ against the Spec and RFC 9807 §10 (export key handling, state binding, replay, enumeration, timing, identifier handling, error leakage, rate limits). You fix the findings, rerun the affected checks.

Finish: README (user guide per AGENTS.md, supported runtimes table only with tested rows), CHANGELOG `0.1.0` entry, docs/security.md (threat model, residual leakage, setup backup). Version stays `0.1.0` unreleased. Report: what each check ran on, skipped checks with reasons, open questions.

# Workflows (CI subagent writes these)

.github/workflows/ci.yml
```yaml
name: CI

on:
  pull_request:
  push:
    branches: [main]

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

permissions:
  contents: read

jobs:
  check:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v6
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version-file: package.json
      - uses: actions/cache@v4
        with:
          path: ~/.bun/install/cache
          key: bun-${{ runner.os }}-${{ hashFiles('bun.lock') }}
          restore-keys: bun-${{ runner.os }}-
      - run: bun install --frozen-lockfile
      - run: bun run lint
      - run: bun run format:check
      - run: bun run typecheck
      - run: bun run test
      - run: bun run build
      - run: bun run check:package
```

.github/workflows/full.yml
```yaml
name: Full

on:
  pull_request:
    types: [labeled, synchronize, reopened]
  workflow_dispatch:
  workflow_call:

concurrency:
  group: full-${{ github.ref }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}

permissions:
  contents: read

jobs:
  convex:
    if: >-
      github.event_name != 'pull_request' ||
      (github.event.action == 'labeled' && github.event.label.name == 'full-ci') ||
      (github.event.action != 'labeled' && contains(github.event.pull_request.labels.*.name, 'full-ci'))
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v6
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version-file: package.json
      - uses: actions/cache@v4
        with:
          path: ~/.bun/install/cache
          key: bun-${{ runner.os }}-${{ hashFiles('bun.lock') }}
          restore-keys: bun-${{ runner.os }}-
      - run: bun install --frozen-lockfile
      - run: bun run build
      - run: bun run test:convex

  e2e:
    if: >-
      github.event_name != 'pull_request' ||
      (github.event.action == 'labeled' && github.event.label.name == 'full-ci') ||
      (github.event.action != 'labeled' && contains(github.event.pull_request.labels.*.name, 'full-ci'))
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v6
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version-file: package.json
      - uses: actions/cache@v4
        with:
          path: ~/.bun/install/cache
          key: bun-${{ runner.os }}-${{ hashFiles('bun.lock') }}
          restore-keys: bun-${{ runner.os }}-
      - run: bun install --frozen-lockfile
      - uses: actions/cache@v4
        with:
          path: ~/.cache/ms-playwright
          key: playwright-${{ runner.os }}-${{ hashFiles('bun.lock') }}
      - run: bunx playwright install --with-deps chromium
        working-directory: examples/tanstack-start
      - run: bun run build
      - run: bun run test:e2e
```

.github/workflows/release.yml
```yaml
name: Release

on:
  push:
    tags: ["v*.*.*"]

concurrency:
  group: release
  cancel-in-progress: false

permissions:
  contents: read

jobs:
  full:
    uses: ./.github/workflows/full.yml

  pack:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    outputs:
      dist-tag: ${{ steps.meta.outputs.dist-tag }}
    steps:
      - uses: actions/checkout@v6
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version-file: package.json
      - run: bun install --frozen-lockfile
      - id: meta
        run: |
          VERSION="${GITHUB_REF_NAME#v}"
          PACKAGE_VERSION=$(node -p "require('./package.json').version")
          if [ "$VERSION" != "$PACKAGE_VERSION" ]; then
            echo "Tag $GITHUB_REF_NAME does not match package.json version $PACKAGE_VERSION" >&2
            exit 1
          fi
          case "$VERSION" in
            *-*) echo "dist-tag=next" >> "$GITHUB_OUTPUT" ;;
            *) echo "dist-tag=latest" >> "$GITHUB_OUTPUT" ;;
          esac
      - run: bun run typecheck
      - run: bun run test
      - run: bun run build
      - run: bun run check:package
      - run: npm pack --pack-destination pack
      - uses: actions/upload-artifact@v4
        with:
          name: package
          path: pack/*.tgz
          if-no-files-found: error

  publish-npm:
    needs: [full, pack]
    runs-on: ubuntu-latest
    timeout-minutes: 5
    environment: npm
    permissions:
      contents: read
      id-token: write
    steps:
      - uses: actions/download-artifact@v4
        with:
          name: package
      - uses: actions/setup-node@v6
        with:
          node-version: 24
          registry-url: https://registry.npmjs.org
      - run: npm publish ./*.tgz --access public --provenance --tag "${{ needs.pack.outputs.dist-tag }}"
        env:
          # Bootstrap only: delete the NPM_TOKEN secret once npm trusted publishing is configured.
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}

  publish-github:
    needs: [full, pack]
    runs-on: ubuntu-latest
    timeout-minutes: 5
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/download-artifact@v4
        with:
          name: package
      - uses: actions/setup-node@v6
        with:
          node-version: 24
          registry-url: https://npm.pkg.github.com
          scope: "@alkalines"
      - run: npm publish ./*.tgz --tag "${{ needs.pack.outputs.dist-tag }}"
        env:
          NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}

  github-release:
    needs: [pack, publish-npm, publish-github]
    runs-on: ubuntu-latest
    timeout-minutes: 5
    permissions:
      contents: write
    steps:
      - uses: actions/download-artifact@v4
        with:
          name: package
      - env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          DIST_TAG: ${{ needs.pack.outputs.dist-tag }}
        run: |
          PRERELEASE=""
          if [ "$DIST_TAG" = "next" ]; then PRERELEASE="--prerelease"; fi
          gh release create "$GITHUB_REF_NAME" ./*.tgz --repo "$GITHUB_REPOSITORY" \
            --title "$GITHUB_REF_NAME" --generate-notes --verify-tag $PRERELEASE
```

If a publish job fails after the other succeeded, re-run only the failed job; re-running a successful publish fails on the existing version.
````

## 4. Prompt: First Release

```text
Release `@alkalines/better-auth-opaque` 0.1.0. Read AGENTS.md. I authorize: opening the release PR, merging it after CI passes, and pushing the tag `v0.1.0`. Nothing else.

1. Release PR: CHANGELOG date for 0.1.0, version `0.1.0` in package.json. Run `bun run typecheck && bun run test && bun run build && bun run check:package` and `npm pack --dry-run`; the tarball contains only dist/, README, LICENSE, CHANGELOG, package.json. Label the PR `full-ci` and wait for CI and Full.
2. After merge, tag `v0.1.0` on the merge commit and push the tag. The Release workflow publishes with the temporary NPM_TOKEN.
3. Verify: `npm view @alkalines/better-auth-opaque@0.1.0` shows provenance and the expected `dist.integrity`; the GitHub Packages version exists (`gh api /orgs/alkalines/packages/npm/better-auth-opaque/versions`); the GitHub release has the tarball; the integrity of the npm tarball and the GitHub release asset match.
4. Tell me to: configure npm trusted publishing (repository alkalines/better-auth-opaque, workflow release.yml, environment npm) within two days of creating it, delete the NPM_TOKEN secret, and set the package to disallow token publishing. Do not do these yourself.
5. Report the exact published integrity hash; Radium pins exactly that version in task 11 phase 4.
```
