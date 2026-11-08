# E2EE Authentication

Status: **implemented except account migration** ([task 11 phase 4](../tasks/11_E2EE.md#phase-4-opaque-in-radium)); passkeys are a later phase. Part of [End-to-end encryption](../E2EE.md). Research behind these choices: [OPAQUE research](../research/OPAQUE_Authentication.md); open plugin findings: [plugin assessment](../research/OPAQUE_Plugin_Assessment.md). Keys derived here are used as described in [Keys](Keys.md).

## Why The Login Must Change

Today `createAuth` (`packages/backend/convex/auth.ts`) enables Better Auth email/password with only the `convex` plugin. The browser sends the password to the backend at sign-up and sign-in. Any key derived from that password is therefore derivable by the backend, so it cannot protect data from the backend.

Two ways out:

1. **A password-authenticated key exchange (PAKE)** so the password never reaches the server, and the client obtains a secret the server cannot compute. Proton does this with SRP-6a plus a bcrypt-derived key password ([Proton](https://proton.me/blog/encrypted-email-authentication)); OPAQUE does it with a standard client-only `export_key` ([RFC 9807 §6](https://www.rfc-editor.org/rfc/rfc9807.html)).
2. **A second "encryption password"** on top of the existing login. Simpler to build, worse to use, and the two passwords must never be equal.

Radium uses **OPAQUE with one password**:

- It is the only option with a standardized client-only key output (`export_key`). SRP has no equivalent; Proton derives its key password separately with bcrypt and a salt the server hands out before authentication.
- OPAQUE's server-side OPRF key acts as a secret salt, so stolen records cannot be attacked with precomputed tables, and the server never learns a public salt to precompute against ([RFC 9807 §10.8](https://www.rfc-editor.org/rfc/rfc9807.html#section-10.8)).
- `@serenity-kit/opaque` (Rust `opaque-ke` 4 in WASM, MIT) implements final RFC 9807 since 1.0.0, has a 2023 7ASecurity audit of its earlier code, and offers an RFC-recommended Argon2id stretching option since 1.1.0 ([changelog](https://github.com/serenity-kit/opaque/blob/main/CHANGELOG.md)).
- Convex's default runtime supports WebAssembly in every function type ([runtimes](https://docs.convex.dev/functions/runtimes#running-webassembly)), so the server side can run in the Better Auth routes Convex already hosts.

OPAQUE does not stop offline guessing by a server that keeps the records and its OPRF key ([RFC 9807 §10.11](https://www.rfc-editor.org/rfc/rfc9807.html#section-10.11)); the Argon2id cost and a password strength policy (minimum length plus a strength meter, enforced client-side because the server never sees the password) are the remaining defense.

## Better Auth Integration

### Upgrade first

Done in [task 11 phase 1](../tasks/11_E2EE.md#phase-1-better-auth-17): Radium runs `better-auth` 1.7.18 and `@convex-dev/better-auth` 0.13.0 as a [local install](https://labs.convex.dev/better-auth/features/local-install) (`packages/backend/convex/betterAuth/`), so plugins can add fields to the component schema.

### Plugin: `@alkalines/better-auth-opaque`

The only Better Auth OPAQUE plugin found, [`better-auth-opaque`](https://github.com/TheUntraceable/better-auth-opaque) 2.1.0 (MIT, a single GitHub maintainer, 33 stars), cannot be used as is ([research](../research/OPAQUE_Authentication.md#better-auth-opaque-plugin-discovery)):

- Its client **discards `exportKey`**, the one output E2EE needs.
- It depends on `@serenity-kit/opaque ^0.9.0`, which predates the RFC 9807 implementation, and its README tells users to generate setup with `@latest`; 1.0.0 changed the setup format, so that instruction can produce setup material the pinned 0.9 library does not accept **[INFERENCE]**.
- It has no reset or recovery flow, and its login state carries a 15-minute expiry; single-use consumption is not established by the source review.

Radium uses a new plugin owned by the alkalines organization, so other alkalines projects can use it too: repository `alkalines/better-auth-opaque`, npm package `@alkalines/better-auth-opaque` (server plugin and `opaqueClient()` client plugin in one package), MIT like the code it starts from, crediting the original. Radium pins an exact version. The plugin knows nothing about Radium's keys; it offers generic hooks that Radium fills in.

| Area            | Plugin behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Library         | `@serenity-kit/opaque` 1.1.0 pinned exactly by the plugin; Radium pins the plugin exactly (0.1.3). Client and server both use the `rfc-recommended` Argon2id profile, and the Radium client refuses any other profile a server advertises                                                                                                                                                                                                                                                   |
| Export key      | Returned to the client-side caller of sign-up, sign-in, password change and reset; never sent to the server                                                                                                                                                                                                                                                                                                                                                                                 |
| Account payload | Sign-up, password change and reset accept an opaque `payload` (Radium: the key bundle). Convex has no multi-write transactions, so the plugin orders writes instead: `commitPayload` stores the payload under the new credential version, a compare-and-set switches the account to it, then `activatePayload` drops only the replaced version ([plugin security notes](https://github.com/alkalines/better-auth-opaque/blob/main/docs/security.md#write-ordering-instead-of-transactions)) |
| Reset tokens    | Server-only `createPasswordResetToken({ email })` (not HTTP-reachable) returning a one-use URL, and `/reset/opaque/*` endpoints that consume it; delivery is the app's job ([Forgot password](#forgot-password))                                                                                                                                                                                                                                                                            |
| Login state     | Single use: a state row in Better Auth `verification`, consumed atomically (`consumeVerificationValue`) by the finish step, 5-minute expiry                                                                                                                                                                                                                                                                                                                                                 |
| Unknown users   | Login start answers from serenity's built-in fake record (`registrationRecord: null`) under an HMAC-derived identifier, with the same response shape as a real account                                                                                                                                                                                                                                                                                                                      |
| Server setup    | Passed in by the app (Radium: the `OPAQUE_SERVER_SETUP` deployment variable); missing or invalid setup fails closed                                                                                                                                                                                                                                                                                                                                                                         |
| Runtime         | The plugin's own code uses Web APIs only; serenity compiles its inlined WASM at runtime. Tested by the plugin in the Convex default runtime (local backend) and Node                                                                                                                                                                                                                                                                                                                        |
| Storage         | `registrationRecord`, `opaqueCredentialVersion` and `opaqueKeyStretching` on the Better Auth `account` row (`providerId: "opaque"`, `accountId` = a random credential ID, not the email); requires the Better Auth local install, done in phase 1                                                                                                                                                                                                                                           |

Open findings against 0.1.3 and the plugin capabilities Radium still needs are tracked in [the plugin assessment](../research/OPAQUE_Plugin_Assessment.md).

Radium's side lives in `packages/backend/src/e2ee/` (hooks, key-bundle validation, device recovery) with registrations in `convex/e2ee.ts` and the reset-link action in `convex/auth.ts`, and in `apps/web/src/lib/auth/` and `apps/web/src/lib/crypto/` (flows calling the client plugin and the key manager).

`OPAQUE_SERVER_SETUP` joins `SITE_URL` and `SECRET_STORE_KEYS` as a required backend value in [deployment](../deployment.md) once implemented. It must be backed up with the database: losing it invalidates every OPAQUE record, which forces every user through reset, which without recovery keys loses their personal data.

Classic email/password stays registered only until the account migration below ends, then is disabled.

## Flows

### Sign-up

```mermaid
sequenceDiagram
    participant C as Browser
    participant S as Better Auth (Convex)
    C->>C: startRegistration(password)
    C->>S: POST /sign-up/opaque/challenge {email, registrationRequest}
    S-->>C: registrationResponse
    C->>C: finishRegistration → registrationRecord, exportKey
    C->>C: create AMK, identity keys, recovery key; wrap AMK under HKDF(exportKey) and recovery KEK
    C->>C: show recovery key, require confirmation
    C->>S: POST /sign-up/opaque/complete {registrationRecord, keyBundle}
    S->>S: user, then key bundle (pending), then account; then activate
    S-->>C: session
```

The key bundle contains public identity keys, private identity keys encrypted under the AMK, and the AMK wrappers. It is opaque to the server, which only checks its shape and exact sizes. Sign-up fails as a whole if any part is missing, so no account exists without keys: the plugin creates the user, Radium stores the bundle under the new credential version, the plugin creates the OPAQUE account pointing at that version, then Radium activates it; if a step fails the plugin deletes the user it created.

The recovery key is shown before the account is committed and must be confirmed (re-entering four of the words). Skipping it is not offered.

### Sign-in

1. Client `startLogin(password)`; server answers from the stored record.
2. Client `finishLogin` yields `finishLoginRequest`, a session key and the `exportKey`. The export key is used only after the server's finish step succeeds ([RFC 9807 §10.4](https://www.rfc-editor.org/rfc/rfc9807.html#section-10.4)).
3. Server verifies, consumes the login state and creates the Better Auth session; Convex auth then works unchanged (`ConvexBetterAuthProvider`, JWT).
4. The sign-in response carries the key bundle for exactly the credential just used (`loadPayload`); the client derives the KEK with HKDF and unwraps the AMK, then keeps it according to the device's **Require my password to read past chats** setting ([Keys § On the device](Keys.md#on-the-device)). Before deriving anything, the client checks that the challenge's key-stretching profile is `rfc-recommended` and refuses otherwise, so a compromised server cannot make the client register or derive with a weaker or abusive profile.

Failed attempts go through Better Auth's rate limiter, enabled explicitly for OPAQUE paths (the plugin's 5 per minute on sign-in and reset).

### Unlock

On a device where **Require my password to read past chats** is on, opening past content after the keys were forgotten (last Tab closed, idle auto-lock, Lock) asks for the password and runs the normal sign-in above. The new Better Auth session replaces the current one; nothing else is special about it.

### Password change

Requires an unlocked session. The client runs an OPAQUE login with the old password (proving it), registers the new password, and wraps the **same** AMK under the new export key. The server stores the new wrapper under the new credential version, switches the account with a compare-and-set, drops the old wrapper and revokes the user's other sessions, which sign in again with the new password. No content is re-encrypted.

### Forgot password

Radium has no email transport today (`createAuth` has no reset-email callback even though the UI has forgot/reset screens). Until one is added, the **operator issues reset links from the Convex CLI**:

```sh
npx convex run auth:issuePasswordResetLink '{"email": "user@example.com"}'
```

1. `auth:issuePasswordResetLink` is an `internalAction`: browsers and API keys cannot call it; only someone with deployment access (CLI with a deploy key, or the dashboard) can. It is an action because generating the token needs real randomness.
2. It calls the plugin's `createPasswordResetToken`, which stores a hash of a 256-bit token in Better Auth `verification` with a one-hour expiry and returns `<SITE_URL>/auth/reset-password#token=…`. The token sits in the URL fragment, so browsers never send it to any server, log or `Referer`; the reset page removes it from the address bar. The URL is returned to the operator's terminal only; it is not logged or stored in plaintext.
3. The operator gives the link to the user by any channel. A future email transport (Better Auth `sendResetPassword`) replaces this step without changing the rest.
4. The user opens the link and picks how to get their **account master key** (AMK) back. The token lets the page fetch the user's encrypted key bundle; every part of it is useless without one of these:
   - **Recovery key.** The client derives the recovery KEK from the 24 words and unwraps the AMK.
   - **Another device where I'm still unlocked.** The resetting page generates a 128-bit secret and shows it as 12 words (and a QR code of them). The user types or scans it on the other device, which encrypts the AMK under `HKDF(secret, "radium/v1/device-recovery")` and uploads it to a single-use slot whose ID is also derived from the secret (`HKDF(secret, "radium/v1/device-recovery-id")`), expiring after 15 minutes; the resetting page downloads and decrypts it. The secret moves only between the user's two screens, so Convex never sees it and cannot substitute anything that decrypts under it.
   - **Neither.** The client creates a new AMK and identity keys. The UI states exactly what becomes unreadable and requires typing a confirmation.
5. The client registers the new password with OPAQUE and wraps the AMK under the new password KEK. `/reset/opaque/complete` consumes the reset state, stores the new key bundle version, switches the OPAQUE record with a compare-and-set and revokes all sessions.

A wrong recovery key or secret fails to decrypt on the client before anything is committed; the server stores nothing that verifies either.

#### What gets re-encrypted

**No content is ever re-encrypted by a reset**, and none needs to be. Content is encrypted to chat, workspace and identity keys, which sit below the AMK; a reset only changes the small wrappers above it.

| Path                         | What changes                                                                                              | Content                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Recovery key or other device | The OPAQUE record and one wrapper (AMK under the new password KEK): a few hundred bytes                   | All readable, untouched                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Neither                      | New AMK, new identity keys, new trust store; workspace keys must be granted again to the new identity key | **Personal** chats and notifications stay encrypted to the old keys, which no longer exist anywhere: unreadable, not re-encrypted (nothing can decrypt them to do so). **Workspace** chats are untouched: they are encrypted to the workspace member key, and any member or owner holding it grants it to the new identity key after approving the `changed` prompt. **Custodial** content (account not yet migrated) is released to the new keys by the backend ([Data § Custody key](Data.md#custody-key)). |

The personal content of the "Neither" path is kept, not deleted: if the user later finds the recovery key, a client can still unwrap the old AMK from the old recovery wrapper, which is retained for that purpose, and re-grant the old personal chat keys to the new identity key.

**What this means for a compromised backend.** Whoever controls the deployment can always issue a reset and take over an account's **login**; it is the auth server. What it cannot do is read anything: without the recovery key or one of the user's unlocked devices the reset produces new, empty keys, and every contact's client shows the account's key as `changed` before trusting it ([Keys § Trust system](Keys.md#trust-system)). This is the property E2EE adds over today, where the same access reads everything.

### Passkeys (later phase)

Better Auth's passkey plugin can sign users in. Passkey sign-in unlocks data only if the authenticator supports the WebAuthn **PRF** extension: the PRF output, through HKDF, wraps the AMK as one more wrapper. Browsers ship PRF (Chrome 116, Safari 18, Firefox 139), but authenticator support varies, so the client must check that a PRF result was actually returned ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Web_Authentication_API/WebAuthn_extensions#prf)). Without PRF the user is signed in but locked until they enter their password.

Social sign-in (OAuth) is not enabled today and cannot unlock data by itself for the same reason; if it is added, it is paired with a passkey PRF or password unlock.

## Migrating Existing Accounts

The backend has seen every existing user's password. Because it also holds the OPRF key, it could compute the OPAQUE export key for any password it has seen. **Migration therefore requires a new password**:

1. After the cutover deploy, a classic sign-in lands on a blocking "Set up encryption" screen.
2. The user enters a new password; the client rejects one equal to the password just typed.
3. The client performs OPAQUE registration and key setup as in sign-up, shows the recovery key, then calls a migration endpoint that stores the record and key bundle and deletes the classic `credential` account (and its password hash) in one transaction.
4. The server re-seals the user's data from custody to the new public keys ([Data § Migration](Data.md#migration)).

Nothing is deleted and there is no deadline. Content of accounts that have not migrated yet is sealed to a temporary, deployment-held **custody key** so the plaintext fields can be removed for everyone. A classic credential then only opens the "Set up encryption" screen; it gives no other access. Those accounts can also use [Forgot password](#forgot-password).

## UI

- `apps/web/src/components/auth/auth.tsx` and the forgot/reset views call the OPAQUE client methods instead of Better Auth UI's built-in email/password mutations; Better Auth UI's generic mutation hooks do not drive OPAQUE flows ([research](../research/OPAQUE_Authentication.md#better-auth-ui-integration)).
- Sign-in has a **Require my password to read past chats** checkbox, off by default and remembered per device ([Keys § On the device](Keys.md#on-the-device)).
- Settings → Security (`apps/web/src/app/settings/$path.tsx`): change password, regenerate recovery key, passkeys with PRF status, identity fingerprint and safety numbers, trusted keys with their state, the device's require-password setting and auto-lock time, workspace key phrase (owners), "Lock this device", and signed-in devices.
- A locked state for the Window: signed in, lists and new chats work, past content shows an "Unlock to read" prompt instead of errors.
- The reset page (`/auth/reset-password?token=…`) runs the recovery-key and new-keys paths above.

## Not Changed

- Worker machine authentication ([P-256 keys and machine JWTs](../Worker/Machine_Authentication.md)) and Gateway `rad-sk-` API keys. They authenticate machines and API clients, not users' encryption.
- Convex auth configuration and JWT verification.
- Workspace membership and authorization ([ownership](../Radium_Gateway/Ownership.md)).
