import { createAuthClient } from "better-auth/react";
import { convexClient } from "@convex-dev/better-auth/client/plugins";
import { opaqueClient } from "@alkalines/better-auth-opaque/client";

/**
 * Better Auth client. The OPAQUE plugin derives every key with the Argon2id profile the server
 * names in its challenge, so the client pins the only profile Radium registers: a compromised
 * server can neither weaken new passwords nor demand unbounded work at sign-in. Both lists are
 * set: an omitted `login` list falls back to the plugin defaults, which accept the weaker
 * `memory-constrained` profile (plugin assessment N1). Challenge responses are parsed by the
 * plugin before use.
 */
export const authClient = createAuthClient({
  plugins: [
    convexClient(),
    opaqueClient({
      keyStretching: { registration: ["rfc-recommended"], login: ["rfc-recommended"] },
    }),
  ],
});
