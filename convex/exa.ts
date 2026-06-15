import { v } from "convex/values";
import { credentialPreview } from "@/utils/credential_preview";
import { internalQuery, mutation, query } from "./_generated/server";
import { requireOwnedBalance } from "./keys";
import { EXA_SECRET_NAME, exaSecretNamespace, secrets } from "./secrets";

/**
 * Exa API key management (per balance). The key powers the Web Search built-in
 * tool and is stored in the shared Secret Store component.
 */

/** The secret key under which the Exa API key is stored. */
export const EXA_API_KEY_SECRET = "apiKey";

/** Read the masked preview of the balance's Exa key, or `null` if none is set. */
export const getApiKey = query({
  args: { balance: v.id("balances") },
  handler: async (ctx, args): Promise<{ preview: string } | null> => {
    await requireOwnedBalance(ctx, args.balance);

    const row = await secrets.get(ctx, {
      namespace: exaSecretNamespace(args.balance),
      name: EXA_SECRET_NAME,
    });

    const preview = row.ok ? row.metadata?.preview?.[EXA_API_KEY_SECRET] : undefined;
    return preview ? { preview } : null;
  },
});

/** Create or replace the balance's Exa API key. */
export const setApiKey = mutation({
  args: { balance: v.id("balances"), apiKey: v.string() },
  handler: async (ctx, args) => {
    await requireOwnedBalance(ctx, args.balance);

    const apiKey = args.apiKey.trim();
    if (!apiKey) throw new Error("An Exa API key is required.");

    const preview = { [EXA_API_KEY_SECRET]: credentialPreview(apiKey) };

    const result = await secrets.put(ctx, {
      namespace: exaSecretNamespace(args.balance),
      name: EXA_SECRET_NAME,
      value: apiKey,
      metadata: { kind: "exa", balance: args.balance, preview },
    });

    return result.secretId;
  },
});

/** Delete the balance's Exa API key. */
export const deleteApiKey = mutation({
  args: { balance: v.id("balances") },
  handler: async (ctx, args) => {
    await requireOwnedBalance(ctx, args.balance);

    await secrets.remove(ctx, {
      namespace: exaSecretNamespace(args.balance),
      name: EXA_SECRET_NAME,
    });
    return true;
  },
});

/** The balance's Exa API key, or `null` if none is set. */
export const getApiKeyForRuntime = internalQuery({
  args: { balance: v.id("balances") },
  handler: async (ctx, args) => {
    const row = await secrets.get(ctx, {
      namespace: exaSecretNamespace(args.balance),
      name: EXA_SECRET_NAME,
    });
    return row.ok ? row.value : null;
  },
});
