import {
  OPAQUE_PROVIDER_ID,
  type OpaqueHookContext,
  type OpaqueHooks,
} from "@alkalines/better-auth-opaque";
import type { GenericCtx } from "@convex-dev/better-auth";
import { internal } from "../../convex/_generated/api";
import type { DataModel } from "../../convex/_generated/dataModel";
import { parseRegistrationPayload } from "./contract";
import { resetPayload, signInPayload } from "./records";

/** Account field holding the OPAQUE credential version (plugin `OPAQUE_ACCOUNT_FIELDS`). */
const CREDENTIAL_VERSION_FIELD = "opaqueCredentialVersion";

/**
 * Payload hooks run inside Better Auth's HTTP action, where `runMutation`/`runQuery` exist; the
 * schema-only option paths never invoke them.
 */
function requireActionCtx(ctx: GenericCtx<DataModel>) {
  if (!("runMutation" in ctx) || !("runQuery" in ctx)) {
    throw new Error("OPAQUE payload hooks need an action or mutation context");
  }
  return ctx;
}

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
 * "Hooks", audit I2). Every registration must carry a valid key bundle; storage is versioned
 * and idempotent in `./records`. Hook errors carry fixed messages only: the plugin forwards or
 * logs them, and payloads must never reach logs.
 */
export function createOpaqueHooks(ctx: GenericCtx<DataModel>): OpaqueHooks {
  return {
    validatePayload: ({ payload, flow }) => {
      parseRegistrationPayload(payload, flow);
    },

    commitPayload: async ({ userId, credentialVersion, payload, flow }, endpoint) => {
      const { runMutation } = requireActionCtx(ctx);
      const currentCredentialVersion =
        flow === "sign-up" ? null : await readCurrentCredentialVersion(endpoint, userId);
      await runMutation(internal.e2ee.commitBundle, {
        userId,
        credentialVersion,
        currentCredentialVersion,
        flow,
        payload,
      });
    },

    activatePayload: async ({ userId, credentialVersion, previousCredentialVersion }) => {
      const { runMutation } = requireActionCtx(ctx);
      await runMutation(internal.e2ee.activateBundle, {
        userId,
        credentialVersion,
        previousCredentialVersion,
      });
    },

    loadPayload: async ({ userId, credentialVersion, flow }) => {
      const { runMutation, runQuery } = requireActionCtx(ctx);
      const loaded = await runQuery(internal.e2ee.loadBundle, { userId, credentialVersion });

      // The account already points at this version, so a pending identity means activation
      // failed after the switch. Finish it now; the client is about to use these keys.
      if (loaded?.identity.status === "pending") {
        await runMutation(internal.e2ee.activateBundle, {
          userId,
          credentialVersion,
          previousCredentialVersion: null,
        });
      }

      if (flow === "sign-in") {
        return signInPayload(loaded);
      }
      return resetPayload(loaded);
    },
  };
}
