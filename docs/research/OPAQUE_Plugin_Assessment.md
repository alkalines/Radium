# `@alkalines/better-auth-opaque` — Maintainer Assessment

Covers 0.1.3 (the original review, below) and 0.2.0 (the re-review in the next section). Owner org: alkalines. Consumer: Radium E2EE ([Authentication](../E2EE/Authentication.md), which already links here).

## 0.2.0 Re-Review (2026-11-09)

**Verdict: F1–F8 fixed; one Medium gap in a default (N1), no new High finding.** Radium is not exposed to N1 when it pins both allowlists (below).

**Release integrity.** npm integrity `sha512-96e2RgUQ…` matches the SLSA provenance subject; the attestation names `.github/workflows/release.yml` at `refs/tags/v0.2.0`, commit `4ca1686`. A rebuild from the tag (`git archive v0.2.0`, `bun install --frozen-lockfile`, `bun run build`) produces a `dist/` byte-identical to the published one; the published manifest matches the tag's apart from dev-only fields.

**Method.** Every 0.1.3 regression test (written to fail on 0.1.3) was ported to the 0.2.0 API without weakening its assertions and run in an extracted copy of the tag, together with new tests for the fixes and features: 111 recheck tests, of which the 8 exploit tests now fail as intended (the attacks no longer work) and the rest pass; the repository's own suite passes 368/368 and `tsc` passes. A separate static review checked each CHANGELOG security entry against the code and against Better Auth 1.7.18 internals. Runs used the plugin's in-memory test database, not Convex. The plugin repository was not modified.

