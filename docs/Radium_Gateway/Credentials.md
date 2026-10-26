# Gateway Credentials

A workspace provider holds a pool of credentials: any number of API keys or OAuth/subscription accounts (up to 50), plus at most one legacy entry described below. Owners manage pools in **Gateway > Credentials**; members cannot see or change them. Routing spreads requests across the pool; see [Gateway routing](LoadBalancer.md).

## Implemented

### Storage

Each credential is one `workspace_credentials` row with a masked `preview`, an optional owner `label`, an `enabled` flag (absent = enabled), a `priority` and `weight` inside its provider (absent = 0 and 1; see [routing](LoadBalancer.md#selection)), and for OAuth accounts the upstream `account` identity. Values stay write-only in Secret Store under `workspace:<workspace>:provider:<slug>`:

- Credentials created before pools, and those copied by the ownership migration, keep the secret name `<slug>` (`secretName` absent). Only one such row may exist per provider; migration verification reports duplicates among these rows only.
- Pooled credentials are named after their row ID (`secretName` = ID).
- A legacy workspace whose provider has no `<slug>` row still exposes its pre-workspace secret as a legacy credential (listed without `_id`) until the migration copies it. Removing it, or the `<slug>` row, also removes the pre-workspace copy so fallback cannot restore it.

### API

Owner-only Convex functions in `convex/providers.ts`:

| Function           | Behavior                                                                                                                           |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `listCredentials`  | Masked previews, display name, label, enabled state, priority, and weight, by provider then creation order                         |
| `createCredential` | Adds an API-key credential, optionally with priority and weight; every provider env name is required; rejected for OAuth providers |
| `updateCredential` | Label (empty clears), enabled, priority, weight, or a full replacement of API-key values; OAuth values change only through login   |
| `deleteCredential` | Removes one credential, its cooldowns, and its secret; without `credential`, removes the provider's legacy credential              |

Deleting a provider removes its whole pool.

### Usage attribution

Each completion records the credential that served it in `chat_completions.request.credential` (indexed as `by_credential`; absent for a provider's legacy credential and for rows from before pools). `recordCompletion` rejects a credential from another workspace or provider; a credential removed mid-request keeps its ID in history. **Gateway > Logs** shows the credential name beside the provider while the credential exists.

### OAuth and subscription accounts

OAuth flows are provider-agnostic at the pool level. A flow's HTTP handler calls two internal mutations with the values it wants stored for a session:

- `bindOAuthCredential`: identical values only refresh the preview; a new session for an already connected upstream `account` replaces that account's values (keeping its label, enabled state, and routing history); anything else adds an account.
- `unbindOAuthCredential`: removes the account holding exactly those values after logout or expiry, leaving other accounts untouched.

Flow-specific behavior the pool needs is registered per provider `oauth_flow` in `src/subscriptions/registry.ts` (`SubscriptionAdapter.endSession`), which ends the upstream session when an account is removed or replaced. The web dialog mirrors this: account lists, toggles, labels, and removal are generic; the "Add account" area renders the sign-in component registered for the provider's `oauth_flow` in `credentials-dialog.tsx`. Providers without a registered flow list their accounts but cannot add new ones from the interface.

The only registered flow is `chatgpt-device` ([Subscription providers](Subscriptions.md)). Its handler starts a fresh library session for every login while the browser's current session is already authenticated, so adding an account never overwrites another.

## Limitations

- OAuth accounts connected before pools have no recorded `account`, so logging into one again adds a second entry; remove the stale one.
- Per-account usage-limit tracking is not implemented yet; completions are attributed per credential, but quota only excludes accounts through cooldowns.
- Endpoint instances (several vLLM/Ollama servers behind one provider) remain [task 04](../tasks/04_Upstream_Instances.md) work.

## Verification

```bash
bun run --cwd packages/backend test convex/providers.test.ts convex/routing.test.ts src/subscriptions
bun run --cwd apps/web vite:build
```

`convex/providers.test.ts` covers pool management, ownership, and OAuth bind/reconnect/unbind/removal with `convex-test`; `convex/routing.test.ts` covers credential rotation, per-credential cooldowns, disabled credentials, and per-credential session affinity. These are offline checks, not deployment verification; the widened schema has not been pushed to a deployment.
