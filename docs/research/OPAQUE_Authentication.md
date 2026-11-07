# OPAQUE And Zero-Knowledge Authentication Research

Snapshot: 2026-11-05. Research only; the adopted design is in [E2EE authentication](../E2EE/Authentication.md) and [key hierarchy](../E2EE/Keys.md).

## Recommendation

[INFERENCE] Prefer OPAQUE over a new SRP integration for Radium's single-password design, but do not adopt `better-auth-opaque` unchanged. The published plugin has three independently verified blockers: its latest release excludes Radium's current Better Auth version, it depends on a pre-final-RFC Serenity implementation, and it discards the client-only export key needed for E2EE key wrapping. Sources: [published package metadata](https://registry.npmjs.org/better-auth-opaque), [published client implementation](https://unpkg.com/better-auth-opaque@2.1.0/dist/client.js), and [Serenity changelog](https://github.com/serenity-kit/opaque/blob/main/CHANGELOG.md).

[INFERENCE] A narrow, security-reviewed Better Auth integration around a pinned RFC-9807-capable Serenity release can retain Better Auth sessions and the Convex integration while exposing the authenticated client export key to a client key manager. The intended envelope-encryption shape is:

```text
OPAQUE client exportKey
    -> domain-separated HKDF
    -> key-encryption key
    -> wraps random account master key
    -> wraps project/session/data keys
```

[INFERENCE] Do not encrypt all data directly with `exportKey`. A random master key separates password changes, recovery-factor changes and data-key rotation. Ente, Bitwarden and WhatsApp provide relevant envelope-encryption precedents, although their exact algorithms and trust boundaries differ; see [prior art](#prior-art).

[INFERENCE] Retaining existing authentication and adding an independent encryption password or PRF-capable passkey is an alternative, not an equivalent implementation of single-password OPAQUE authentication. With conventional Better Auth email/password authentication, deriving E2EE keys from that same password would expose the derivation input to the server.

The browser client remains a trust boundary. Neither OPAQUE nor SRP prevents modified client JavaScript from capturing passwords or unlocked keys. An untrusted-storage/backend threat model is different from an untrusted-client-distribution threat model; [tssrp6a explicitly documents the browser-code-injection limitation](https://github.com/midonet/tssrp6a#recommendations).

## Better Auth OPAQUE Plugin Discovery

Searches for `better-auth opaque`, `@serenity-kit/opaque better-auth`, and `better-auth-opaque` found one identifiable Better Auth OPAQUE authentication plugin: [`better-auth-opaque`](https://www.npmjs.com/package/better-auth-opaque). No second independently maintained plugin was found; this is a search result, not proof that none exists. Better Auth warns that [community plugins are neither official nor verified](https://better-auth.com/docs/plugins/community-plugins).

| Field                      | Verified snapshot                                                                           |
| -------------------------- | ------------------------------------------------------------------------------------------- |
| Package                    | `better-auth-opaque`                                                                        |
| Repository                 | [`TheUntraceable/better-auth-opaque`](https://github.com/TheUntraceable/better-auth-opaque) |
| Maintainer                 | GitHub `TheUntraceable`; npm maintainers `theuntraceable` and `the-untraceable`             |
| Latest published release   | `2.1.0`, 2026-10-30 at 22:55:42 UTC                                                         |
| Previous published release | `2.0.3`, 2025-10-25                                                                         |
| License                    | MIT                                                                                         |
| GitHub activity            | 33 stars, 1 fork, 5 open issues/PRs; last push 2026-10-31                                   |
| Latest peer dependencies   | `better-auth ^1.7.0`, `zod ^4`, `typescript >=5`                                            |
| Crypto dependency          | `@serenity-kit/opaque ^0.9.0`                                                               |

Release/dependency/maintainer evidence comes from the [npm registry](https://registry.npmjs.org/better-auth-opaque); repository activity/license evidence comes from the [GitHub repository API](https://api.github.com/repos/TheUntraceable/better-auth-opaque). Activity counts are a dated snapshot, not a security assessment.

### Source Versus README Evidence

The research inspected published `2.1.0` [`dist/client.js`](https://unpkg.com/better-auth-opaque@2.1.0/dist/client.js), [`dist/server.js`](https://unpkg.com/better-auth-opaque@2.1.0/dist/server.js), and [`dist/utils.js`](https://unpkg.com/better-auth-opaque@2.1.0/dist/utils.js), plus repository TypeScript at commit `b289dccfeae759cece35e93101519b249ed74e7f`: [`src/client.ts`](https://github.com/TheUntraceable/better-auth-opaque/blob/b289dccfeae759cece35e93101519b249ed74e7f/src/client.ts), [`src/server.ts`](https://github.com/TheUntraceable/better-auth-opaque/blob/b289dccfeae759cece35e93101519b249ed74e7f/src/server.ts), and [`src/utils.ts`](https://github.com/TheUntraceable/better-auth-opaque/blob/b289dccfeae759cece35e93101519b249ed74e7f/src/utils.ts).

The [README at that commit](https://github.com/TheUntraceable/better-auth-opaque/blob/b289dccfeae759cece35e93101519b249ed74e7f/README.md) promises zero-knowledge password authentication, enumeration protection and seamless integration. API behavior, missing export-key exposure, persistent state and password-change behavior below were verified from implementation, not accepted solely from README claims. The README's broad offline-cracking claim must be qualified by the RFC's full-server-compromise discussion.

### API And Registration/Login Flows

The server factory is `opaque({ OPAQUE_SERVER_KEY, insecureCreateSessionOnRegister? })`. The client plugin is `opaqueClient()`, exposing `authClient.signUp.opaque({ email, name, password })`, `authClient.signIn.opaque({ email, password })`, and `authClient.changePassword({ currentPassword, newPassword })`. Source: [published client](https://unpkg.com/better-auth-opaque@2.1.0/dist/client.js) and [server](https://unpkg.com/better-auth-opaque@2.1.0/dist/server.js).

| Flow            | POST endpoints relative to the auth base path                         |
| --------------- | --------------------------------------------------------------------- |
| Registration    | `/sign-up/opaque/challenge`, `/sign-up/opaque/complete`               |
| Login           | `/sign-in/opaque/challenge`, `/sign-in/opaque/complete`               |
| Password change | `/opaque/changePassword/challenge`, `/opaque/changePassword/complete` |

Registration runs `client.startRegistration`, obtains a server registration response, and runs `client.finishRegistration`. Completion creates a Better Auth user and an account with `providerId: "opaque"`; by default it does not create a session. Login completes the OPAQUE exchange, calls Better Auth `internalAdapter.createSession`, and sets a Better Auth session cookie. These are [source-verified behaviors](https://unpkg.com/better-auth-opaque@2.1.0/dist/server.js).

### Critical Export-Key Analysis

The underlying Serenity library exposes `exportKey`; the plugin's public client methods do not. Serenity `0.9.0` declares the following results in its [published TypeScript API](https://unpkg.com/@serenity-kit/opaque@0.9.0/index.d.ts):

```ts
FinishClientRegistrationResult {
  registrationRecord;
  exportKey;
  serverStaticPublicKey;
}

FinishClientLoginResult {
  finishLoginRequest;
  sessionKey;
  exportKey;
  serverStaticPublicKey;
}
```

The plugin destructures only `registrationRecord` at registration and only `finishLoginRequest` at login, then returns the HTTP completion response. It provides no export-key return value, callback, or encrypted-master-key persistence. This is verified in the [published client source](https://unpkg.com/better-auth-opaque@2.1.0/dist/client.js).

Do not substitute `sessionKey`: the server also receives the session key. RFC 9807 defines a separate client-only `export_key` for application data and forbids using the login export key before peer authentication succeeds. See [RFC 9807 §6.2](https://www.rfc-editor.org/rfc/rfc9807.html#section-6.2) and [§10.4](https://www.rfc-editor.org/rfc/rfc9807.html#section-10.4).

[INFERENCE] Application code should release derived wrapping-key use only after the complete login operation succeeds. Ordinary logins can recover the same credential's export key, but fresh registration/envelope material must not be assumed to preserve it; wrap a stable random account master key rather than treating the export key as permanent account identity.

### Server State And Setup Handling

The source stores a stable `OPAQUE_SERVER_KEY`, passed to Serenity as serialized `serverSetup`; an optional unique string `account.registrationRecord`; normal Better Auth users/accounts/sessions; and the Better Auth `ctx.context.secret` used to encrypt temporary login state. The OPAQUE account provider identifier is `opaque`. Sources: [published server](https://unpkg.com/better-auth-opaque@2.1.0/dist/server.js) and [utilities](https://unpkg.com/better-auth-opaque@2.1.0/dist/utils.js).

Temporary login state contains `serverLoginState`, a user object and `issuedAt`. The plugin pads the serialized payload to 1,024 bytes, encrypts it using Better Auth symmetric encryption, sends it to the client, and accepts it back on completion. Its utility checks a 15-minute expiration. This state is not an E2EE master-key wrapper: the server can decrypt it. Source: [published utilities](https://unpkg.com/better-auth-opaque@2.1.0/dist/utils.js).

When setup is omitted, the plugin generates a development setup asynchronously and logs it. Serenity warns that changing `serverSetup` invalidates existing password files. Sources: [plugin fallback](https://unpkg.com/better-auth-opaque@2.1.0/dist/server.js) and [Serenity setup documentation](https://github.com/serenity-kit/opaque#server-setup).

[INFERENCE] Production integration should fail closed without persistent setup, protect and back up its OPRF/AKE setup material, and separately review state replay, identity binding and session binding. A timestamp check alone is not evidence of single-use state consumption. Loss of setup can make password-based key retrieval unavailable even if encrypted data remains intact.

### Password Change And Reset

Password change is implemented: it requires an authenticated session, runs OPAQUE login with the old password and registration with the new password, verifies the old-password exchange and matching session user, replaces `registrationRecord`, and deletes all user sessions. Source: [published server implementation](https://unpkg.com/better-auth-opaque@2.1.0/dist/server.js).

Forgot-password reset/data recovery is not implemented in the plugin's inspected endpoint set. There is no recovery-key hierarchy, email-reset-to-new-OPAQUE-record operation, or encrypted-master-key rewrapping. This absence is verified against the [complete server source](https://github.com/TheUntraceable/better-auth-opaque/blob/b289dccfeae759cece35e93101519b249ed74e7f/src/server.ts), rather than inferred from an abbreviated README endpoint table.

[INFERENCE] A password change must unlock the old random master key and coherently update the new OPAQUE registration record and master-key wrapper. Reset without the old key, an enrolled recovery factor or an unlocked device cannot restore old E2EE data. A conventional authentication password reset is not a cryptographic data-recovery mechanism.

### Better Auth Version Compatibility And Upgrade Path

| Combination                        | Verified compatibility statement                                                                             |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Radium current                     | Better Auth `1.6.33` and Convex Better Auth `0.12.5`                                                         |
| `better-auth-opaque@2.1.0`         | Peers Better Auth `^1.7.0`; excludes `1.6.33`                                                                |
| `better-auth-opaque@2.0.3`         | Direct Better Auth dependency `^1.3.28` includes `1.6.33` by semver, but runtime compatibility is unverified |
| Better Auth registry latest        | `1.7.18`; `release-1.6` tag is `1.6.34`                                                                      |
| Convex Better Auth registry latest | `0.13.0`, with Better Auth peer `>=1.7.16 <1.8.0`                                                            |

Dependency evidence: [OPAQUE package registry](https://registry.npmjs.org/better-auth-opaque), [Better Auth registry](https://registry.npmjs.org/better-auth), and [Convex Better Auth latest metadata](https://registry.npmjs.org/@convex-dev/better-auth/latest). Current Radium versions are recorded in `apps/web/package.json` and `packages/backend/package.json`.

Upgrading to Better Auth `1.7.18` with Convex Better Auth `0.13.0` brings the selected Better Auth version inside both the Convex adapter's and OPAQUE plugin's declared peer ranges. It does not resolve the plugin's discarded export key or its Serenity `^0.9.0` dependency, and it is not evidence of end-to-end integration compatibility. The previous plugin's direct dependency also differs from the latest release's peer-dependency model; do not treat the old semver range as a tested integration guarantee.

### Serenity Versions, RFC Conformance And Audit

`@serenity-kit/opaque` is Rust `opaque-ke` compiled to WASM with JavaScript/TypeScript bindings. Current repository dependencies include `opaque-ke 4.0.0`, `wasm-bindgen`, and Argon2. Maintainers/collaborators include Nik Graf and Stefan Oestreicher; the package is MIT-licensed. Sources: [Cargo dependencies](https://github.com/serenity-kit/opaque/blob/main/Cargo.toml) and [published metadata](https://registry.npmjs.org/@serenity-kit/opaque/latest).

| Serenity version | Publication date | Protocol evidence                                                                                             |
| ---------------- | ---------------- | ------------------------------------------------------------------------------------------------------------- |
| `0.9.0`          | 2025-03-12       | Pre-final implementation; the Better Auth plugin still depends on `^0.9.0`                                    |
| `1.0.0`          | 2025-11-01       | Changelog upgrades `opaque-ke` to `4.0.0`, matching RFC 9807, with breaking setup/registration-record changes |
| `1.1.0`          | 2026-02-01       | Latest npm release observed; adds `rfc-recommended` key-stretching option                                     |

Sources: [npm version history](https://registry.npmjs.org/@serenity-kit/opaque) and [repository changelog](https://github.com/serenity-kit/opaque/blob/main/CHANGELOG.md). The repository changelog also contains `1.1.1` changes, but npm latest remains `1.1.0` at this snapshot; repository main is not the published package.

[INFERENCE] The plugin README's command to generate setup with `@serenity-kit/opaque@latest` can now produce setup material incompatible with its own `^0.9.0` dependency. The documented `1.0.0` format break makes matching setup-generation/runtime versions necessary. Sources: [plugin README](https://github.com/TheUntraceable/better-auth-opaque/blob/b289dccfeae759cece35e93101519b249ed74e7f/README.md) and [Serenity breaking-change notes](https://github.com/serenity-kit/opaque/blob/main/CHANGELOG.md#100).

Serenity received a 7ASecurity whitebox/fuzzing review in October-November 2023 funded by OTF. The report found no directly exploitable library vulnerability and identified hardening issues primarily in examples. This audit does not cover the later Better Auth plugin or certify current package versions. See [audit scope, dates and findings](https://7asecurity.com/reports/pentest-report-opaque.pdf).

### Convex Compatibility

Current Convex default runtime explicitly supports `WebAssembly.instantiate`, `WebAssembly.Module`, `WebAssembly.Instance`, instantiation from bytes, and direct `.wasm` imports. WASM can run in all function types, with compiled modules counting toward bundle limits. The plan must not assume that Convex cannot execute WASM. Source: [Convex runtimes](https://docs.convex.dev/functions/runtimes#running-webassembly).

OPAQUE is not in Convex Better Auth's supported-plugin list. Plugins requiring schema changes need local installation/custom generated component schema; this plugin adds `account.registrationRecord`. Official guidance says arbitrary plugins may be usable, not that every package is tested or drop-in compatible. Sources: [supported plugins](https://labs.convex.dev/better-auth/supported-plugins) and [local install](https://labs.convex.dev/better-auth/features/local-install).

The published OPAQUE utility uses global `Buffer.byteLength`, which is not among the Node APIs documented for Convex's default runtime. [INFERENCE] Replace/adapt that assumption and validate the actual dependency bundle before claiming compatibility. `"use node"` is an escape hatch for actions only, not a blanket switch for auth HTTP handlers, queries or mutations. Sources: [published utilities](https://unpkg.com/better-auth-opaque@2.1.0/dist/utils.js) and [runtime restrictions](https://docs.convex.dev/functions/runtimes#nodejs-runtime).

No Convex deployment/runtime verification was performed. WASM support establishes feasibility, not tested compatibility of this plugin, its package loading, resource usage or adapter operations.

### Better Auth UI Integration

Current Better Auth UI documents specific email/password hooks and the generic `useAuthMutation` escape hatch. Built-in email/password forms do not automatically become OPAQUE flows. Its generic mutation factories add `fetchOptions.throw`; the inspected OPAQUE client methods do not accept/forward arbitrary fetch options. Sources: [UI mutation API and cache behavior](https://better-auth-ui.com/docs/react/mutations) and [OPAQUE client source](https://unpkg.com/better-auth-opaque@2.1.0/dist/client.js).

[INFERENCE] Registration, login, password change and recovery require custom orchestration, including authenticated export-key delivery to the client key manager, explicit error normalization and session-cache refresh. Reusing UI primitives is different from reusing conventional password endpoint behavior.

The repository mapping identifies `packages/backend/convex/auth.ts` (`createAuth`), `apps/web/src/lib/auth-client.ts` (`createAuthClient`), `apps/web/src/components/providers.tsx` (`AuthProvider`), and `apps/web/src/components/auth/auth.tsx` as integration surfaces. The mapped UI dependencies are `@better-auth-ui/core` and `@better-auth-ui/react` `^1.7.32`. Current backend configuration enables conventional `emailAndPassword`; the mapped client installs `convexClient()`, not an OPAQUE client plugin.

## OPAQUE Does Not Hide The Password From A Server That Already Knows It

RFC 9807's protection is that a conforming exchange does not disclose the password; it does not erase knowledge obtained through an earlier conventional login. The server holds the OPRF seed and credential record, and RFC 9807 explicitly allows a fully corrupted single server to test password guesses offline. The export key is recovered from password/OPRF-derived material and the stored envelope. Sources: [RFC 9807 §4.1](https://www.rfc-editor.org/rfc/rfc9807.html#section-4.1), [§5.2](https://www.rfc-editor.org/rfc/rfc9807.html#section-5.2), and [§10.11](https://www.rfc-editor.org/rfc/rfc9807.html#section-10.11).

[INFERENCE] If the server already knows the actual password, it can evaluate the required OPRF using its seed and reproduce client-side credential/export-key recovery instead of guessing. Calling the resulting key client-only does not protect it from an adversary holding both the password and server credential/setup material.

[INFERENCE] Existing Radium accounts must therefore register a password never sent to the server before claiming this password-based E2EE guarantee. Reusing the current Better Auth email/password secret is insufficient: the previous server could have retained it even if the current database stores only a hash. Fresh OPAQUE enrollment must not submit the new secret through legacy email/password, password-policy, reset, telemetry or logging paths. This migration requirement is a consequence of the threat model, not an OPAQUE library feature.

## Proton's Authentication And Encryption Model

### SRP-6a Authentication And Client Key Hierarchy

Proton uses hardened SRP-6a authentication rather than sending the login password to its server. Its historical technical note specifies a stored verifier `v = g^p mod N`, with password prehashing/salting; the exchange provides salt/group/challenge material rather than the password. Its implementation uses bcrypt hardening and custom signed 2,048-bit safe-prime groups instead of copying TLS-SRP defaults. Sources: [Proton authentication explanation](https://proton.me/blog/encrypted-email-authentication) and [technical note, pages 4-8](https://res.cloudinary.com/dbulfrlrz/images/v1707578054/wp-pme/ProtonMail_Authentication_excerpt/ProtonMail_Authentication_excerpt.pdf?_i=AA).

For private-key protection, Proton describes client-generated private keys encrypted using AES-256 with material derived by bcrypt from the password and a random per-user salt. The encrypted private key is uploaded; plaintext private keys and key-password material remain client-side. Source: [Proton private-key storage](https://proton.me/support/how-is-the-private-key-stored).

```text
password + per-user random salt
    -> bcrypt-derived key-password material
    -> unlocks client-generated private key
    -> unlocks product/data keys
```

Proton uses OpenPGP asymmetric user/account keys and address keys, plus product-specific calendar/share/node keys. Its 2024 Key Transparency whitepaper distinguishes these roles and documents retaining old keys for decrypting old data. This is not merely AES-256 applied to every database field with the password. Source: [Key Transparency whitepaper §2.1](https://proton.me/files/proton_keytransparency_whitepaper.pdf).

### One-Password And Two-Password Modes

In two-password mode, the login password authenticates and the mailbox password unlocks encrypted data. In one-password mode, the client derives a distinct mailbox/key password using a salted one-way hash, while SRP prevents the login password from reaching the server. Source: [Proton's one-password design explanation](https://proton.me/blog/encrypted-email-authentication#how-does-one-password-mode-work).

### Recovery, Reset And Key Rotation

Proton separates account recovery from data recovery. Email/SMS reset can restore login while old encrypted data remains locked. A recovery phrase can restore both account access and original encryption keys; a recovery file restores encrypted data but cannot itself reset the password. Old-password and trusted-device recovery are additional paths. Sources: [current recovery documentation](https://proton.me/support/recover-encrypted-messages-files), [password reset](https://proton.me/support/reset-password), and [recovery file](https://proton.me/support/recovery-file).

For recovery phrases, the client generates random bytes, encrypts copies of account keys, uploads the encrypted copies, and encodes the bytes with a simplified BIP39 scheme. The server stores an SRP-6a verifier, not the phrase. Recovery decrypts and rewraps the original account key. Source: [Proton recovery architecture](https://proton.me/blog/data-recovery-end-to-end-encryption).

For recovery files, the relationship is reversed: the local file contains encrypted backup keys and the server holds the signed secret needed to decrypt that file. The server alone lacks the file. Current support documentation calls this an encrypted backup keychain. Sources: [technical explanation](https://proton.me/blog/data-recovery-end-to-end-encryption#recovery-file) and [recovery-file support](https://proton.me/support/recovery-file).

Proton describes ordinary password reset generating new encryption keys while old keys remain protected by the old password. Without old-password/recovery access, old data can become permanently inaccessible. Recovery-phrase reset instead restores the original key and does not require generating a new one. Do not describe every password reset as unavoidable permanent deletion of stored ciphertext. Source: [technical recovery article](https://proton.me/blog/data-recovery-end-to-end-encryption).

## OPAQUE Versus SRP

| Property                | OPAQUE                                                                       | SRP                                                                                                 |
| ----------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Category                | Augmented PAKE                                                               | Verifier-based PAKE                                                                                 |
| Password sent to server | No, including registration                                                   | Can avoid disclosure with client-generated verifier                                                 |
| Password salt           | OPRF key acts as a secret salt; no extra public password salt needed         | Salt normally returned before authentication                                                        |
| Precomputation          | Explicit resistance to precomputation before server compromise               | Publicly retrievable salt permits targeted precomputation before verifier theft                     |
| Full server compromise  | Credential/setup compromise still permits per-user offline dictionary attack | Verifier and salt permit offline guessing                                                           |
| Session key             | Shared with server                                                           | Shared with server                                                                                  |
| Client E2EE export key  | Explicit client-only `export_key`                                            | No equivalent standardized application export-key construction                                      |
| Publication             | RFC 9807, July 2025, IRTF Informational; not Internet Standards Track        | RFC 2945, September 2000, Proposed Standard; RFC 5054, November 2007, Informational TLS integration |

Protocol sources: [RFC 9807 introduction and §10.4-10.11](https://www.rfc-editor.org/rfc/rfc9807.html), [RFC 2945](https://www.rfc-editor.org/info/rfc2945/), and [RFC 5054](https://www.rfc-editor.org/info/rfc5054/). RFC 2945 describes the historical SRP-3 form; RFC 5054 describes SRP-6 for TLS, so these publication labels should not be conflated with every SRP-6a application variant.

OPAQUE does not mean passwords cannot be cracked offline after complete server compromise. RFC 9807 explicitly says a corrupted single server can perform exhaustive offline dictionary attacks; its benefits include preventing advance precomputation and client-side stretching. Threshold OPRF and HSM deployments add different protections. This qualifies the Better Auth plugin README's stronger marketing language. Source: [RFC 9807 §10.11](https://www.rfc-editor.org/rfc/rfc9807.html#section-10.11).

### JavaScript And TypeScript Library Maturity

| Library                                                                      | Verified characteristics and limits                                                                                                                                                  |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`@serenity-kit/opaque`](https://github.com/serenity-kit/opaque)             | npm latest `1.1.0`; Rust/WASM `opaque-ke`; 2023 audit; RFC-capable lineage from `1.0.0`; current plugin remains on an older incompatible lineage                                     |
| [`@cloudflare/opaque-ts`](https://github.com/cloudflare/opaque-ts)           | npm latest `0.7.5`; TS/WebCrypto, `@cloudflare/voprf-ts`, `@noble/hashes` scrypt; README identifies OPAQUE draft v07, not final RFC 9807                                             |
| [`secure-remote-password`](https://github.com/LinusU/secure-remote-password) | Browser/Node SRP client/server APIs and TS declarations; README recommends slow password hashing; 110-star snapshot                                                                  |
| [`tssrp6a`](https://github.com/midonet/tssrp6a)                              | Dependency-free TS, native BigInt/WebCrypto, RFC vectors; default routines do not strictly follow SRP identity binding and require configuration for that behavior; 40-star snapshot |
| [`thinbus-srp`](https://github.com/simbo1905/thinbus-srp-npm)                | Browser/server JS SRP-6a, RFC vectors, modern ESM and legacy packaging, SHA-256 default; 106-star snapshot                                                                           |

Version evidence: [Serenity metadata](https://registry.npmjs.org/@serenity-kit/opaque/latest) and [Cloudflare metadata](https://registry.npmjs.org/@cloudflare/opaque-ts/latest). Cloudflare's repository has newer vector files, but that does not establish final-RFC compatibility of its published `0.7.5` package.

[INFERENCE] SRP's age and deployments are valuable, but choosing an arbitrary JS SRP library does not reproduce Proton's hardened protocol, key hierarchy, identity lifecycle or audits. Serenity is the strongest researched OPAQUE candidate, not a substitute for integration review and exact-version testing.

## Prior Art

### Bitwarden

Bitwarden locally derives a 256-bit master key using its configured password KDF, stretches it with HKDF to 512 bits, and uses that to protect a randomly generated user symmetric/account encryption key. The server stores the protected symmetric key and authentication hash, not the plaintext master key. User RSA private keys are protected by the user symmetric key; organization symmetric keys are wrapped for members using RSA public keys. A normal password change rewraps account-key material; account encryption-key rotation is a separate operation requiring data re-encryption. Source: [Bitwarden security whitepaper](https://bitwarden.com/help/bitwarden-security-white-paper/).

### 1Password

Two-secret key derivation, or 2SKD, combines the account password with a locally generated Secret Key carrying approximately 128 bits of entropy. Server data alone is insufficient to verify account-password guesses without that Secret Key. The derived Account Unlock Key protects the private key that unlocks vault keys. This adds a second-device/recovery-secret usability requirement rather than obtaining that guarantee from PAKE alone. Source: [1Password security whitepaper, chapters 3-5](https://1passwordstatic.com/files/security/1password-white-paper.pdf).

### WhatsApp Backups

WhatsApp combines a random client backup key, OPAQUE-derived wrapping material, and an HSM Backup Key Vault enforcing attempt limits. The HSM/verification architecture is essential to that anti-brute-force guarantee; a software-only OPAQUE plugin is not equivalent. Its current whitepaper documents registration/retrieval, backup-key wrapping, and layered encapsulation/root/per-file keys; password changes avoid re-encrypting backup contents. Sources: [WhatsApp encrypted-backup whitepaper, pages 7-12](https://www.whatsapp.com/security/WhatsApp_Security_Encrypted_Backups_Whitepaper.pdf) and [engineering introduction](https://engineering.fb.com/2021/09/10/security/whatsapp-e2ee-backups/).

### Ente

A password-derived KEK wraps a random master key; the master key wraps collection keys; collection keys wrap file keys. Public-key wrapping supports sharing. A recovery key independently wraps the master key, permitting a new password wrapper without re-encrypting the library. Source: [Ente's primary architecture specification](https://github.com/ente/ente/blob/main/architecture/README.md).

### Standard Notes

Protocol 004 uses Argon2id to produce 512 bits split into client `masterKey` and `serverPassword`. Random `itemsKey` values wrap individual item keys. Password changes rewrap items keys instead of every item, generate a new default items key, and progressively migrate data. Its published parameters are 64 MiB, five iterations, parallelism one, with XChaCha20-Poly1305 data encryption. Source: [primary protocol specification](https://github.com/standardnotes/app/blob/main/packages/snjs/specification.md).

### Passkeys And WebAuthn PRF

Ordinary passkey signatures authenticate but do not directly supply an E2EE decryption key. The PRF extension returns a credential-specific deterministic 32-byte secret usable for key derivation. Multiple passkeys require independent wrappers of the same random master key rather than assuming that their PRF outputs match. Source: [W3C PRF explainer](https://github.com/w3c/webauthn/blob/main/explainers/prf-extension.md).

| Browser family  | Verified 2025-2026 availability evidence                                                                                                                                   |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chromium        | PRF shipped/enabled; Chrome 116 rollout is discussed in the [Chromium intent thread](https://groups.google.com/a/chromium.org/g/blink-dev/c/iTNOgLwD2bI)                   |
| Safari          | Safari 18.0 explicitly announced PRF support in [WebKit release notes](https://webkit.org/blog/15865/webkit-features-in-safari-18-0/#passkeys)                             |
| Firefox desktop | Firefox 139, released 2025-05-27, supports PRF across desktop platforms per [Mozilla release notes](https://developer.mozilla.org/en-US/docs/Mozilla/Firefox/Releases/139) |
| Firefox Android | Android implementation bug fixed for Firefox 149 per [Mozilla bug 1958716](https://bugzilla.mozilla.org/show_bug.cgi?id=1958716)                                           |

Browser-level support is not authenticator, transport or passkey-provider support. Inspect actual returned PRF results, distinguish credential-creation support from assertion support, and retain recovery capability. The API may return no usable result even when the browser recognizes the extension. Source: [MDN PRF input/output documentation](https://developer.mozilla.org/en-US/docs/Web/API/Web_Authentication_API/WebAuthn_extensions#prf).

## Browser Argon2id

`hash-wasm` provides browser/Node WASM, zero dependencies and Web Worker support. Its `argon2id` options include `password`, `salt`, `parallelism`, `iterations`, `memorySize`, `hashLength`, and `outputType`; `memorySize` is in KiB. For key derivation use binary output, not a PHC verification string as the encryption key. Source: [hash-wasm README/API](https://github.com/Daninet/hash-wasm).

libsodium.js provides WASM/JS browser bindings; password-hashing APIs are documented in the sumo API. `crypto_pwhash(keyLength, password, salt, opsLimit, memLimit, algorithm)` uses bytes for `memLimit`; select `crypto_pwhash_ALG_ARGON2ID13` explicitly and await readiness. Sources: [JS bindings](https://github.com/jedisct1/libsodium.js), [sumo API](https://github.com/jedisct1/libsodium.js/blob/master/API_sumo.md), and [password-hashing guidance](https://libsodium.gitbook.io/doc/password_hashing/default_phf).

| Profile                | Memory              | Iterations | Parallelism |
| ---------------------- | ------------------- | ---------- | ----------- |
| OWASP headline minimum | 19 MiB / 19,456 KiB | 2          | 1           |
| OWASP alternative      | 46 MiB / 47,104 KiB | 1          | 1           |
| OWASP alternative      | 12 MiB / 12,288 KiB | 3          | 1           |
| OWASP alternative      | 9 MiB / 9,216 KiB   | 4          | 1           |
| OWASP alternative      | 7 MiB / 7,168 KiB   | 5          | 1           |

These are password-storage minimum profiles, not an automatic optimum for an encrypted client vault. Benchmark the supported device set rather than treating one example configuration as sufficient. Source: [OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html#argon2id).

Libsodium's interactive baseline uses 64 MiB, moderate uses 256 MiB, and sensitive uses 1 GiB. Persist exact algorithm, salt and cost parameters so keys can be reproduced; do not derive persistent keys using an unversioned default that can change after a library upgrade. Source: [libsodium parameter guidance](https://libsodium.gitbook.io/doc/password_hashing/default_phf).

[INFERENCE] Begin evaluation around 64 MiB on supported browsers, execute derivation in a dedicated Web Worker, define a tested minimum-device policy, and version parameters. Do not silently downgrade parameters or change them without rewrapping keys.

OPAQUE already applies its configured stretching function to the OPRF output. [INFERENCE] Adding an independent password-derived server-stored master-key wrapper can create a new offline-guessing surface that bypasses the OPRF precomputation barrier. Review the whole key hierarchy instead of stacking unrelated KDFs. Source: [RFC 9807 §10.8-10.11](https://www.rfc-editor.org/rfc/rfc9807.html#section-10.8).

## Planning Risks

The following are design implications, not exercised implementation guarantees:

1. [INFERENCE] Pin matching client/server OPAQUE suites, setup formats and KSF parameters; do not generate production setup with an unpinned `@latest` command.
2. [INFERENCE] Upgrade Better Auth and the Convex adapter coherently; satisfying peer ranges does not fix export-key exposure, old crypto dependencies or untested adapter behavior.
3. [INFERENCE] Migrate existing accounts using a password never sent through the old authentication system; PAKE cannot revoke historical server knowledge.
4. [INFERENCE] Keep master-key wrappers independent from payload encryption and distinguish password change from data-key rotation.
5. [INFERENCE] Specify account reset separately from data recovery, including explicit irreversible-loss warnings and enrolled recovery wrappers.
6. [INFERENCE] Make registration-record/key-wrapper changes coherent across interrupted operations and concurrent devices; changing one without the other can lock out data access.
7. [INFERENCE] Review email verification, account linking, MFA, rate limiting, custom endpoint authentication, state replay and session handling; PAKE does not implement those policies automatically.
8. [INFERENCE] Protect and back up OPAQUE setup material; consider setup loss, compromise and migration as part of recoverability.
9. [INFERENCE] Test actual WASM initialization, package bundling, cryptographic randomness, resource limits and browser/device performance in the selected runtimes before claiming compatibility.
10. [INFERENCE] State that Gateway/upstream processing is still a plaintext trust boundary wherever intended and that browser-client distribution remains trusted.

This research did not run Convex CLI, deploys, dev servers, package integration tests or runtime verification. Primary-source inspection establishes the facts above; compatibility and proposed integration behavior remain unverified unless explicitly identified otherwise.