| ID  | 0.2.0 status                    | Evidence                                                                                                                                                                                                                                                                                                                                                                      |
| --- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | **Fixed**, gap N1               | Default client refuses the weak profile in sign-up, change and reset (`KEY_STRETCHING_MISMATCH`) and a missing profile (`INVALID_SERVER_RESPONSE`); no payload builder call, no `complete` request. A client pinned to `rfc-recommended` refused all 28 combinations (4 other profiles × 7 flows including attach) in 2–58 ms.                                                |
| F2  | **Fixed**                       | `deleteUserSessions` plus a reissued session: with 60 expired and 130 live sessions ahead of the attacker's, exactly the caller's new session remains; the attacker's cookie and bearer token are dead.                                                                                                                                                                       |
| F3  | **Fixed**                       | Login profiles go through the same allowlist and the bounded schema (`ARGON2ID_CUSTOM_LIMITS`): refusal in 2 ms (0.1.3 derived for 265 ms); out-of-bounds values give `INVALID_SERVER_RESPONSE` instead of throwing.                                                                                                                                                          |
| F4  | **Fixed**                       | TOTP, OTP send/verify and backup codes answer `CREDENTIAL_CHANGED` with no session after reset, change, attach and enrolment, including challenges started with Better Auth's own `/sign-in/email`; a backup code is not spent.                                                                                                                                               |
| F5  | **Fixed**                       | Links are bound to the credential version and a revocation marker: an older link fails verify and reset after a reset, a change or `revokePasswordResetTokens`, also between challenge and complete; `revokePrevious` works; 0.1.x links are rejected.                                                                                                                        |
| F6  | Not re-measured                 | In-memory: median 1.083 ms known vs 1.055 ms unknown. The code now runs the same queries for both; the CHANGELOG's Convex figures (60.0 vs 61.3 ms) were not reproduced.                                                                                                                                                                                                      |
| F7  | **Fixed**                       | With origin checks on, cross-site sign-in, sign-up and reset requests get 403 and set no cookie; session-bound endpoints (attach, change) are also refused cross-site.                                                                                                                                                                                                        |
| F8  | **Fixed**                       | `SIGN_UP_DISABLED` at the challenge and again at complete; `opaque({ disableSignUp })` overrides Better Auth's flag both ways.                                                                                                                                                                                                                                                |
| —   | Missing capabilities: **added** | Attach (`/opaque/attach/*`, classic password checked with Better Auth's constant-time hasher; concurrent attaches leave at most one OPAQUE account; a classic password changed mid-flow gives `CREDENTIAL_CHANGED`), enrolment reset links, server-only `removeClassicCredential` and `revokePasswordResetTokens` (no HTTP route), `accountRateLimit`, `onCredentialChanged`. |

### New findings in 0.2.0

- **N1 — Medium: the default allowlist still permits a downgrade.** `DEFAULT_ALLOWED_KEY_STRETCHING` (`src/client/index.ts:34-38`) includes `memory-constrained` (64 MiB, 3 passes) next to `rfc-recommended` (2 GiB − 1 KiB, 1 pass), for registration and login. A compromised backend can make a default client register under it: measured 108 ms vs 1270 ms per guess (≈12× cheaper) with 32× less memory, so far cheaper on memory-bound attack hardware. `rfc-draft-recommended` cost the same as `rfc-recommended` (1259 ms), so it is not a downgrade. Fix: default the registration allowlist to `rfc-recommended` only (or to the strongest profile the app names), keep weaker profiles opt-in and login-only for legacy accounts.
- **N2 — Medium, opt-in:** `attach: { requireCurrentPassword: false }` lets any session younger than `freshSessionAge` (default 600 s, no upper bound) — from a stolen cookie or a weaker sign-in method — set the password, delete the classic credential and revoke the victim's sessions; the client cannot check password reuse then (`src/server/attach.ts:73-80`). Fix: document as unsafe for E2EE consumers, cap `freshSessionAge`, or require a second proof.
- **N3 — Low:** enrolment links (`allowEnrolment`, up to 7 days) are not bound to the classic credential (`src/server/reset-password.ts:187-193`), so a link that leaked before the user changed or reset the classic password still works afterwards. Fix: bind enrolment links to the classic-credential fingerprint already used by attach.
- **N4 — Low (present since 0.1.3):** the 2FA-management proof check returns early when the database session lookup misses (`src/server/two-factor.ts:282-283`, `if (!session) return;`). With Better Auth's `session.cookieCache` on, a session revoked in the database but still cached can read the TOTP URI or regenerate backup codes without a password proof. Fix: fail closed (throw) when no database session is found. Not reachable in Radium: the Convex plugin keeps the cookie cache off and Radium does not enable 2FA.
- **N5 — Low, documented:** with `generateId: false` on integer-id databases and no `absentUserId`, unknown emails make the uniform lookup fail (500) while known ones succeed (200) (`src/server/sign-in.ts:30-42`).
- **N6 — Low:** server option validation uses a loose object and accepts any hook name (`src/server/runtime.ts:108,112`), so a typo such as `accountRatelimit` silently disables a protection. Fix: `strictObject` and an explicit hook-key set.
- **N7 — Info:** the 2FA binding hard-codes Better Auth's `two_factor` cookie name and verify paths (`src/server/two-factor.ts:32-51`); a 1.7.x change could leave native sign-in challenges unbound. Fix: refuse unbindable challenges and self-check at boot.
- **Info:** a client that explicitly allowlists the largest allowed custom profile (64 iterations × ~2 GiB) runs serenity synchronously on the page thread, estimated ~80 s [INFERENCE: not run]; the default allowlist contains no custom profile. The test helper's default client allowlists the old weak test profile, so suites must pass `{}` to test the real default. `PASSWORD_REUSED` compares exact equality only. Two concurrent attaches: the loser usually gets 401 because the winner revoked every session.

### What Radium must change to adopt 0.2.0

**Done 2026-11-09** ([task 11 phase 4](../tasks/11_E2EE.md#phase-4-opaque-in-radium)): all items below are implemented; item 4's Convex token refresh happens through the plugin's session signal, verified in the browser.

1. `opaqueClient({ keyStretching: "rfc-recommended" })` throws on 0.2.0. Use `{ registration: ["rfc-recommended"], login: ["rfc-recommended"] }`; `login` must be explicit or it falls back to the defaults (N1).
2. Radium's `emailAndPassword.disableSignUp: true` now also closes OPAQUE sign-up: set `opaque({ disableSignUp: false })`.
3. Payload hooks must accept `flow: "attach"` and, if enrolment links are used, `credentialVersion: null` in `loadPayload`.
4. `changePassword` replaces the caller's session (`{ status, token }`); refresh the Convex token afterwards, and treat a 401 during attach as "already migrated, sign in again".
5. `issuePasswordResetLink` should pass `revokePrevious: true`; links issued by 0.1.x stop working.
6. Never enable `attach.requireCurrentPassword: false` (N2); the migration screen must require a new password different from the classic one.
7. Radium's own challenge-profile guard (`apps/web/src/lib/auth/opaque-guard.ts`) becomes redundant with the pinned allowlist and runtime response parsing; it can be removed once the pinned client is verified in the browser.
8. Account migration (task 11 phase 4) is now unblocked: attach for users who know their classic password, enrolment links for those who do not.

---

# 0.1.3 Assessment

Status: **review complete; regression tests executed on 2026-11-08** against plugin HEAD `681f777` (node project, Vitest 5.1.0; see [Verification log](#verification-log)).

- Plugin source reviewed: `/home/arthu/Projects/alkalines-better-auth-opaque`, HEAD `681f777`. The lead checked (and this run re-checked) that the npm tarball integrity is `sha512-Vb8Y4C…`, that the SLSA provenance names commit `681f777` and points to `alkalines/better-auth-opaque` `.github/workflows/release.yml` at tag `v0.1.3`, and that the published `dist/` is byte-identical to the repo `dist/`. The exact evidence is recorded in the [Verification log](#verification-log).
- Installed dependencies used as evidence: `better-auth`/`@better-auth/core` 1.7.18, `better-call` (bundled with them), `@serenity-kit/opaque` 1.1.0, `@convex-dev/better-auth` 0.13.0 (Radium `node_modules/.bun/...`). Paths below are shortened:
  - `plugin/` = the plugin repo
  - `ba/` = `node_modules/.bun/better-auth@1.7.18+266c4b6b81de31a6/node_modules/better-auth/dist/`
  - `core/` = the `@better-auth/core/dist/` next to it
  - `call/` = `better-call/dist/` next to it
  - `cba/` = `node_modules/.bun/@convex-dev+better-auth@0.13.0+dec71b0d35eb301e/node_modules/@convex-dev/better-auth/dist/`
- Threat model: the same one Radium uses. The browser client is trusted and distributed separately from the backend. The authentication backend (Convex deployment, OPRF setup) **may be compromised**. Network attackers and other users are hostile. The plugin's own `docs/security.md` puts "a compromised server process" out of scope, so F1 and F3 show a gap between that threat model and Radium's.
- Based on the earlier static review (F1–F4, I1–I8). Everything was re-read for this report, and new items F5–F8 were added.

Labels: **confirmed by test** means the regression test below was run and its result demonstrates the issue; the **Observed** line under each finding gives the real output. **not reproduced** means the run did not show the claimed behaviour. The "Expected output" lists were written from tracing the code before the run and are kept for comparison. **[static]** means the claim comes only from reading source. **[INFERENCE]** means the behaviour was neither read in code nor observed.

## Summary

| ID  | Severity | Finding                                                                                                                                                                                                                                                                                                        | Test result                                                                                                                                                                                                                   | Fix (short)                                                                                                                                                          |
| --- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | High     | Default `opaqueClient()` registers under whatever key-stretching profile the server advertises (sign-up, change, reset), including a trivially weak custom Argon2id one. A compromised backend that holds the OPRF key can then dictionary-attack the record cheaply and recover the export key, i.e. the AMK. | **confirmed by test** `zz-review-f1-registration-profile.test.ts`: weak record created in all 3 flows; per-guess cost 0.5 ms (weak) vs 103.6 ms (`memory-constrained`)                                                        | Enforce a client-owned registration floor by default. Make weaker profiles an explicit opt-in. Parse challenge responses.                                            |
| F2  | High     | Password change revokes only the sessions returned by **one** `listSessions` page (adapter default `findMany` limit 100, expired rows included). Any later session survives the change.                                                                                                                        | **confirmed by test** `zz-review-f2-session-revocation.test.ts`: attacker session still valid after change (3 sessions left with 100 fillers)                                                                                 | Revoke exhaustively: `deleteUserSessions` plus reissuing the current session (the native Better Auth pattern), or page until empty.                                  |
| F3  | Medium   | Sign-in, password-proof and change-password run Argon2id with the profile from the (unauthenticated) challenge response. There is no upper bound and no client policy, even when the client is pinned. A malicious backend can freeze or crash the tab.                                                        | **confirmed by test** `zz-review-f3-login-work-factor.test.ts`: pinned client derived with the raised profile (265 ms vs 6 ms honest); invalid parameters make the action throw                                               | Client policy: an allowlist plus an upper bound on iterations, memory and parallelism, checked before every derivation. Apply the pin to login profiles too.         |
| F4  | Medium   | A second-factor sign-in that was started with the old password before a reset or change can still complete afterwards and mint a session.                                                                                                                                                                      | **confirmed by test** `zz-review-f4-pending-2fa.test.ts`: `verifyTotp` after reset and after change returns no error and mints a session. The existing `test/unit/two-factor.test.ts:285-308` already asserts this behaviour. | Bind the pending `2fa-*` authorization to the credential version and re-check it when the session is created. Invalidate pending authorizations on change and reset. |
| F5  | Medium   | Reset tokens store only `userId`. A reset, or a password change, does not invalidate other outstanding reset tokens, so an older link can reset again until it expires. It also reveals the **new** payload through `/reset/opaque/verify`.                                                                    | **confirmed by test** `zz-review-f5-reset-token-binding.test.ts`: stale link returns the new payload `{"tag":"v2"}` and a second reset succeeds                                                                               | Store the credential version at issuance, reject when it no longer matches, and delete the user's reset tokens on every credential switch.                           |
| F6  | Low      | Timing of the sign-in challenge for a known vs an unknown email: on adapters without native joins (Convex), a known email costs one extra adapter query.                                                                                                                                                       | [static]; **not reproduced** on the memory adapter (p50 known 1.006 ms vs unknown 0.954 ms); Convex not measured                                                                                                              | Do equivalent work on the miss path, or look up the credential with a single indexed query.                                                                          |
| F7  | Low      | OPAQUE first-login endpoints (sign-in, sign-up, reset) skip `formCsrfMiddleware`, so a cross-site `Origin` without cookies is not rejected. The unit suite also runs with origin checks disabled (`isTest()` default).                                                                                         | **confirmed by test** in `zz-review-misc.test.ts`: cross-site `Origin`, native 403, OPAQUE challenge 200                                                                                                                      | Add `use: [formCsrfMiddleware]` to the cookie-setting first-login endpoints. Run one suite with `advanced.disableOriginCheck: false`.                                |
| F8  | Low      | OPAQUE sign-up ignores `emailAndPassword.enabled` / `disableSignUp`.                                                                                                                                                                                                                                           | **confirmed by test** in `zz-review-misc.test.ts`: native sign-up 400, OPAQUE sign-up succeeds                                                                                                                                | Add an `opaque({ disableSignUp })` option or honour the native flags, documented either way.                                                                         |

Checks requested by the lead that produced **no finding** (details in [Other checks](#other-checks-no-finding)):

- `loadPayload` throwing fails closed.
- Error bodies do not leak hook messages.
- No cookie-cache revocation lag under Convex.
- Adapters without `consumeOne` stay single-use.
- Sign-up for an existing email returns 422 (enumeration, documented).

## How to run the regression tests

All test files go in `plugin/test/unit/`. They import `./helpers.ts` and do not modify it. File names start with `zz-review-` so they can be removed as a group.

```sh
cd /home/arthu/Projects/alkalines-better-auth-opaque
# Node project only: F1/F3 contain timing output; the edge-runtime project would double the time.
bun run test -- --project node zz-review
# Clean up afterwards; the repository must end clean:
rm test/unit/zz-review-*
git -C /home/arthu/Projects/alkalines-better-auth-opaque status --porcelain   # must print nothing
```

Each test is tagged:

- `[exploit]`: expected to **pass on 0.1.3**, because it demonstrates the issue.
- `[regression]`: expected to **fail on 0.1.3** and pass after the fix. Maintainers should keep these.
- `[control]`: expected to pass both before and after the fix.

### Shared helper — `test/unit/zz-review-malicious-server.ts`

```ts
/**
 * Simulates a compromised authentication backend for client-side tests: requests go to the real
 * Better Auth handler, and selected JSON responses are rewritten before the OPAQUE client sees them.
 */
export type Handler = { handler: (request: Request) => Promise<Response> };
export type Rewrite = (
  path: string,
  body: Record<string, unknown>,
) => Record<string, unknown> | undefined;

export function maliciousServer(auth: Handler, rewrite: Rewrite): Handler {
  return {
    handler: async (request) => {
      const response = await auth.handler(request);
      if (!response.ok) return response;
      const path = new URL(request.url).pathname.replace(/^\/api\/auth/, "");
      const text = await response.clone().text();
      if (!text) return response;
      const rewritten = rewrite(path, JSON.parse(text) as Record<string, unknown>);
      if (!rewritten) return response;
      const headers = new Headers(response.headers); // keeps every Set-Cookie
      headers.delete("content-length");
      return new Response(JSON.stringify(rewritten), {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    },
  };
}

export async function timed<T>(run: () => Promise<T>): Promise<{ result: T; ms: number }> {
  const started = performance.now();
  const result = await run();
  return { result, ms: performance.now() - started };
}

export function completeCount(client: { requests: { url: string }[] }, pathSuffix: string): number {
  return client.requests.filter((request) => new URL(request.url).pathname.endsWith(pathSuffix))
    .length;
}
```

---

## F1 — High: default client registers under a server-chosen weak profile

### Evidence

- `plugin/src/client/index.ts:202-206`: the profile is compared only when `pinnedKeyStretching !== undefined`.
- `plugin/src/client/index.ts:208-217`: otherwise `challenge.keyStretching` goes straight into `client.finishRegistration`, and then the payload builder gets the resulting export key.
- `plugin/src/client/index.ts:222-223`: `opaqueClient()` leaves the pin undefined. The README examples use the default.
- `plugin/src/contract.ts:152-163`: a custom profile only needs each value to be at least 1.
- `plugin/src/client/index.ts:10-28,261`: the response schemas are imported as **types** only, and `post()` returns `result.data as T` without parsing. A challenge that **omits** `keyStretching` therefore reaches serenity as `undefined`, and serenity then uses its own default `memory-constrained` (serenity `README.md:234-247`). That profile is weaker than the plugin's server default `rfc-recommended` (2^21−1 KiB, `README.md:249-270`).
- The pin covers registrations only. Sign-in has no equivalent (see F3).

### Preconditions

The backend is compromised: the attacker controls the auth HTTP responses and holds the OPRF `serverSetup`. The web client code is not compromised (it is shipped separately). The user registers, changes the password or resets it while the backend is compromised.

### Impact

The client builds a registration record whose envelope is protected by attacker-chosen Argon2id cost (for example 1 iteration, 1 MiB). It then wraps Radium's AMK under the export key from that record and uploads both. With the OPRF key, the backend can test each password guess at roughly `OPRF + weak Argon2id` cost. A hit yields the export key, then the KEK, then the AMK, which defeats E2EE. Radium's design already says the client must refuse anything except `rfc-recommended` (`docs/E2EE/Authentication.md:87`). The plugin's default does not do this.

Merely changing the profile on a **sign-in** challenge for an already strong record does not expose a weaker key: the envelope fails to open. That case is the DoS in F3, not a key leak.

### Test — `test/unit/zz-review-f1-registration-profile.test.ts`

```ts
import { client as opaqueProtocol, server as opaqueServer } from "@serenity-kit/opaque";
import { beforeAll, describe, expect, test, vi } from "vitest";
import type { OpaqueKeyStretching } from "../../src/contract.ts";
import {
  createMemoryDb,
  createPayloadApp,
  createTestAuth,
  createTestClient,
  serverSetupForTests,
  type TestClient,
} from "./helpers.ts";
import { completeCount, maliciousServer } from "./zz-review-malicious-server.ts";

// `memory-constrained` stands in for the production `rfc-recommended` to keep the run short; the
// mechanism is identical.
const HONEST: OpaqueKeyStretching = "memory-constrained";
const WEAK: OpaqueKeyStretching = {
  "argon2id-custom": { iterations: 1, memory: 1024, parallelism: 1 },
};
const PASSWORD = "f1-correct-horse-battery";
const NEW_PASSWORD = "f1-new-password-staple";

type Flow = "sign-up" | "change-password" | "reset-password";
const CHALLENGE: Record<Flow, string> = {
  "sign-up": "/sign-up/opaque/challenge",
  "change-password": "/opaque/change-password/challenge",
  "reset-password": "/reset/opaque/challenge",
};
const COMPLETE: Record<Flow, string> = {
  "sign-up": "/sign-up/opaque/complete",
  "change-password": "/opaque/change-password/complete",
  "reset-password": "/reset/opaque/complete",
};

let serverSetup: string;
beforeAll(async () => {
  serverSetup = await serverSetupForTests();
});

/**
 * Builds an honest server (profile HONEST) behind a malicious front that rewrites the challenge of
 * `flow`, and returns a client of that front plus a `run()` that performs `flow` with a payload
 * builder (the AMK wrapper in Radium).
 */
async function prepare(
  flow: Flow,
  pin: OpaqueKeyStretching | undefined,
  tamper: (body: Record<string, unknown>) => Record<string, unknown> = (body) => ({
    ...body,
    keyStretching: WEAK,
  }),
) {
  const db = createMemoryDb();
  const app = createPayloadApp();
  const auth = createTestAuth({
    db,
    opaque: {
      serverSetup,
      keyStretching: HONEST,
      hooks: app.hooks,
      passwordReset: { url: (token) => `http://localhost:3000/reset?token=${token}` },
    },
  });
  const evil = maliciousServer(auth, (path, body) =>
    path === CHALLENGE[flow] ? tamper(body) : undefined,
  );
  const weakLogin = maliciousServer(auth, (path, body) =>
    path === "/sign-in/opaque/challenge" ? { ...body, keyStretching: WEAK } : undefined,
  );
  const builder = vi.fn((exportKey: string) => ({ amkWrapper: `wrapped:${exportKey.length}` }));
  const email = `f1-${flow}@example.com`;
  const client: TestClient = createTestClient(
    evil,
    pin === undefined ? undefined : { keyStretching: pin },
  );

  let run: () => Promise<{ data: { exportKey: string } | null; error: unknown }>;
  let password = NEW_PASSWORD;
  if (flow === "sign-up") {
    password = PASSWORD;
    run = () =>
      client.authClient.signUp.opaque({ email, password: PASSWORD, name: "F1", payload: builder });
  } else if (flow === "change-password") {
    // Honest sign-up through the same browser (only the change challenge is tampered).
    const signUp = await client.authClient.signUp.opaque({ email, password: PASSWORD, name: "F1" });
    expect(signUp.error).toBeNull();
    run = () =>
      client.authClient.opaque.changePassword({
        currentPassword: PASSWORD,
        newPassword: NEW_PASSWORD,
        payload: builder,
      });
  } else {
    const signUp = await createTestClient(auth).authClient.signUp.opaque({
      email,
      password: PASSWORD,
      name: "F1",
    });
    expect(signUp.error).toBeNull();
    const { url } = await auth.api.createPasswordResetToken({ body: { email } });
    const token = new URL(url).searchParams.get("token")!;
    run = () =>
      client.authClient.opaque.resetPassword({
        token,
        newPassword: NEW_PASSWORD,
        payload: builder,
      });
  }
  return { db, auth, weakLogin, client, builder, email, password, run };
}

describe("F1 [exploit] default opaqueClient() registers under a weak server-chosen profile", () => {
  for (const flow of ["sign-up", "change-password", "reset-password"] as const) {
    test(
      `${flow}: weak record is created and the AMK builder runs`,
      { timeout: 120_000 },
      async () => {
        const { auth, weakLogin, client, builder, email, password, run } = await prepare(
          flow,
          undefined,
        );
        const result = await run();
        expect(result.error).toBeNull();
        expect(builder).toHaveBeenCalledTimes(1);
        expect(completeCount(client, COMPLETE[flow])).toBe(1);

        // Proof that the stored record is protected by WEAK, not by the server's HONEST profile:
        const honest = await createTestClient(auth).authClient.signIn.opaque({ email, password });
        expect(honest.error?.code).toBe("INVALID_CREDENTIALS");
        const weak = await createTestClient(weakLogin).authClient.signIn.opaque({
          email,
          password,
        });
        expect(weak.error).toBeNull();
        expect(weak.data?.exportKey).toBe(result.data?.exportKey);
      },
    );
  }

  test(
    "offline guessing with the server setup costs only the WEAK derivation",
    { timeout: 120_000 },
    async () => {
      const { db, run } = await prepare("sign-up", undefined);
      expect((await run()).error).toBeNull();
      const account = db.account.find((row) => row.providerId === "opaque")!;
      const guess = (password: string, keyStretching: OpaqueKeyStretching) => {
        const login = opaqueProtocol.startLogin({ password });
        const { loginResponse } = opaqueServer.startLogin({
          serverSetup,
          userIdentifier: account.accountId as string,
          registrationRecord: account.registrationRecord as string,
          startLoginRequest: login.startLoginRequest,
        });
        const started = performance.now();
        const finished = opaqueProtocol.finishLogin({
          clientLoginState: login.clientLoginState,
          loginResponse,
          password,
          keyStretching,
        });
        return { ok: finished !== undefined, ms: performance.now() - started };
      };
      const wrong = guess("not-the-password", WEAK);
      const right = guess(PASSWORD, WEAK);
      const honestCost = guess(PASSWORD, HONEST);
      console.log(
        `[F1] per-guess client cost: weak=${wrong.ms.toFixed(1)} ms, honest profile=${honestCost.ms.toFixed(1)} ms`,
      );
      expect(wrong.ok).toBe(false);
      expect(right.ok).toBe(true); // backend recovers the export key at WEAK cost
      expect(honestCost.ok).toBe(false);
    },
  );
});

describe("F1 [control] a pinned client already refuses (opt-in protection)", () => {
  for (const flow of ["sign-up", "change-password", "reset-password"] as const) {
    test(
      `${flow}: pinned client aborts before deriving or completing`,
      { timeout: 120_000 },
      async () => {
        const { client, builder, run } = await prepare(flow, HONEST);
        const result = await run();
        expect((result.error as { code?: string } | null)?.code).toBe("KEY_STRETCHING_MISMATCH");
        expect(builder).not.toHaveBeenCalled();
        expect(completeCount(client, COMPLETE[flow])).toBe(0);
      },
    );
  }
});

describe("F1 [regression] the default client must refuse a weak or missing registration profile", () => {
  for (const flow of ["sign-up", "change-password", "reset-password"] as const) {
    test(`${flow}: weak custom profile is refused by default`, { timeout: 120_000 }, async () => {
      const { client, builder, run } = await prepare(flow, undefined);
      const result = await run();
      expect(result.error).not.toBeNull();
      expect(builder).not.toHaveBeenCalled();
      expect(completeCount(client, COMPLETE[flow])).toBe(0);
    });

    test(`${flow}: challenge without keyStretching is refused`, { timeout: 120_000 }, async () => {
      const { client, builder, run } = await prepare(flow, undefined, (body) => {
        const { keyStretching: _dropped, ...rest } = body;
        return rest;
      });
      const result = await run();
      expect(result.error).not.toBeNull();
      expect(builder).not.toHaveBeenCalled();
      expect(completeCount(client, COMPLETE[flow])).toBe(0);
    });
  }
});
```

### Expected output (written before the run)

- `[exploit]` × 4: pass. The offline-guess test should log a weak cost of a few ms vs about a second for `memory-constrained`.
- `[control]` × 3: pass.
- `[regression]` × 6: fail. The weak-profile cases fail at `expect(result.error).not.toBeNull()` because the action succeeds. The missing-profile cases also succeed, because serenity silently uses its default.

**Observed:** 7 passed, 6 failed (13), as expected. All 4 `[exploit]` tests pass: in sign-up (157 ms), change-password (329 ms) and reset-password (219 ms) the default client completed under the tampered weak profile, the payload builder ran once, the honest-profile sign-in returned `INVALID_CREDENTIALS`, and the weak-profile sign-in succeeded with the same export key. The offline-guess test logged `[F1] per-guess client cost: weak=0.5 ms, honest profile=103.6 ms`: the wrong guess failed, the right guess at the weak cost recovered the export key, and `memory-constrained` did not open the record. All 3 `[control]` tests pass (pinned client returns `KEY_STRETCHING_MISMATCH`, builder not called, no `/complete`). All 6 `[regression]` tests fail at `expect(result.error).not.toBeNull()` (`expected null not to be null`): the default client accepted both the weak profile and a challenge with `keyStretching` removed. The `memory-constrained` cost here (about 100 ms in Node) is lower than the "about a second" guessed above; the ratio to the weak profile is still about 200×.

### Recommended fix

1. Change `opaqueClient()` so that, by default, it accepts only registration profiles at or above a built-in floor. Use `rfc-recommended`, or a documented minimum `{ iterations, memory, parallelism }` that is never below `memory-constrained`. Weaker profiles need an explicit option, for example `opaqueClient({ registrationPolicy: { allow: [...] } })`.
2. Parse each challenge response with the contract schemas at runtime (`signUpChallengeResponseSchema.safeParse` etc.). Turn failures into a local `{ error }` result.
3. Do the check before `finishRegistration`, so the builder never runs and `/complete` is never called.
4. Keep `keyStretching` as the exact-pin option, but document the default floor.

### Regression test outline

For each of the three flows: tamper the profile to weak, drop it, or set it to a non-schema value. Assert that the action returns an error, the builder was not called, no `/complete` request was sent, and the action resolves rather than throws.

---

## F2 — High: password change revokes at most one page of sessions

### Evidence

- `plugin/src/server/change-password.ts:94-101`: `listSessions(userId)` is called once, the current token is filtered out, and only the returned tokens are passed to `deleteSessions`.
- `ba/db/internal-adapter.mjs:190-235`: on the plain database path, `findMany({ model: "session", where: userId })` runs with no explicit limit, and expired rows are included unless `onlyActiveSessions` is set.
- `core/db/adapter/factory.mjs:606-609`: `limit = unsafeLimit ?? defaultFindManyLimit ?? 100`. The memory adapter applies it (`@better-auth/memory-adapter/dist/index.mjs:280`). The Convex adapter applies it too (`cba/client/adapter.js:275-320`, per the static review).
- Contrast with reset, which is exhaustive: `plugin/src/server/reset-password.ts:185` calls `deleteUserSessions` (`ba/db/internal-adapter.mjs:535-570`, `deleteMany where userId`).
- Contrast with native Better Auth `changePassword`: it calls `deleteUserSessions` and then creates a new session for the caller (`ba/api/routes/update-user.mjs:173-180`).

### Preconditions

Either an attacker who knows the current password, or who holds a stolen session, created a session after at least 100 older session rows for the user, **or** the user simply has ≥ 100 stale or expired session rows. Expired rows count as well, and Convex never prunes them on its own [INFERENCE]. The victim then changes the password expecting other sessions to end (Radium: `docs/E2EE/Authentication.md:97`).

### Impact

The attacker's session stays valid after the change, so the session-gated payload and application data stay reachable. This breaks the plugin's documented promise ("Password change revokes the user's other sessions", `docs/security.md`).

### Test — `test/unit/zz-review-f2-session-revocation.test.ts`

```ts
import { beforeAll, describe, expect, test } from "vitest";
import {
  CHEAP_STRETCHING,
  createMemoryDb,
  createTestAuth,
  createTestClient,
  serverSetupForTests,
} from "./helpers.ts";

const EMAIL = "f2@example.com";
const OLD = "f2-old-password";
const NEW = "f2-new-password";

let serverSetup: string;
beforeAll(async () => {
  serverSetup = await serverSetupForTests();
});

async function setUp() {
  const db = createMemoryDb();
  const auth = createTestAuth({
    db,
    opaque: {
      serverSetup,
      keyStretching: CHEAP_STRETCHING,
      passwordReset: { url: (token) => `http://localhost:3000/reset?token=${token}` },
    },
  });
  const victim = createTestClient(auth);
  const signUp = await victim.authClient.signUp.opaque({ email: EMAIL, password: OLD, name: "F2" });
  expect(signUp.error).toBeNull();
  const userId = signUp.data!.user.id as string;
  const ctx = await auth.$context;
  const sessionsOf = () => db.session.filter((row) => row.userId === userId);
  return { db, auth, victim, userId, ctx, sessionsOf, victimToken: signUp.data!.token as string };
}

describe("F2 password change session revocation", () => {
  test(
    "[regression] a live session beyond the first 100 rows is revoked",
    { timeout: 60_000 },
    async () => {
      const { auth, victim, userId, ctx, sessionsOf } = await setUp();
      for (let i = 0; i < 100; i++) await ctx.internalAdapter.createSession(userId);
      const attacker = createTestClient(auth);
      expect(
        (await attacker.authClient.signIn.opaque({ email: EMAIL, password: OLD })).error,
      ).toBeNull();
      expect(sessionsOf()).toHaveLength(102);

      const changed = await victim.authClient.opaque.changePassword({
        currentPassword: OLD,
        newPassword: NEW,
      });
      expect(changed.error).toBeNull();
      expect((await victim.authClient.getSession()).data?.user.id).toBe(userId);

      console.log(
        `[F2] sessions left after change (100 live fillers): ${sessionsOf().length} (want 1)`,
      );
      expect((await attacker.authClient.getSession()).data).toBeNull();
      expect(sessionsOf()).toHaveLength(1);
    },
  );

  test(
    "[regression] expired rows ahead of one live attacker session also hide it",
    { timeout: 60_000 },
    async () => {
      const { auth, victim, userId, ctx, sessionsOf, victimToken } = await setUp();
      for (let i = 0; i < 120; i++) await ctx.internalAdapter.createSession(userId);
      for (const row of sessionsOf()) {
        if (row.token !== victimToken) row.expiresAt = new Date(Date.now() - 60_000);
      }
      const attacker = createTestClient(auth);
      expect(
        (await attacker.authClient.signIn.opaque({ email: EMAIL, password: OLD })).error,
      ).toBeNull();

      const changed = await victim.authClient.opaque.changePassword({
        currentPassword: OLD,
        newPassword: NEW,
      });
      expect(changed.error).toBeNull();

      const live = sessionsOf().filter(
        (row) => new Date(row.expiresAt as Date).getTime() > Date.now(),
      );
      console.log(
        `[F2] live sessions left after change (120 expired fillers): ${live.length} (want 1)`,
      );
      expect((await attacker.authClient.getSession()).data).toBeNull();
    },
  );

  test("[control] reset is exhaustive", { timeout: 60_000 }, async () => {
    const { auth, userId, ctx, sessionsOf } = await setUp();
    for (let i = 0; i < 150; i++) await ctx.internalAdapter.createSession(userId);
    const { url } = await auth.api.createPasswordResetToken({ body: { email: EMAIL } });
    const token = new URL(url).searchParams.get("token")!;
    const reset = await createTestClient(auth).authClient.opaque.resetPassword({
      token,
      newPassword: NEW,
    });
    expect(reset.error).toBeNull();
    expect(sessionsOf()).toHaveLength(0);
  });
});
```

### Expected output (written before the run)

- Test 1 fails. The log line should report 3 sessions left: the victim, the 101st filler and the attacker. The assertion `attacker getSession → null` fails.
- Test 2 fails: the attacker stays live.
- Test 3 (control) passes.

**Observed:** 1 passed, 2 failed (3), as expected. Test 1 logged `[F2] sessions left after change (100 live fillers): 3 (want 1)` and failed at `attacker getSession → null`: the attacker's session was returned with its user. Test 2 logged `[F2] live sessions left after change (120 expired fillers): 2 (want 1)` (the victim and the attacker) and failed the same way. Test 3 (reset with 150 extra sessions, control) passed: zero sessions left.

### Recommended fix

Use the native pattern: inside the credential-switch success path, call `internalAdapter.deleteUserSessions(userId)`, then `createSession(userId, …)` for the caller and `setSessionCookie` (as `ba/api/routes/update-user.mjs:173-180` does), and return the new token. If the current session must keep its token, page `listSessions` with an explicit `limit`/`offset` until it is empty, or delete with `where userId AND token ne current`. Raising the limit is not a fix. Run revocation even when `activatePayload` throws; that part is already correct.

### Regression test outline

Cover: more than 100 live sessions; a stale-row prefix; the secondary-storage configuration (`secondaryStorage` with and without `storeSessionInDatabase`); and the caller's session staying usable, or being replaced and returned, after the change.

---

## F3 — Medium: unbounded server-chosen work factor on every login derivation

### Evidence

- `plugin/src/client/index.ts:340-345` (sign-in), `:400-405` (password proof) and `:441-446` (change password, `loginKeyStretching`) pass the server value straight into the synchronous `client.finishLogin`.
- The pin from F1 is never applied to logins (`index.ts:31-38` documents "Sign-in always uses the profile the server stored").
- `plugin/src/contract.ts:157-161` has no maximum. Responses are not parsed at runtime (`index.ts:261`).
- Serenity: `rfc-recommended` already takes about 13 s and about 2 GiB. The authors note that 2^21 KiB crashed a browser (`README.md:249-270`). Custom parameters are "passed directly to the argon2id function"; invalid ones make it **throw** (`README.md:272-273`). The plugin does not catch that throw, so the action rejects instead of resolving `{ error }`.

### Preconditions

The backend is compromised, or a MITM sits in front of the auth origin. No authentication is needed: the user only has to try to sign in, unlock, prove the password for a 2FA change, or change the password.

### Impact

The tab blocks for an attacker-chosen time, or the WASM allocation fails (≥ 4 GiB is beyond wasm32) [INFERENCE: exact browser behaviour not exercised]. Radium's "Unlock" and sign-in become unusable. No secret leaks: the envelope still fails to open. This is availability only.

### Test — `test/unit/zz-review-f3-login-work-factor.test.ts`

```ts
import { client as opaqueProtocol, server as opaqueServer } from "@serenity-kit/opaque";
import { beforeAll, describe, expect, test } from "vitest";
import { keyStretchingSchema, type OpaqueKeyStretching } from "../../src/contract.ts";
import {
  CHEAP_STRETCHING,
  createMemoryDb,
  createTestAuth,
  createTestClient,
  serverSetupForTests,
} from "./helpers.ts";
import { completeCount, maliciousServer, timed } from "./zz-review-malicious-server.ts";

// Moderately raised: 64 MiB, 8 passes. Large enough to measure, small enough not to hang CI.
const RAISED: OpaqueKeyStretching = {
  "argon2id-custom": { iterations: 8, memory: 65536, parallelism: 1 },
};
const EMAIL = "f3@example.com";
const PASSWORD = "f3-password";

let serverSetup: string;
beforeAll(async () => {
  serverSetup = await serverSetupForTests();
});

async function setUp(pin?: OpaqueKeyStretching) {
  const auth = createTestAuth({
    db: createMemoryDb(),
    opaque: { serverSetup, keyStretching: CHEAP_STRETCHING },
  });
  const owner = createTestClient(auth);
  expect(
    (await owner.authClient.signUp.opaque({ email: EMAIL, password: PASSWORD, name: "F3" })).error,
  ).toBeNull();
  const evil = maliciousServer(auth, (path, body) => {
    if (path === "/sign-in/opaque/challenge" || path === "/opaque/password-proof/challenge") {
      return { ...body, keyStretching: RAISED };
    }
    if (path === "/opaque/change-password/challenge")
      return { ...body, loginKeyStretching: RAISED };
    return undefined;
  });
  return { auth, owner, evil, pin };
}

describe("F3 login derivations accept any server work factor", () => {
  test("[exploit] the contract has no upper bound", () => {
    const absurd = {
      "argon2id-custom": { iterations: 2 ** 32, memory: 2 ** 32, parallelism: 2 ** 24 },
    };
    expect(keyStretchingSchema.safeParse(absurd).success).toBe(true);
  });

  test(
    "[exploit] derivation time scales with server-chosen iterations",
    { timeout: 120_000 },
    async () => {
      const rows: string[] = [];
      let first = 0;
      let last = 0;
      for (const iterations of [1, 2, 4, 8]) {
        const login = opaqueProtocol.startLogin({ password: "x" });
        const { loginResponse } = opaqueServer.startLogin({
          serverSetup,
          userIdentifier: "f3-fake",
          registrationRecord: null,
          startLoginRequest: login.startLoginRequest,
        });
        const started = performance.now();
        opaqueProtocol.finishLogin({
          clientLoginState: login.clientLoginState,
          loginResponse,
          password: "x",
          keyStretching: { "argon2id-custom": { iterations, memory: 65536, parallelism: 1 } },
        });
        const ms = performance.now() - started;
        if (iterations === 1) first = ms;
        last = ms;
        rows.push(`t=${iterations}: ${ms.toFixed(0)} ms`);
      }
      console.log(`[F3] 64 MiB Argon2id finishLogin: ${rows.join(", ")}`);
      expect(last).toBeGreaterThan(first * 3);
    },
  );

  test(
    "[exploit] sign-in derives with RAISED even on a pinned client, then fails locally",
    { timeout: 120_000 },
    async () => {
      const { auth, evil } = await setUp();
      const honest = await timed(() =>
        createTestClient(auth, { keyStretching: CHEAP_STRETCHING }).authClient.signIn.opaque({
          email: EMAIL,
          password: PASSWORD,
        }),
      );
      expect(honest.result.error).toBeNull();
      const pinned = createTestClient(evil, { keyStretching: CHEAP_STRETCHING });
      const attacked = await timed(() =>
        pinned.authClient.signIn.opaque({ email: EMAIL, password: PASSWORD }),
      );
      console.log(
        `[F3] sign-in: honest ${honest.ms.toFixed(0)} ms, raised ${attacked.ms.toFixed(0)} ms`,
      );
      expect(attacked.result.error?.code).toBe("INVALID_CREDENTIALS");
      expect(completeCount(pinned, "/sign-in/opaque/complete")).toBe(0);
      expect(attacked.ms).toBeGreaterThan(honest.ms);
    },
  );

  test(
    "[exploit] password proof and change-password derive with RAISED",
    { timeout: 120_000 },
    async () => {
      const { evil } = await setUp();
      const browser = createTestClient(evil, { keyStretching: CHEAP_STRETCHING });
      // Sign-in through the evil front would be slowed too; sign in honestly via sign-up of a 2nd user.
      expect(
        (
          await browser.authClient.signUp.opaque({
            email: "f3b@example.com",
            password: PASSWORD,
            name: "F3b",
          })
        ).error,
      ).toBeNull();
      const proof = await timed(() =>
        browser.authClient.opaque.createPasswordProof({ password: PASSWORD }),
      );
      const change = await timed(() =>
        browser.authClient.opaque.changePassword({
          currentPassword: PASSWORD,
          newPassword: "f3-new",
        }),
      );
      console.log(
        `[F3] password proof ${proof.ms.toFixed(0)} ms, change-password ${change.ms.toFixed(0)} ms`,
      );
      expect(proof.result.error?.code).toBe("INVALID_PASSWORD");
      expect(change.result.error?.code).toBe("INVALID_PASSWORD");
    },
  );

  test(
    "[regression] a client refuses an out-of-policy login profile before deriving",
    { timeout: 120_000 },
    async () => {
      const { evil } = await setUp();
      const pinned = createTestClient(evil, { keyStretching: CHEAP_STRETCHING });
      const attacked = await timed(() =>
        pinned.authClient.signIn.opaque({ email: EMAIL, password: PASSWORD }),
      );
      // Refused by policy, not "derived for seconds and failed as a wrong password".
      expect(attacked.result.error?.code).toBe("KEY_STRETCHING_MISMATCH");
      expect(completeCount(pinned, "/sign-in/opaque/complete")).toBe(0);
    },
  );

  test(
    "[regression] an invalid Argon2 parameter set resolves to { error } instead of throwing",
    { timeout: 60_000 },
    async () => {
      const { auth } = await setUp();
      const broken = maliciousServer(auth, (path, body) =>
        path === "/sign-in/opaque/challenge"
          ? {
              ...body,
              keyStretching: { "argon2id-custom": { iterations: 1, memory: 1, parallelism: 1 } },
            }
          : undefined,
      );
      const result = await createTestClient(broken).authClient.signIn.opaque({
        email: EMAIL,
        password: PASSWORD,
      });
      expect(result.error).not.toBeNull();
    },
  );
});
```

In the proof/change test, the second user registers through `evil`. Sign-up challenges are not rewritten, so that user's session is honest. Only the proof and change challenges are raised.

### Expected output (written before the run)

- `[exploit]` tests pass. Logs should show roughly linear scaling with `t`, and the raised sign-in taking about the t=8 time against a few ms honest.
- First `[regression]` fails: the code is `INVALID_CREDENTIALS`.
- Second `[regression]`: [INFERENCE] serenity throws on `memory: 1` (Argon2 needs ≥ 8·p KiB), and the action **rejects**, failing the test with an uncaught error. If serenity accepts the value, the test fails on `INVALID_CREDENTIALS` instead.

**Observed:** 4 passed, 2 failed (6), as expected. The raised profile was kept at 64 MiB and 8 passes (a few hundred ms). Timings:

- `[F3] 64 MiB Argon2id finishLogin: t=1: 38 ms, t=2: 66 ms, t=4: 131 ms, t=8: 257 ms`: linear in the server-chosen iterations.
- `[F3] sign-in: honest 6 ms, raised 265 ms`: a client pinned to `CHEAP_STRETCHING` still derived with the raised login profile, then failed locally with `INVALID_CREDENTIALS` and sent no `/sign-in/opaque/complete`.
- `[F3] password proof 276 ms, change-password 276 ms`: both derived with the raised profile and returned `INVALID_PASSWORD`.
- The contract test confirmed that `iterations 2^32, memory 2^32, parallelism 2^24` passes `keyStretchingSchema`.
- First `[regression]`: `expected 'INVALID_CREDENTIALS' to be 'KEY_STRETCHING_MISMATCH'`.
- Second `[regression]`: the action **rejected** with `Error: Internal error at "Invalid keyStretching (argon2id) combination"; Computing the key stretching function failed`, thrown from serenity `finishClientLogin`. This confirms the [INFERENCE] above: the plugin does not catch it.

### Recommended fix

- Add a client policy: `opaqueClient({ loginPolicy: { allow: ["rfc-recommended", …], max: { iterations, memory, parallelism } } })`, with safe defaults. Enforce it before every `finishLogin`, and also for `loginKeyStretching`.
- Return `KEY_STRETCHING_MISMATCH` (or a new `KEY_STRETCHING_REJECTED`) as a local error.
- Wrap all serenity calls in `try/catch` and map failures to local errors.
- Add an optional Web Worker mode for derivation. It isolates the UI but is not a substitute for bounds.

### Regression test outline

For each of sign-in, proof and change: an above-maximum profile, a malformed profile and a missing profile. Assert a fast local error and no `/complete` request. Also check that a legitimately stored older profile inside the allowlist still works.

---

## F4 — Medium: pending second factor survives a reset or change

### Evidence

- `plugin/src/server/sign-in.ts:111-116,146-151` delegates to the installed two-factor hook.
- `plugin/src/server/two-factor.ts:109-118` binds only the **payload token** to the credential version.
- Native `better-auth/dist/plugins/two-factor/index.mjs:342-355` stores `2fa-<random>` with `value: user.id` only. `verify-two-factor.mjs` (the `valid` closure) consumes it and calls `createSession(consumed.value)` with no credential check.
- Reset and change revoke sessions only (`reset-password.ts:185`, `change-password.ts:94-101`).
- Documented as residual in `plugin/docs/security.md` ("Pending 2FA across a reset").
- **Already asserted by the repository's own test** at `test/unit/two-factor.test.ts:285-308`: `verifyTotp` succeeds after the reset, and only `loadSignInPayload` returns `CREDENTIAL_CHANGED`.

### Preconditions

The attacker knows the old password and has the second factor (TOTP secret, backup code, or OTP channel). They start the sign-in within `twoFactorCookieMaxAge` (default 600 s) before the victim's recovery.

### Impact

After a reset meant to evict the attacker, the attacker gets a fresh, valid session. The E2EE payload is withheld, but every session-authorized server action is available. This is not a 2FA bypass.

### Test — `test/unit/zz-review-f4-pending-2fa.test.ts`

```ts
import { base32 } from "@better-auth/utils/base32";
import { createOTP } from "@better-auth/utils/otp";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { twoFactor } from "better-auth/plugins";
import { describe, expect, test } from "vitest";
import { opaque } from "../../src/server/index.ts";
import {
  BASE_URL,
  CHEAP_STRETCHING,
  createMemoryDb,
  createPayloadApp,
  createTestClient,
  SECRET,
  serverSetupForTests,
  type TestClient,
} from "./helpers.ts";

const EMAIL = "f4@example.com";
const PASSWORD = "f4-old-password";

async function totp(uri: string): Promise<string> {
  return createOTP(base32.decode(new URL(uri).searchParams.get("secret")!)).totp();
}

async function fixture() {
  const db = { ...createMemoryDb(), twoFactor: [] };
  const app = createPayloadApp();
  const auth = betterAuth({
    baseURL: BASE_URL,
    secret: SECRET,
    database: memoryAdapter(db),
    rateLimit: { enabled: false },
    logger: { disabled: true },
    plugins: [
      twoFactor({ allowPasswordless: true }),
      opaque({
        serverSetup: await serverSetupForTests(),
        keyStretching: CHEAP_STRETCHING,
        hooks: app.hooks,
        passwordReset: { url: (token) => `https://example.com/reset?token=${token}` },
      }),
    ],
  });
  const owner = createTestClient(auth);
  expect(
    (
      await owner.authClient.signUp.opaque({
        email: EMAIL,
        password: PASSWORD,
        name: "F4",
        payload: { tag: "old" },
      })
    ).error,
  ).toBeNull();
  const proof = await owner.authClient.opaque.createPasswordProof({ password: PASSWORD });
  const enabled = await owner.authClient.twoFactor.enable({ password: proof.data!.proof });
  const uri = (enabled.data as { totpURI: string }).totpURI;
  expect((await owner.authClient.twoFactor.verifyTotp({ code: await totp(uri) })).error).toBeNull();
  return { auth, owner, uri };
}

async function startPending(attacker: TestClient) {
  const pending = await attacker.authClient.signIn.opaque({ email: EMAIL, password: PASSWORD });
  expect(pending.error).toBeNull();
  expect(pending.data?.twoFactorRedirect).toBe(true);
}

async function replaceByReset(auth: Awaited<ReturnType<typeof fixture>>["auth"]) {
  const { url } = await auth.api.createPasswordResetToken({ body: { email: EMAIL } });
  const token = new URL(url).searchParams.get("token")!;
  const reset = await createTestClient(auth).authClient.opaque.resetPassword({
    token,
    newPassword: "f4-reset-password",
    payload: { tag: "new" },
  });
  expect(reset.error).toBeNull();
}

describe("F4 pending second factor across credential replacement", () => {
  test("[exploit] reset: the pending 2FA sign-in still mints a session", async () => {
    const { auth, uri } = await fixture();
    const attacker = createTestClient(auth);
    await startPending(attacker);
    await replaceByReset(auth);
    expect(
      (await attacker.authClient.twoFactor.verifyTotp({ code: await totp(uri) })).error,
    ).toBeNull();
    expect((await attacker.authClient.getSession()).data?.user.email).toBe(EMAIL);
  });

  test("[regression] reset: completing the old pending 2FA sign-in is refused", async () => {
    const { auth, uri } = await fixture();
    const attacker = createTestClient(auth);
    await startPending(attacker);
    await replaceByReset(auth);
    const verified = await attacker.authClient.twoFactor.verifyTotp({ code: await totp(uri) });
    expect(verified.error).not.toBeNull();
    expect((await attacker.authClient.getSession()).data).toBeNull();
  });

  test("[regression] change-password: completing the old pending 2FA sign-in is refused", async () => {
    const { auth, owner, uri } = await fixture();
    const attacker = createTestClient(auth);
    await startPending(attacker);
    const changed = await owner.authClient.opaque.changePassword({
      currentPassword: PASSWORD,
      newPassword: "f4-changed",
    });
    expect(changed.error).toBeNull();
    const verified = await attacker.authClient.twoFactor.verifyTotp({ code: await totp(uri) });
    expect(verified.error).not.toBeNull();
    expect((await attacker.authClient.getSession()).data).toBeNull();
  });
});
```

### Expected output (written before the run)

The `[exploit]` test passes (consistent with the existing `two-factor.test.ts:285-308`). Both `[regression]` tests fail at `verified.error not null`.

**Observed:** 1 passed, 2 failed (3), as expected. `[exploit]` passed: after the reset, the attacker's `verifyTotp` returned no error and `getSession` returned the victim's email. Both `[regression]` tests (reset and change-password) failed at `expect(verified.error).not.toBeNull()` (`expected null not to be null`).

### Recommended fix

- When the 2FA redirect is issued (`two-factor.ts`, the after-hook that already mints the `payloadToken`), record a plugin-owned marker keyed by the native `2fa-*` identifier: `{ userId, credentialVersion }`.
- Add a `before` hook on the native verify paths (`/two-factor/verify-totp`, `/verify-otp`, `/verify-backup-code`). It reads the signed two-factor cookie, loads the marker, and rejects (consuming the native marker) if the account's credential version changed.
- Add a post-create re-check that deletes the new session if a switch raced in, mirroring `sign-in.ts:134-142`.
- Alternatively, keep a per-user "credential epoch" and delete all `2fa-*` rows of the user on switch. That needs an adapter query by `value`, so it is less clean.
- Update `docs/security.md`.

### Regression test outline

Cover reset, change, and change racing the verify (pause in `commitPayload`), for TOTP, OTP and backup codes.

---

## F5 — Medium: reset tokens are not bound to the credential version and are not invalidated by a switch

### Evidence

- `plugin/src/server/reset-password.ts:23,91`: the token value is `{ userId }` only.
- `:46-47`: `findResetTarget` resolves the **current** credential at use time.
- `:141-146`: only the presented token is consumed.
- `credential.ts:135-218` (`replaceCredential`) never deletes other `opaque:reset-token:*` rows. No API exists to revoke a user's reset tokens.

### Preconditions

More than one reset link exists. The case that matters is an operator re-issuing a link (Radium's CLI flow, `docs/E2EE/Authentication.md:101-116`), or a link leaked by email or chat. Alternatively, a link exists and the user then changes the password.

### Impact

After the user has recovered (and the new key bundle exists), an earlier link still lets its holder:

- read the **new** credential's payload through `/reset/opaque/verify` (ciphertext only, if I1 holds);
- reset the password again, taking over the login and revoking the user's sessions.

This holds until the token expires (default 1 h). In Radium, data confidentiality survives because the attacker gets new, empty keys and contacts see a key change. Account availability and login integrity do not.

### Test — `test/unit/zz-review-f5-reset-token-binding.test.ts`

```ts
import { beforeAll, describe, expect, test } from "vitest";
import {
  CHEAP_STRETCHING,
  createMemoryDb,
  createPayloadApp,
  createTestAuth,
  createTestClient,
  serverSetupForTests,
} from "./helpers.ts";

const EMAIL = "f5@example.com";
const PASSWORD = "f5-password";

let serverSetup: string;
beforeAll(async () => {
  serverSetup = await serverSetupForTests();
});

async function setUp() {
  const app = createPayloadApp();
  const auth = createTestAuth({
    db: createMemoryDb(),
    opaque: {
      serverSetup,
      keyStretching: CHEAP_STRETCHING,
      hooks: app.hooks,
      passwordReset: { url: (token) => `http://localhost:3000/reset?token=${token}` },
    },
  });
  const owner = createTestClient(auth);
  expect(
    (
      await owner.authClient.signUp.opaque({
        email: EMAIL,
        password: PASSWORD,
        name: "F5",
        payload: { tag: "v1" },
      })
    ).error,
  ).toBeNull();
  const issue = async () => {
    const { url } = await auth.api.createPasswordResetToken({ body: { email: EMAIL } });
    return new URL(url).searchParams.get("token")!;
  };
  return { auth, owner, issue };
}

describe("F5 reset tokens across credential switches", () => {
  test("[regression] completing one reset invalidates other outstanding reset links", async () => {
    const { auth, issue } = await setUp();
    const older = await issue();
    const used = await issue();
    const recovered = await createTestClient(auth).authClient.opaque.resetPassword({
      token: used,
      newPassword: "f5-recovered",
      payload: { tag: "v2" },
    });
    expect(recovered.error).toBeNull();

    const peek = await createTestClient(auth).authClient.opaque.verifyResetToken({ token: older });
    console.log(`[F5] stale link verify after reset: ${JSON.stringify(peek.data ?? peek.error)}`);
    // Soft assertions so the takeover attempt is still exercised when the peek check fails.
    expect.soft(peek.error?.code).toBe("INVALID_RESET_TOKEN");
    const takeover = await createTestClient(auth).authClient.opaque.resetPassword({
      token: older,
      newPassword: "f5-attacker",
    });
    console.log(`[F5] stale link reset after recovery: error=${JSON.stringify(takeover.error)}`);
    expect.soft(takeover.error?.code).toBe("INVALID_RESET_TOKEN");
  });

  test("[regression] a password change invalidates outstanding reset links", async () => {
    const { auth, owner, issue } = await setUp();
    const token = await issue();
    expect(
      (
        await owner.authClient.opaque.changePassword({
          currentPassword: PASSWORD,
          newPassword: "f5-changed",
          payload: { tag: "v2" },
        })
      ).error,
    ).toBeNull();
    const peek = await createTestClient(auth).authClient.opaque.verifyResetToken({ token });
    console.log(`[F5] link verify after change: ${JSON.stringify(peek.data ?? peek.error)}`);
    expect(peek.error?.code).toBe("INVALID_RESET_TOKEN");
  });
});
```

### Expected output (written before the run)

Both tests fail. The logs should show `{"payload":{"tag":"v2"}}`, which means the stale link reveals the **new** payload. In test 1 the takeover reset succeeds.

**Observed:** 0 passed, 2 failed (2), as expected. Test 1 logged `[F5] stale link verify after reset: {"payload":{"tag":"v2"}}` and `[F5] stale link reset after recovery: error=null`: the older link revealed the **new** payload and then reset the password again. Both soft assertions failed (`expected undefined to be 'INVALID_RESET_TOKEN'`). Test 2 logged `[F5] link verify after change: {"payload":{"tag":"v2"}}` and failed the same way.

### Recommended fix

1. Store `{ userId, credentialVersion }` at issuance and reject in `findResetTarget` on mismatch. This alone invalidates every older link after any switch.
2. Also expose a server-only `revokePasswordResetTokens({ userId })`. Index reset rows by a per-user identifier prefix, or keep a per-user list.
3. Document that issuing a new link does not revoke older ones unless `revokePrevious: true` is passed.

### Regression test outline

The two tests above, plus: "issue A, issue B, use B → A fails".

---

## F6 — Low: known vs unknown email timing in the sign-in challenge ([static])

### Evidence

- `plugin/src/server/sign-in.ts:40-43` calls `findUserByEmail(email, { includeAccounts: true })`.
- Without `advanced.database.joins`, the adapter factory performs the account join itself after the user lookup (`core/db/adapter/factory.mjs:576,592`). `handleFallbackJoin` returns early when there is no user row (`factory.mjs:349-350`). A **known email therefore costs one extra adapter query.**
- On Convex, each adapter call from the HTTP action is a separate component query [INFERENCE: one round trip, on the order of milliseconds, measurable with enough samples].
- On the unknown path, serenity's `startLogin(…, registrationRecord: null)` generates a dummy record. Whether that costs the same as the real path was not measured.

### Impact

Statistical account enumeration through the sign-in challenge. The email-existence oracle is already public through default sign-up (422, see Other checks), so this matters only once sign-up is made non-disclosing.

### Measurement harness

The timing test is in `zz-review-misc.test.ts` below. It uses the memory adapter, which **under-represents** Convex. For a meaningful result, run it against the plugin's Convex test backend (`bun run test:convex` setup) [not executed].

**Observed (memory adapter, 280 samples each after 20 warm-up):** `[F6] known: p10=0.912 p50=1.006 p90=1.186 ms | unknown: p10=0.845 p50=0.954 p90=1.126 ms`. The known email is about 0.05 ms slower at every percentile, which is within noise on an in-memory adapter: **not reproduced** here. The static finding about the extra adapter query on Convex stands and remains unmeasured.

### Recommended fix

On a miss, perform the same account read, for example `findAccounts(fakeIdentifierDerivedUserId)` or `findAccountByKey({ providerId: "opaque", accountId: fakeIdentifier })`. Better: look up the credential with a single indexed query that runs on both paths. Document a measured bound rather than claiming equality.

---

## F7 — Low: OPAQUE first-login endpoints lack Fetch-Metadata/Origin CSRF validation

### Evidence

- The global `originCheckMiddleware` validates `Origin` only when a cookie is present (`ba/api/middlewares/origin-check.mjs`, `validateOrigin`: `if (!(forceValidate || useCookies)) return`).
- Native `/sign-in/email` and `/sign-up/email` add `formCsrfMiddleware`, which forces validation when `Origin`, `Referer` or `Sec-Fetch-*` is present (`ba/api/routes/sign-in.mjs:243`, `sign-up.mjs:26`).
- The OPAQUE endpoints have no `use` for this (`plugin/src/server/sign-in.ts`, `sign-up.ts`, `reset-password.ts`).
- In the plugin's tests, `skipOriginCheck` defaults to `true` under `isTest()` (`ba/context/create-context.mjs:211`), so origin behaviour is never exercised.

### Impact

Login CSRF (signing a victim into the attacker's account) through cross-site requests is mostly blocked anyway: the endpoints accept only `application/json` (`ba/api/index.mjs`, `allowedMediaTypes`), which forces a CORS preflight. Radium's `http.ts` registers routes without CORS. This is defence-in-depth and parity with native routes.

### Test

In `zz-review-misc.test.ts` (`F7 [regression]`). Expected: native returns 403, OPAQUE returns 200, so the test fails.

**Observed:** failed as expected. Log: `[F7] evil origin: native 403, opaque challenge 200`; assertion `expected 200 to be 403`.

### Fix

Add `use: [formCsrfMiddleware]` to `signInOpaqueChallenge/Complete`, `signUpOpaqueChallenge/Complete` and `resetOpaque*`. Add a test suite with `advanced: { disableOriginCheck: false }`.

---

## F8 — Low: OPAQUE sign-up ignores `emailAndPassword.enabled` / `disableSignUp`

### Evidence

Native sign-up rejects `EMAIL_PASSWORD_SIGN_UP_DISABLED` (`ba/api/routes/sign-up.mjs:145-148`). `plugin/src/server/sign-up.ts` has no equivalent check (no `disableSignUp` match in `plugin/src`).

### Impact

An operator who closes registration through Better Auth's flag still has an open OPAQUE sign-up. Radium leaves sign-up open today, so this is a configuration trap rather than a vulnerability.

### Test

In `zz-review-misc.test.ts`. Expected: the regression fails because OPAQUE sign-up succeeds.

**Observed:** failed as expected. Log: `[F8] native 400, opaque error null`; assertion `expected null not to be null`.

### Fix

Add `opaque({ disableSignUp?: boolean })`, defaulting to the native flag, or document that `disabledPaths` must list both OPAQUE sign-up paths.

---

## Other checks (no finding)

| Check                         | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Evidence                                                                                                                                                                                   |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `loadPayload` throws          | **Fails closed.** Sign-in (no 2FA) loads the payload **before** creating a session (`sign-in.ts:120-131`), so no session is created and the state is consumed. With 2FA, the after-hook deletes the new session and its cookie (`two-factor.ts:140-145`). Reset verify propagates the error. A non-`APIError` becomes HTTP 500 with an **empty body** (`call/router.mjs:83-97`), and the message goes only to server logs (`console.error("# SERVER_ERROR: ", error)`). Radium: those logs land in Convex logs, so keep hook errors free of secrets.       | test `M4` in misc: **passed** (sign-in 500, no hook message in the body, no session; reset verify 500, no hook message; the message appears only in the server-side `# SERVER_ERROR:` log) |
| Error message contents        | OPAQUE codes are static and generic (`contract.ts:43-128`). Sign-in failures converge on `INVALID_CREDENTIALS`. Non-API validation errors are normalized to `INVALID_PAYLOAD` (`credential.ts:101-118`). App-thrown `APIError`s are forwarded verbatim by design (I5).                                                                                                                                                                                                                                                                                     | [static]                                                                                                                                                                                   |
| Sign-up for an existing email | Default 422 `USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL` at the **challenge** (`sign-up.ts:40-46`), mirroring native behaviour. It never attaches to the existing user, including a user who has a classic `credential` account. Covered by the existing `flows.test.ts:291-318`; test `M3` adds the classic-account case.                                                                                                                                                                                                                                      | existing test plus `M3`: **passed**                                                                                                                                                        |
| Cookie-cache revocation lag   | Not applicable under Convex: the `convex()` plugin forcibly disables `session.cookieCache` (`cba/plugins/convex/index.js:169-171`). The Convex JWT lives 15 min (`index.js:36`), but `authComponent.getAuthUser` re-checks the session row (`cba/client/create-client.js:157-174`), and Radium production code uses it (`convex/keys.ts:430`, `helpers.ts:32`, `aisdk.ts`, …). Only code that trusts `ctx.auth.getUserIdentity()` alone keeps access until the JWT expires (Radium: worker identity in `src/worker/machine.ts:35`, a different principal). | [static]                                                                                                                                                                                   |
| Adapters without `consumeOne` | `consumeVerificationValue` falls back to `findOne` plus a snapshot-guarded `deleteMany` that must affect exactly one row (`core/db/adapter/factory.mjs:731-739`, `core/db/adapter/atomic-fallback.mjs` `consumeOne`). It runs under an in-process lock and a transaction where available (`ba/db/internal-adapter.mjs:838-905`). It stays single-use as long as the adapter's `deleteMany` returns accurate affected counts. The Convex adapter consumes natively in one mutation (static review).                                                         | [static]                                                                                                                                                                                   |
| Origin checks                 | See F7. Session-bound endpoints (change, proof, payload) always carry cookies, so `Origin` is validated.                                                                                                                                                                                                                                                                                                                                                                                                                                                   | [static]                                                                                                                                                                                   |

### Misc test file — `test/unit/zz-review-misc.test.ts`

```ts
import { client as opaqueProtocol } from "@serenity-kit/opaque";
import { beforeAll, describe, expect, test } from "vitest";
import {
  CHEAP_STRETCHING,
  createMemoryDb,
  createPayloadApp,
  createTestAuth,
  createTestClient,
  postJson,
  serverSetupForTests,
} from "./helpers.ts";

let serverSetup: string;
beforeAll(async () => {
  serverSetup = await serverSetupForTests();
});

const loginRequest = () => opaqueProtocol.startLogin({ password: "x" }).startLoginRequest;

describe("F7 origin / CSRF on first-login endpoints", () => {
  test("[regression] a cross-site Origin without cookies is rejected like native sign-in", async () => {
    const auth = createTestAuth({
      db: createMemoryDb(),
      opaque: { serverSetup, keyStretching: CHEAP_STRETCHING },
      options: { emailAndPassword: { enabled: true }, advanced: { disableOriginCheck: false } },
    });
    const evil = { origin: "https://evil.example" };
    const native = await postJson(
      auth,
      "/sign-in/email",
      { email: "a@example.com", password: "whatever-123" },
      evil,
    );
    const challenge = await postJson(
      auth,
      "/sign-in/opaque/challenge",
      { email: "a@example.com", loginRequest: loginRequest() },
      evil,
    );
    console.log(`[F7] evil origin: native ${native.status}, opaque challenge ${challenge.status}`);
    expect(native.status).toBe(403);
    expect(challenge.status).toBe(403);
  });
});

describe("F8 sign-up switches", () => {
  test("[regression] OPAQUE sign-up honours emailAndPassword.disableSignUp", async () => {
    const auth = createTestAuth({
      db: createMemoryDb(),
      opaque: { serverSetup, keyStretching: CHEAP_STRETCHING },
      options: { emailAndPassword: { enabled: true, disableSignUp: true } },
    });
    const native = await postJson(auth, "/sign-up/email", {
      email: "n@example.com",
      password: "password-123",
      name: "N",
    });
    const result = await createTestClient(auth).authClient.signUp.opaque({
      email: "o@example.com",
      password: "pw",
      name: "O",
    });
    console.log(`[F8] native ${native.status}, opaque error ${JSON.stringify(result.error)}`);
    expect(native.status).toBe(400);
    expect(result.error).not.toBeNull();
  });
});

describe("M3 classic credential accounts (migration capability gap)", () => {
  test("[control] a classic user can neither sign up, sign in, change, nor reset via OPAQUE", async () => {
    const db = createMemoryDb();
    const auth = createTestAuth({
      db,
      opaque: {
        serverSetup,
        keyStretching: CHEAP_STRETCHING,
        passwordReset: { url: (token) => `http://localhost:3000/reset?token=${token}` },
      },
      options: { emailAndPassword: { enabled: true } },
    });
    const email = "classic@example.com";
    expect(
      (await postJson(auth, "/sign-up/email", { email, password: "classic-password-1", name: "C" }))
        .status,
    ).toBe(200);

    const signUp = await createTestClient(auth).authClient.signUp.opaque({
      email,
      password: "new-pw",
      name: "C",
    });
    expect(signUp.error?.status).toBe(422);
    expect(db.account.filter((row) => row.providerId === "opaque")).toHaveLength(0);

    const signIn = await createTestClient(auth).authClient.signIn.opaque({
      email,
      password: "classic-password-1",
    });
    expect(signIn.error?.code).toBe("INVALID_CREDENTIALS");

    const classic = createTestClient(auth);
    expect(
      (await classic.authClient.signIn.email({ email, password: "classic-password-1" })).error,
    ).toBeNull();
    const attach = await classic.authClient.opaque.changePassword({
      currentPassword: "classic-password-1",
      newPassword: "new-pw",
    });
    expect(attach.error?.code).toBe("OPAQUE_ACCOUNT_NOT_FOUND");

    await expect(auth.api.createPasswordResetToken({ body: { email } })).rejects.toThrow(
      /User not found/,
    );
  });
});

