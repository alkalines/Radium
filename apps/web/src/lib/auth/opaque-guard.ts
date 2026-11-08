import type { BetterAuthClientPlugin } from "better-auth/client";

/** The only key-stretching profile Radium accepts from the server (shared E2EE contract 5). */
export const REQUIRED_KEY_STRETCHING = "rfc-recommended";

/** Error code of a challenge rejected by {@link opaqueKeyStretchingGuard}. */
export const KEY_STRETCHING_REJECTED = "KEY_STRETCHING_REJECTED";

/**
 * Challenge responses that carry a profile the client derives keys with, and the fields holding
 * it. Paths are the wire contract of `@alkalines/better-auth-opaque` 0.1.3 (`OPAQUE_PATHS`),
 * pinned exactly; the server entry that exports them is not imported into the browser bundle.
 */
const GUARDED_CHALLENGES: ReadonlyArray<{ path: string; fields: readonly string[] }> = [
  { path: "/sign-up/opaque/challenge", fields: ["keyStretching"] },
  { path: "/sign-in/opaque/challenge", fields: ["keyStretching"] },
  { path: "/opaque/password-proof/challenge", fields: ["keyStretching"] },
  { path: "/opaque/change-password/challenge", fields: ["keyStretching", "loginKeyStretching"] },
  { path: "/reset/opaque/challenge", fields: ["keyStretching"] },
];

function guardedFields(url: string | URL): readonly string[] | null {
  const { pathname } = new URL(url, "http://radium.invalid");
  const match = GUARDED_CHALLENGES.find((challenge) => pathname.endsWith(challenge.path));
  return match?.fields ?? null;
}

function rejection(): Response {
  return new Response(
    JSON.stringify({
      code: KEY_STRETCHING_REJECTED,
      message: "The server asked for an unsupported password hashing profile",
    }),
    { status: 400, statusText: "BAD_REQUEST", headers: { "content-type": "application/json" } },
  );
}

/**
 * Decides whether a successful challenge response may reach the OPAQUE client. Exported for
 * tests; the plugin below applies it to every auth request.
 */
export async function checkChallengeResponse(
  url: string | URL,
  response: Response,
): Promise<Response | undefined> {
  const fields = guardedFields(url);
  if (!fields || !response.ok) return undefined;

  let body: unknown;
  try {
    body = await response.clone().json();
  } catch {
    return rejection();
  }
  if (typeof body !== "object" || body === null) return rejection();

  const profiles = body as Record<string, unknown>;
  const acceptable = fields.every((field) => profiles[field] === REQUIRED_KEY_STRETCHING);
  return acceptable ? undefined : rejection();
}

/**
 * Better Auth client plugin that refuses any OPAQUE challenge whose key-stretching profile is not
 * exactly `rfc-recommended` (audit F1, F3). It runs as a Better Fetch `onResponse` hook, which
 * Better Fetch executes before it parses the body for the caller; returning an error response
 * makes the opaque client action return `{ error }` before it calls serenity's `finishLogin` or
 * `finishRegistration`, so a compromised server can neither weaken a new registration nor make
 * the browser run an abusive Argon2id work factor.
 */
export function opaqueKeyStretchingGuard() {
  return {
    id: "radium-opaque-key-stretching-guard",
    fetchPlugins: [
      {
        id: "radium-opaque-key-stretching-guard",
        name: "OPAQUE key-stretching guard",
        hooks: {
          onResponse: async (context) =>
            checkChallengeResponse(context.request.url, context.response),
        },
      },
    ],
  } satisfies BetterAuthClientPlugin;
}
