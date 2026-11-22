import {
  OPAQUE_PROVIDER_ID,
  type OpaqueHookContext,
  type OpaqueHooks,
} from "@alkalines/better-auth-opaque";
import { parseRegistrationPayload } from "contracts/e2ee/contract";
import type { Database } from "../drivers/types";
import { activateBundle, commitBundle, loadBundle, resetPayload, signInPayload } from "./keys";

/** Account field holding the OPAQUE credential version (plugin `OPAQUE_ACCOUNT_FIELDS`). */
const CREDENTIAL_VERSION_FIELD = "opaqueCredentialVersion";

/**
 * Version of the user's OPAQUE credential as stored on the account right now. Hooks receive only
 * the new version; a `rewrap` must be checked against the identity of the current one.
 */
async function readCurrentCredentialVersion(endpoint: OpaqueHookContext, userId: string) {
  const accounts = await endpoint.context.internalAdapter.findAccounts(userId);
  const account = accounts.find((candidate) => candidate.providerId === OPAQUE_PROVIDER_ID);
  const version = (account as Record<string, unknown> | undefined)?.[CREDENTIAL_VERSION_FIELD];
  return typeof version === "string" ? version : null;
}

/**
 * OPAQUE plugin hooks that keep account keys consistent with credential versions (contract
 * "Hooks", audit I2). Every registration must carry a valid key bundle; storage is versioned and
 * idempotent in `./keys`. Hook errors carry fixed messages only: the plugin forwards or logs
 * them, and payloads must never reach logs.
 */
export function createOpaqueHooks(db: Database): OpaqueHooks {
  return {
    validatePayload: ({ payload, flow }) => {
      parseRegistrationPayload(payload, flow);
    },

    commitPayload: async ({ userId, credentialVersion, payload, flow }, endpoint) => {
      // Sign-up and attach create the user's first OPAQUE credential: there is no current one.
      const currentCredentialVersion =
        flow === "sign-up" || flow === "attach"
          ? null
          : await readCurrentCredentialVersion(endpoint, userId);
      await commitBundle(db, {
        userId,
        credentialVersion,
        currentCredentialVersion,
        flow,
        payload,
      });
    },

    activatePayload: async ({ userId, credentialVersion, previousCredentialVersion }) => {
      await activateBundle(db, { userId, credentialVersion, previousCredentialVersion });
    },

    loadPayload: async ({ userId, credentialVersion, flow }) => {
      // Reset verify of an enrolment link (classic account without an OPAQUE credential): there
      // are no keys to recover, so the client creates new ones.
      if (credentialVersion === null) {
        return resetPayload(null);
      }
      const loaded = await loadBundle(db, userId, credentialVersion);

      // The account already points at this version, so a pending identity means activation
      // failed after the switch. Finish it now; the client is about to use these keys.
      if (loaded?.identity.status === "pending") {
        await activateBundle(db, { userId, credentialVersion, previousCredentialVersion: null });
      }

      if (flow === "sign-in") {
        return signInPayload(loaded);
      }
      return resetPayload(loaded);
    },
  };
}