describe("M4 loadPayload failures fail closed without leaking", () => {
  test("[control] sign-in and reset verify return 500 with no hook message and no session", async () => {
    const app = createPayloadApp();
    const auth = createTestAuth({
      db: createMemoryDb(),
      opaque: {
        serverSetup,
        keyStretching: CHEAP_STRETCHING,
        hooks: app.hooks,
        passwordReset: { url: (token) => `http://localhost:3000/reset?token=${token}` },
      },
    });
    const email = "m4@example.com";
    expect(
      (
        await createTestClient(auth).authClient.signUp.opaque({
          email,
          password: "pw-m4",
          name: "M4",
          payload: { tag: "x" },
        })
      ).error,
    ).toBeNull();
    app.faults.add("loadPayload");

    const browser = createTestClient(auth);
    const signIn = await browser.authClient.signIn.opaque({ email, password: "pw-m4" });
    expect(signIn.error?.status).toBe(500);
    expect(JSON.stringify(signIn.error)).not.toContain("injected failure");
    expect((await browser.authClient.getSession()).data).toBeNull();

    const { url } = await auth.api.createPasswordResetToken({ body: { email } });
    const token = new URL(url).searchParams.get("token")!;
    const verify = await postJson(auth, "/reset/opaque/verify", { token });
    expect(verify.status).toBe(500);
    expect(JSON.stringify(verify.body)).not.toContain("injected failure");
  });
});

