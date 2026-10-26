# Subscription Providers

## Implemented

ChatGPT Subscription (OpenAI Codex) uses device login through
`@opencoredev/loginwithchatgpt-server`. The credentials form calls the same-origin
`/api/backend/subscription/chatgpt-subscription/*` endpoint with a `workspace`
query parameter. The generic frontend proxy forwards it to
`/api/subscription/chatgpt-subscription/*` on `VITE_CONVEX_SITE_URL`.

### Routing And Responsibilities

- `apps/web/src/app/api/backend/$.ts` forwards all supported HTTP methods from
  `/api/backend/*` to `/api/*` on the configured Convex site. For example,
  `/api/backend/openai/v1/models` forwards to `/api/openai/v1/models`. It preserves
  query parameters, request bodies, authentication headers, cookies, response
  bodies (including streams), status, and Set-Cookie headers. Redirects are passed
  through rather than followed server-side. The proxy adds no authentication of
  its own; each Convex endpoint enforces its existing policy.
- `packages/backend/src/http/router.ts` mounts the Hono subscription router
  alongside Gateway and Chatroom handlers. `packages/backend/convex/http.ts`
  connects the app using `HttpRouterWithHono` from `convex-helpers/server/hono`
  and registers Better Auth directly on the Convex router. See
  [HTTP routing and CORS](../api.md#http-routing-and-cors).
- `packages/backend/src/subscriptions/router.ts` owns the subscription route
  namespace and shared CORS middleware. Add further subscription integrations as
  subroutes here. Credentialed CORS allows only the origin configured by
  `SITE_URL`, with GET/POST and Content-Type/Authorization headers. OPTIONS
  preflight is handled before authentication; errors and unknown routes also
  receive this CORS policy.
- `packages/backend/src/subscriptions/chatgpt.ts` owns the provider handler,
  request-scoped inference fetch, cookie handling, and credential lifecycle;
  `chatgpt_session.ts` owns the cookie format and the flow's
  `SubscriptionAdapter`, registered for `oauth_flow: "chatgpt-device"` in
  `registry.ts`.
- `packages/backend/convex/subscriptions.ts` contains only internal database
  queries/mutations for login-session and rate-limit state. Its existing
  `subscription_state` table, indexes, provider identifier, and TTL behavior are
  preserved.

### Authorization And Credential Flow

The provider handler validates the Better Auth browser session and resolves the
requested workspace through `internal.workspaces.getOwnedWorkspaceForUser`
before invoking the subscription library. Missing authentication, workspace, or
ownership returns 401. Members cannot configure subscription credentials.

Authenticated status polling binds the session-cookie credential to the workspace
through the provider-agnostic `bindOAuthCredential`, passing the ChatGPT account
ID as the upstream `account`; the UI sees a masked account preview. A workspace
can connect several ChatGPT accounts: `/login` drops the browser's session cookie
when that session is already authenticated, so the library issues a new session
instead of restarting login inside (and overwriting) a connected account. Logging
into an already connected account replaces that account's session and deletes the
old one. Logout and expired sessions unbind only the account holding that cookie;
removing an account in **Gateway > Credentials** deletes its stored session. See
[Gateway credentials](Credentials.md). Gateway inference uses the stored
cookie with a request-scoped internal proxy fetch, rather than calling the public
login route or implementing another model router.

Usage limits are read from the same session: the inference handler is built with
a `fetch` that sees raw Codex responses, so `x-codex-*` headers reach the
[limit snapshot](Limits.md) even though the proxy strips them, and the usage poll
builds a separate handler with `dangerouslyAllowTokenExport` to call
`wham/usage` from inside the backend action. Tokens never leave the backend.

### Configuration And Failures

- `VITE_CONVEX_SITE_URL`: frontend server's upstream Convex HTTP site origin.
  Missing configuration returns a JSON 500 from the generic proxy.
- `SITE_URL`: allowed web origin and cookie Secure policy (HTTPS enables Secure).
- `LWC_SECRET`: signs subscription sessions; missing configuration fails handler
  creation. Preserve it to retain existing signed sessions.

The cookie name remains `lwc_chatgpt_subscription`, with Path `/` and SameSite
Lax. The route move requires no persisted-data migration. The credentials form
uses the new route; the old `/api/chatgpt-subscription/*` route is removed.

## Verification

```bash
bun run --cwd packages/backend test src/subscriptions
bun run --cwd apps/web vite:build
```

Handler regressions cover owner authorization, credential binding/unbinding,
fresh sessions for additional logins, and shared CORS behavior. Live device login
still requires a configured deployment, a workspace owner, and a ChatGPT account;
local mocked tests do not verify upstream availability.

The frontend build regenerates the local TanStack route tree. Refresh Convex API
declarations only through the [offline binding generator](../deployment.md#offline-api-binding-codegen);
moving the provider helper out of `convex/` does not require remote codegen.

## Planned And Known Limitations

ChatGPT is the only implemented subscription integration. Additional subscription
providers can share the router and the credential pool; each registers its
`SubscriptionAdapter` by `oauth_flow` and its sign-in component in the web
credentials dialog, and defines its own auth contract. Inference still selects
the ChatGPT transport by its AI SDK package in `src/routing/connector.ts`.
Cross-site cookie restrictions still apply when calling Convex directly; the
frontend form uses the same-origin proxy to avoid them. This integration does not
expose general OpenAI Responses compatibility in Gateway.

The adapter is an existing `convex-helpers` convenience for Web-standard HTTP
routing; Hono is a direct backend dependency. No additional persistence
component is needed for this route/organization refactor.
