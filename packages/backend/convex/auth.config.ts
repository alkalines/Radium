import { getAuthConfigProvider } from "@convex-dev/better-auth/auth-config";
import type { AuthConfig } from "convex/server";
import { backendOrigin, publicWorkerJwks, workerIssuer, WORKER_AUDIENCE } from "../src/worker/auth";

// JWKS is a JSON set of PUBLIC issuer keys. The matching private key stays in
// WORKER_AUTH_PRIVATE_JWK and is read only by the app's token-issuance code.
// Without a public key set, the optional machine verifier is omitted entirely;
// Better Auth continues to authenticate human users as before.
const workerJwks = process.env.WORKER_AUTH_JWKS;

export default {
  providers: [
    getAuthConfigProvider(),
    ...(workerJwks
      ? [
          {
            type: "customJwt" as const,
            applicationID: WORKER_AUDIENCE,
            issuer: workerIssuer(backendOrigin(process.env.CONVEX_SITE_URL)),
            // Embedding public keys avoids needing a separate hosted JWKS server.
            // These are deployment issuer keys, not individual Workers' keys.
            jwks: `data:application/json;base64,${btoa(JSON.stringify(publicWorkerJwks(workerJwks)))}`,
            algorithm: "ES256" as const,
          },
        ]
      : []),
  ],
} satisfies AuthConfig;