describe("F6 timing harness (measurement only; memory adapter under-represents Convex)", () => {
  test("sign-in challenge latency: known vs unknown email", { timeout: 180_000 }, async () => {
    const auth = createTestAuth({
      db: createMemoryDb(),
      opaque: { serverSetup, keyStretching: CHEAP_STRETCHING },
    });
    expect(
      (
        await createTestClient(auth).authClient.signUp.opaque({
          email: "known@example.com",
          password: "pw-known",
          name: "K",
        })
      ).error,
    ).toBeNull();
    const sample = async (email: string) => {
      const request = loginRequest();
      const started = performance.now();
      const response = await postJson(auth, "/sign-in/opaque/challenge", {
        email,
        loginRequest: request,
      });
      const ms = performance.now() - started;
      expect(response.status).toBe(200);
      return ms;
    };
    const known: number[] = [];
    const unknown: number[] = [];
    for (let i = 0; i < 300; i++) {
      known.push(await sample("known@example.com"));
      unknown.push(await sample(`unknown-${i}@example.com`));
    }
    const stats = (xs: number[]) => {
      const sorted = xs.slice(20).sort((a, b) => a - b);
      const q = (p: number) => sorted[Math.floor(p * (sorted.length - 1))]!.toFixed(3);
      return `p10=${q(0.1)} p50=${q(0.5)} p90=${q(0.9)} ms`;
    };
    console.log(`[F6] known: ${stats(known)} | unknown: ${stats(unknown)}`);
  });
});
```

`M3` and `M4` are `[control]` tests. They document current behaviour that Radium depends on. M3 is the evidence for missing capabilities 1 and 2.

---

## Missing capabilities

### 1. Attach an OPAQUE credential to an existing classic account (Radium migration)

Radium's plan (`docs/E2EE/Authentication.md:137-146`): a classic sign-in lands on "Set up encryption". The user picks a **new** password, and one call stores the record and key bundle and deletes the classic `credential` account. The plugin has no such path today: sign-up refuses existing emails, and change/proof/reset require an OPAQUE account (test M3).

**Proposed endpoints** (same style as change-password; `scope: "server"`; rate-limited like registration):

```
POST /opaque/attach/challenge     use: [sensitiveSessionMiddleware]
  body  { registrationRequest, currentPassword?: string }
  200   { stateId, registrationResponse, keyStretching, serverIdentifier? }
