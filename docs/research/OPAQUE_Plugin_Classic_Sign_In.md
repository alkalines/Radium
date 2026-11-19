# `@alkalines/better-auth-opaque` — Classic-Account Signal at Sign-In

Change request for the plugin, from Radium (2026-11-10). Plugin source: `/home/arthu/Projects/alkalines-better-auth-opaque`, 0.2.0. Consumer: Radium E2EE ([Authentication § Migrating Existing Accounts](../E2EE/Authentication.md#migrating-existing-accounts)).

**Current status:** the consumed, pinned 0.2.0 package implements the classic-credential signal and Radium enables it. The original 2026-11-11 “unreleased/local branch” note was stale. The sections below retain the design request and rationale; they are not instructions to depend on an unpublished build. The deployed account-enrolment release path remains a separate migration verification boundary.

## Problem

Radium's sign-in form should notice an account created before encryption and move the user to "Set up encryption" on its own, without a separate "Legacy account" form. The client cannot do that today:

- `POST /sign-in/opaque/challenge` answers a user that has only a classic `credential` account exactly like an unknown email: a fake login keyed by `HMAC(secret, "opaque/fake/<email>")` (`src/server/sign-in.ts:63-98`). The client then fails locally with `INVALID_CREDENTIALS` and never calls `complete` (`src/client/index.ts:442-444`). `src/contract.ts:47-49` documents this single failure code as deliberate.
- The only client-side alternative is to retry every `INVALID_CREDENTIALS` with Better Auth's `/sign-in/email`. That sends the plaintext password to the server after **every** failed OPAQUE sign-in: typos of encrypted users, and, worse, the real password whenever a compromised backend chooses to answer `INVALID_CREDENTIALS`. With the password the backend derives the export key and opens the account's keys. Radium's threat model ([E2EE § Threat Model](../E2EE.md#threat-model)) treats the backend as possibly compromised, so this is not acceptable.

The server already loads the user's accounts on this path (one `findAccounts` call after `findUserByEmail`), so it knows the answer without another query.

## Requested change

### Server

New opt-in option, default off (name is a proposal):

```ts
opaque({
  signIn: { revealClassicCredential: true },
});
```

When on, `POST /sign-in/opaque/challenge` answers **`409 CLASSIC_CREDENTIAL`** instead of a fake login when all of these hold:

1. the user exists;
2. it has no `opaque` account row (`readCredential(...) === null`);
3. it has a `credential` account (`CLASSIC_PROVIDER_ID`) with a non-empty `password`.

Requirements:

- **After the per-account rate limit**, as now (`checkAccountRateLimit` stays the first step), so the signal costs an attacker the same budget as a password guess.
- **No extra query**: decide from the `accounts` already loaded at `src/server/sign-in.ts:72-74`. The early return skips `startLogin`/`createState`; the latency difference reveals only what the code itself reveals.
- **No state is created** and nothing about the password is processed: the challenge request carries only the blinded `startLoginRequest`.
- A user with **both** an OPAQUE and a classic row (an interrupted `removeClassicCredential`) keeps the normal OPAQUE path.
- With the option off, behaviour is byte-for-byte today's (fake login, `INVALID_CREDENTIALS`).
- Add `CLASSIC_CREDENTIAL` to `OPAQUE_ERROR_CODES` (`src/contract.ts`) with a neutral message, e.g. "This account uses a classic password. Sign in with it, then attach an OPAQUE password." Update the comment at `src/contract.ts:47-49` and the `INVALID_CREDENTIALS` doc ("emails without an OPAQUE account" no longer covers classic users when the option is on).
- Validate the option at construction like the others (`src/server/runtime.ts` options schema).

### Client

- The challenge error already passes through (`if (challenge.error) return challenge;`), so `signIn.opaque` returns `{ error: { code: "CLASSIC_CREDENTIAL", status: 409 } }` without code changes. Add the code to the client's error-code types and the client docs (`src/client/index.ts:403-407`).
- Do **not** add an automatic classic fallback inside the plugin client: the decision to send a plaintext password must stay with the app (see Security below).

### Documentation (README "Migrating classic passwords", `docs/security.md`)

State plainly:

1. **Enumeration.** The option reveals, to anyone who can call the challenge, that an email belongs to a classic (not yet migrated) account. Rate limits bound it but do not remove it. For consumers that hide existing emails at sign-up (`hidesExistingEmails`: `requireEmailVerification` or `autoSignIn: false`), the option also reveals that the account **exists**; recommend leaving it off there, or warn at construction when both are set.
2. **Compromised server.** A backend can answer `CLASSIC_CREDENTIAL` for an account that already has an OPAQUE credential to make the client send the plaintext password to `/sign-in/email`. The signal is a hint, not proof. Consumers that protect data with the export key must refuse the classic path for accounts the device has already used with OPAQUE (Radium keeps a per-device marker; see below), and should switch the option off once no classic accounts remain.

## Tests to add (plugin suite)

| Case                                                            | Expected                                                                                   |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Option on, classic-only user                                    | `409 CLASSIC_CREDENTIAL`; no `sign-in` state row created; account rate limit consumed once |
| Option on, unknown email                                        | Today's fake challenge (200), then `INVALID_CREDENTIALS`                                   |
| Option on, OPAQUE user (with or without a leftover classic row) | Normal sign-in succeeds                                                                    |
| Option on, classic row without `password` (social-only user)    | Fake challenge, `INVALID_CREDENTIALS`                                                      |
| Option off, classic-only user                                   | Fake challenge, `INVALID_CREDENTIALS` (regression guard)                                   |
| Option on, account rate limit refuses                           | `429 TOO_MANY_ATTEMPTS` before any lookup (no `CLASSIC_CREDENTIAL`)                        |
| Option on, cross-site `Origin`                                  | 403 from `formCsrfMiddleware`, as today                                                    |
| Invalid option value                                            | Construction throws                                                                        |

## Radium adoption

The web client handles the code in `apps/web/src/lib/auth/opaque-account.ts`, and the backend enables it in `convex/auth.ts`. Both consumers pin 0.2.0; no pending dependency bump or local override is required.

Deployment acceptance: in Chromium, a classic account should sign in from the normal form and reach setup without retyping the password; an encrypted account's wrong password must still show “Invalid email or password” with no `/sign-in/email` fallback.
Switch the option off only once no classic `credential` rows remain, not merely because content sealing completed ([task 11 phase 9](../tasks/11_E2EE.md#phase-9-migration)).

The installed pinned 0.2.0 supports `signIn.revealClassicCredential`; a local plugin override is not required. Operators may also issue enrolment links with `auth:issuePasswordResetLink` to classic users. Do not downgrade an OPAQUE account merely because a challenge returns `INVALID_CREDENTIALS`.
