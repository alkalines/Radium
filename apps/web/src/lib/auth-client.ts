import { createAuthClient } from "better-auth/react";
import { convexClient } from "@convex-dev/better-auth/client/plugins";
import { opaqueClient } from "@alkalines/better-auth-opaque/client";

import { opaqueKeyStretchingGuard, REQUIRED_KEY_STRETCHING } from "./auth/opaque-guard";

export const authClient = createAuthClient({
  plugins: [
    convexClient(),
    // The pin makes registrations refuse any other advertised profile; the guard additionally
    // rejects it on every challenge (including sign-in) before any key derivation runs.
    opaqueClient({ keyStretching: REQUIRED_KEY_STRETCHING }),
    opaqueKeyStretchingGuard(),
  ],
});