POST /opaque/attach/complete      use: [sensitiveSessionMiddleware]
  body  { stateId, registrationRecord, payload? }
  200   { status: true, token }      // reissued current session (see below)
client: authClient.opaque.attachCredential({ newPassword, currentPassword?, payload, fetchOptions })
server option: opaque({ attach?: { requireFreshSession?: number /*s*/, requireClassicPassword?: boolean,
                                   removeClassicCredential?: boolean /*default true*/ } })
```

Semantics:

- **Authorization.** Require a store-backed session that is **fresh** (`session.createdAt` within `requireFreshSession`, e.g. 10 min) **or** a re-proof of the classic password. The classic password is verified server-side with `ctx.context.password.verify` against the `credential` account. That is acceptable here because the backend already knows the old password. The challenge fails with `OPAQUE_ACCOUNT_EXISTS` when the user already has an `opaque` account.
- **State** binds `userId`, a freshly minted `credentialId`, the session token, the classic account id and its `updatedAt` / password-hash fingerprint (compare-and-set input), and the profile. Five-minute expiry, single use.
- **Complete order** (no transactions on Convex):
  1. Check that no OPAQUE account exists and the classic fingerprint is unchanged.
  2. `validatePayload({ flow: "attach", userId })`.
  3. `commitPayload({ credentialVersion: v1, flow: "attach" })`.
  4. `createAccount({ providerId: "opaque", accountId: credentialId, … })`.
  5. **Post-create re-check**: if the user now has more than one `opaque` row, delete this one and fail with `CREDENTIAL_CHANGED`. This is the compare-and-set for "first credential wins".
  6. `activatePayload({ previousCredentialVersion: null, flow: "attach" })`.
  7. If `removeClassicCredential`, call `deleteAccount(classic.id)`.
  8. Revoke **all** sessions exhaustively (see F2) and issue a new session for the caller.
  9. Fire `onCredentialChanged` (capability 4).
- **Failure ordering.** If a failure happens before step 4, nothing changes. Between steps 4 and 7, the user has both credentials. The classic one must still only open the migration screen (an app rule), and retrying `attach` reports `OPAQUE_ACCOUNT_EXISTS`. Expose `auth.api.removeClassicCredential({ userId })` (server-only) so the app can finish an interrupted migration.
- **Client.** The same F1 and F3 protections apply. It should optionally reject `newPassword === currentPassword` locally (Radium requirement), and it never sends the new password.
- **New hook flow value** `"attach"` in `OpaqueRegistrationFlow`.

### 2. Reset for accounts without an OPAQUE credential

`createPasswordResetToken` returns `USER_NOT_FOUND` for classic-only users (`reset-password.ts:79-87`; test M3), and `findResetTarget` needs a credential (`:47-50`). Radium's docs promise "Those accounts can also use Forgot password" (`Authentication.md:146`).

Proposal:

- `createPasswordResetToken({ email, allowEnrolment?: boolean })` stores `{ userId, credentialVersion: null, enrol: true }`.
- `/reset/opaque/challenge` mints a new `credentialId` when the user has no OPAQUE account.
- `/reset/opaque/complete` runs the attach sequence (steps 2–8 above, `flow: "reset-password"`, `previousCredentialVersion: null`), deletes the classic credential when configured, and revokes all sessions.
- `/reset/opaque/verify` returns `loadPayload` with `credentialVersion: null` so the app can return custody/recovery material.
- Keep the outward result identical for unknown emails (server-only API).

### 3. Runtime parsing and bounds of challenge responses on the client

There is no runtime parsing today (`client/index.ts:10-28,261`); see F1 and F3. Proposal:

- Parse every challenge response with the contract schemas.
- Add `maxLength` to `registrationResponse`, `loginResponse` and `stateId` in the **response** schemas; today they are bare `z.string()` (`contract.ts:197-200,242-246,287`).
- Add the `registrationPolicy` / `loginPolicy` options from F1/F3.
- Wrap all serenity calls in `try/catch` and map failures to local `{ error }` results.
- Export the policy check (`assertKeyStretchingAllowed`) so apps can test it.

Radium needs this for `Authentication.md:87` ("client checks the profile is `rfc-recommended` and refuses otherwise"). Until it ships, Radium can approximate it with a Better Fetch `onResponse` hook in `fetchOptions` that rejects a challenge whose profile differs. The plugin passes `fetchOptions` minus `onSuccess`/`onError` to challenge requests (`client/index.ts:247-257`) [INFERENCE: not exercised].

### 4. Others

- **Exhaustive session revocation helper**: `revokeOtherSessions(ctx, userId, { keep: token } | { reissue: true })`. Use it in change, attach and reset (F2).
- **`onCredentialChanged` hook**: `({ userId, flow, previousCredentialVersion, credentialVersion, revokedSessions }, ctx)`, called after every switch, including when `activatePayload` fails. Radium uses it for audit logs, notifying other devices, invalidating device unlock state and custody re-sealing triggers.
- **Pending-2FA invalidation** (F4) and **reset-token revocation API** (F5): `revokePasswordResetTokens({ userId })`.
- **Server-option validation**: parse `keyStretching` with `keyStretchingSchema` plus a server-side minimum at construction, and validate `passwordReset.expiresIn` (positive, bounded). Today these are TypeScript types only (`runtime.ts:112-120`).
- **Sign-up switch** (F8) and **first-login CSRF middleware** (F7).
- **Validate registration records at complete**: run a server-side structural check (or a trial `server.startLogin`) on `registrationRecord` before storing. Today a malformed record bricks the account, and it is the user's own account that becomes unusable.
- **Per-account throttling hook**: `opaque({ rateLimit: { perAccount?: (userKey) => Promise<boolean> } })` keyed by an HMAC of the email, because IP limiting is weak under Convex (next section).

---

## Rate limiting under Convex

**Which IP the limiter sees.**

- Convex's `registerRoutes` handler (`cba/client/create-client.js:357-370`) passes the incoming request to `auth.handler` after `normalizeRequestOrigin` (`:81-110`). That function copies **all** request headers and rewrites only `host`, `x-forwarded-host` and `x-forwarded-proto` (`:98-103`). `x-forwarded-for` therefore reaches Better Auth exactly as the Convex HTTP edge delivered it. (`getHeaders` at `:200-220` adds `x-forwarded-for` from the stored session only for server-side `auth.api` calls, not HTTP requests.)
- Better Auth resolves the IP with `getIP` (`core/utils/ip.mjs:203-224`). It reads `advanced.ipAddress.ipAddressHeaders`, default `["x-forwarded-for"]`. Without `trustedProxies`, **only a single-value header is accepted** (`:189-192`). Otherwise the result is `null`, except in development or test, where it falls back to `127.0.0.1`.
- With `null`, the limiter uses one shared bucket `no-trusted-ip|<path>` (`ba/api/rate-limiter/index.mjs:236-248`).
- Radium's `createAuthOptions` (`packages/backend/convex/auth.ts:24-37`) sets no `rateLimit`, `advanced.ipAddress` or `secondaryStorage`.
- Radium's browser traffic does not reach Convex directly. The web app proxies `/api/auth/*` (`apps/web/src/app/api/auth/$.ts`) through the `handler` from `@convex-dev/better-auth/react-start` (`apps/web/src/lib/auth-server.ts`). That handler copies **every** incoming request header to the Convex site request, removing only hop-by-hop headers, `x-forwarded-host` and `x-forwarded-proto` (`apps/web/node_modules/@convex-dev/better-auth/dist/react-start/index.js:35-57`). A client-supplied `X-Forwarded-For` therefore passes through unchanged. Convex sees either the web server's address (no XFF from the client) or a value the client chose, never a verified client address. Which row of the table below applies then depends on what the Convex edge does with the header the web server forwards [INFERENCE: not verified against a deployment]. At the time of this run the Radium working tree held an uncommitted change to `auth-server.ts` that adds `x-radium-proxy-secret` / `x-radium-proxy-client-ip` headers; it is not part of HEAD and was not reviewed here.

What Convex Cloud's edge puts in `x-forwarded-for` was **not verified** [INFERENCE]. The outcome depends on it:

| Edge behaviour                         | Limiter key                      | Consequence                                                                                                                                                    |
| -------------------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Overwrites XFF with the real client IP | real IP                          | Intended per-IP limiting.                                                                                                                                      |
| Appends to a client-supplied XFF       | `null` when the client sends XFF | Attackers cannot rotate buckets, but every request carrying XFF shares one bucket. Five OPAQUE sign-ins per minute **for everyone behind XFF-adding proxies**. |
| Passes a client XFF unchanged          | attacker-chosen                  | **Full bypass**: a random single-value XFF per request gives a fresh bucket. Clients without XFF share the `null` bucket.                                      |
| Sets no XFF                            | `null` for all                   | The whole deployment shares 5 sign-in challenges per minute per path. One attacker can lock out all users.                                                     |

**Is it even enabled, and is it effective?**

- `enabled` defaults to `NODE_ENV === "production"` (`ba/context/create-context.mjs:172`, `core/env/env-impl.mjs:30-32`). Whether Convex's runtime sets `NODE_ENV=production` is unknown [INFERENCE]. If it does not, nothing is limited.
- With no `secondaryStorage`, the storage is `"memory"` (`create-context.mjs:175`): a module-level `Map` (`rate-limiter/index.mjs:6,213-232`). Convex HTTP actions run in isolates that are not shared or persistent [INFERENCE], so counts fragment and reset. Even a correct IP gives little protection.
- The plugin's rules (5/60 s sign-in and reset, 10/60 s registration; `plugin/src/server/index.ts:18-34,115-128`) only apply when the limiter itself works.

**Radium configuration required:**

1. Set `rateLimit: { enabled: true, storage: "database" }` and add a `rateLimit` table (`key`, `count`, `lastRequest`) to `convex/betterAuth/schema.ts`. The database storage uses `incrementOne`/`create` (`rate-limiter/index.mjs` `createDatabaseStorageWrapper`), and Radium's component adapter already exports `incrementOne` (`convex/betterAuth/adapter.ts:17`). Alternatively, use a `customStorage` backed by the already installed `@convex-dev/rate-limiter` (`convex/convex.config.ts:3,24`) through the HTTP action `ctx`.
2. Set `advanced.ipAddress.ipAddressHeaders` to whatever header Convex documents as **edge-set and not client-controllable**, and add `trustedProxies` if it appends. Verify this with a deployed probe that sends a forged `X-Forwarded-For`, before relying on it.
3. Add account-keyed throttling (HMAC of the email) for sign-in, reset verify and proof. IP buckets do not stop many-IP guessing, and a shared null bucket turns limiting into a global DoS.
4. Treat the warning "Rate limiting could not determine a client IP…" (`rate-limiter/index.mjs:245`) in Convex logs as a deployment error.

---

## Radium integration requirements

Carried over from the static review (I1–I8) and updated with the findings above. These are consumer obligations, not plugin bugs.

1. **Pin client profiles until F1/F3 are fixed.**
   - Use `opaqueClient({ keyStretching: "rfc-recommended" })` for registrations.
   - Add a challenge-response guard for login profiles (capability 3 workaround).
   - Budget for about 13 s and about 2 GiB per derivation on capable devices. Serenity reports browser crashes at 2^21 KiB (`README.md:251-270`), so test on mobile before making `rfc-recommended` mandatory, and run derivations in a Worker.
2. **Key bundle is ciphertext only (I1).** The payload builder returns only wrapped AMK, public keys and metadata. Never the export key, a KEK or plaintext. Do not spread form objects into `signUp.opaque` (extra keys become user fields).
3. **Versioned, mandatory bundle hooks (I2).**
   - `validatePayload` rejects a missing or ill-sized bundle for every flow (it runs even when `payload` is `undefined`).
   - `commitPayload` is idempotent per `(userId, credentialVersion)`.
   - `activatePayload` deletes **only** `previousCredentialVersion`.
   - `loadPayload` loads exactly the given version.
   - Update `Authentication.md:143`: "one transaction" is not available on Convex; use the attach ordering above.
4. **Reset (I3 + F5).** `auth:issuePasswordResetLink` stays an `internalAction`. Until F5 is fixed, accept that older links stay valid for up to 1 h after recovery, or shorten `passwordReset.expiresIn`. The reset page's `verify` call reveals the bundle to any holder of a link, which is acceptable only because the bundle is ciphertext.
5. **Rate limiting.** See the section above. `Authentication.md:89` currently assumes it works.
6. **Session revocation.**
   - Until F2 is fixed, call an app-side exhaustive revoke after `changePassword` succeeds: a server action that runs `deleteUserSessions` and re-signs the caller in. Alternatively, prune expired sessions periodically so the 100-row page is not filled by stale rows.
   - Keep using `authComponent.getAuthUser` (session-checked) everywhere. Never gate user data on `ctx.auth.getUserIdentity()` alone, because Convex JWTs outlive revocation by up to 15 min.
7. **2FA (I6 + F4).** If Radium enables 2FA, register `twoFactor({ allowPasswordless: true })` next to `opaque()`, pin compatible Better Auth versions, and accept or mitigate F4 (for example, revoke sessions again a short time after a reset [INFERENCE: heuristic only]).
8. **Migration.** Requires capabilities 1 and 2. Until they exist, the "Set up encryption" flow cannot be built on the plugin without a fork.
9. **Setup and runtime (I7).** Generate `serverSetup` once with the pinned 0.1.3 and serenity 1.1.0, keep it in a secret manager with an offline backup, and call `auth.api.validateOpaqueSetup()` at deployment health check. Never change `serverIdentifier` once set.
10. **Body limits (I5) and enumeration (I8).** Cap request bodies and bound bundle sizes in `validatePayload`. Default sign-up discloses existing emails (422). Choose `requireEmailVerification`/`autoSignIn: false` if that matters, noting the F6 timing residue.
11. **Logging.** Hook errors go to `console.error` (`call/router.mjs:93`), which ends up in Convex logs. Keep them free of bundle contents and tokens.

---

## Verification log

The static review (rows 1–6) was done in a read-only session. The lead then ran the regression tests and recorded the results (rows 7–12). The test files were created in the plugin repository only for the run and deleted afterwards.

| #   | Action                                                                                                                                                                                                                                                                                                                                                                  | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Read `plugin/src/**` (client, contract, every server module), `test/unit/helpers.ts`, test names of all unit suites, `two-factor.test.ts:1-100,285-308`, `flows.test.ts:1-60,155-175,290-320,399-560`, `docs/security.md`, `package.json`, `vitest.config.ts`                                                                                                           | Evidence cited above. Test runner: `vitest run` with `node` and `edge` projects over `test/unit/**/*.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 2   | Read the installed `better-auth` 1.7.18: rate limiter, `internal-adapter` (`listSessions`, `deleteUserSessions`, `deleteSessions`, `consumeVerificationValue`, `createSession`, `findUserByEmail`), origin-check middleware, router `onError`, `create-context` defaults, 2FA plugin and verification, native sign-up and change-password                               | Cited above                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 3   | Read the installed `@better-auth/core`: `utils/ip.mjs`, `env-impl.mjs`, adapter `factory.mjs` (`findMany` limit, join fallback, `consumeOne`), `atomic-fallback.mjs`; and `better-call/dist/router.mjs`                                                                                                                                                                 | Cited above                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 4   | Read the installed `@convex-dev/better-auth` 0.13.0: `client/create-client.js` (`normalizeRequestOrigin`, `registerRoutes`, `safeGetAuthUser`, `getHeaders`) and `plugins/convex/index.js` (JWT lifetime, forced cookie-cache off)                                                                                                                                      | Cited above                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 5   | Read the installed `@serenity-kit/opaque` 1.1.0 `README.md` (profiles, defaults, custom parameters, timings)                                                                                                                                                                                                                                                            | Cited above                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 6   | Read Radium `packages/backend/convex/{auth.ts,http.ts,betterAuth/schema.ts}`, grepped for `getUserIdentity` / `getAuthUser` usage, read `docs/E2EE/Authentication.md`                                                                                                                                                                                                   | Integration requirements above                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 7   | Created the seven `test/unit/zz-review-*` files from this report in the plugin repo (HEAD `681f777`, `node_modules` present, no install), then ran `bun run test -- --project node zz-review` (= `vitest run --project node zz-review`, Vitest 5.1.0). Per-file runs used `bunx vitest run --project node <file> --reporter=verbose` to capture stdout of passing tests | `Test Files 6 failed (6)`, `Tests 16 failed \| 16 passed (32)`, duration 2.77 s. Per file (passed/failed): F1 7/6, F2 1/2, F3 4/2, F4 1/2, F5 0/2, misc 3/2 (M3, M4 and the F6 harness pass; F7 and F8 fail). Every pass and fail matches the "Expected output" lists. Logged values are in each **Observed** line                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 8   | Test changes before or during the run                                                                                                                                                                                                                                                                                                                                   | Only F5 test 1: the two `INVALID_RESET_TOKEN` assertions became `expect.soft` and a log line was added for the takeover result. The hard assertion on the verify call stopped the test before the takeover reset ran, so that part of the claim was not exercised. The assertions themselves are unchanged. Every other test ran exactly as first written; all helper names and API shapes (`createTestAuth`, `createTestClient`, `postJson`, `createPayloadApp`, `serverSetupForTests`, `CHEAP_STRETCHING`, `BASE_URL`, `SECRET`, `client.requests`) matched `test/unit/helpers.ts`                                                                                                                                                                                                                                                                                                 |
| 9   | Line-number corrections, each re-read in the plugin source                                                                                                                                                                                                                                                                                                              | `credential.ts`: `validatePayload` 101-118; `replaceCredential` 135-218 (the file ends at line 218; the lead's suggested 135-235 was checked and corrected). `runtime.ts` option defaults 112-120. `contract.ts` response schemas 197-200 (registration challenge fields), 242-246 (sign-in challenge), 287 (`loginResponse` in change-password). `two-factor.ts` session delete on `loadPayload` failure 140-145. `client/index.ts` challenge `fetchOptions` handling in `post()` 247-257                                                                                                                                                                                                                                                                                                                                                                                           |
| 10  | Provenance (lead's evidence, re-checked in this run)                                                                                                                                                                                                                                                                                                                    | `npm view @alkalines/better-auth-opaque@0.1.3 dist.integrity` → `sha512-Vb8Y4CXVni93CMos/wWE0CcTPlGw5qH/dzw1sT6yJTXK5eon2iYTOZTxpZ2LjsgVVk5on1CdpURN2vRegbZqPg==`, matching the lead's tarball integrity. The npm SLSA provenance attestation (`https://registry.npmjs.org/-/npm/v1/attestations/@alkalines%2fbetter-auth-opaque@0.1.3`, predicate `https://slsa.dev/provenance/v1`) names workflow `.github/workflows/release.yml` of `alkalines/better-auth-opaque` at `refs/tags/v0.1.3`, commit `681f77700d6d3d59f188429c47a97d39fddff19e`, which is the repo HEAD (`git rev-parse HEAD`); its subject digest `sha512:55bf18e0…` is the same hash as the integrity value. `npm pack @alkalines/better-auth-opaque@0.1.3` then `diff -r package/dist <plugin>/dist` → no differences. The npm metadata has no `gitHead` field, so the commit link comes from the attestation only |
| 11  | Read `apps/web/src/lib/auth-server.ts` and `apps/web/src/app/api/auth/$.ts` at Radium HEAD, and `apps/web/node_modules/@convex-dev/better-auth/dist/react-start/index.js:35-60`                                                                                                                                                                                         | Basis of the proxy note in [Rate limiting under Convex](#rate-limiting-under-convex)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 12  | `rm test/unit/zz-review-*` then `git -C /home/arthu/Projects/alkalines-better-auth-opaque status --porcelain`                                                                                                                                                                                                                                                           | Empty output: the plugin repo is back to its original state                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
