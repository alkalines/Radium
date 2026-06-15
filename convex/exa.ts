import { v } from "convex/values";
import { credentialPreview, encryptCredentialRecord } from "@/utils/credential_crypto";
import { internalQuery, mutation, query } from "./_generated/server";
import { requireOwnedBalance } from "./keys";

/**
 * Exa API key management (per balance). The key powers the Web Search built-in
 * tool. Encryption mirrors BYOK provider credentials and MCP secrets: AES-GCM
 * via `PROVIDER_CREDENTIALS_SECRET`, with a masked preview kept for display.
 *
 * The chat HTTP handler reads the key through `internal.exa.getEncrypted` and
 * decrypts it at request time — the secret is never returned to clients.
 */

/** The encrypted-record key under which the Exa API key is stored/decrypted. */
export const EXA_API_KEY_SECRET = "apiKey";

/** Read the masked preview of the balance's Exa key, or `null` if none is set. */
export const getApiKey = query({
  args: { balance: v.id("balances") },
  handler: async (ctx, args): Promise<{ preview: string } | null> => {
    await requireOwnedBalance(ctx, args.balance);

    const row = await ctx.db
      .query("exa_credentials")
      .withIndex("by_balance", (q) => q.eq("balance", args.balance))
      .unique();

    const preview = row?.preview[EXA_API_KEY_SECRET];
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

    const encrypted = await encryptCredentialRecord(process.env.PROVIDER_CREDENTIALS_SECRET ?? "", {
      [EXA_API_KEY_SECRET]: apiKey,
    });
    const preview = { [EXA_API_KEY_SECRET]: credentialPreview(apiKey) };

    const existing = await ctx.db
      .query("exa_credentials")
      .withIndex("by_balance", (q) => q.eq("balance", args.balance))
      .unique();

    if (existing) {
      await ctx.db.patch("exa_credentials", existing._id, { encrypted, preview });
      return existing._id;
    }
    return await ctx.db.insert("exa_credentials", { balance: args.balance, encrypted, preview });
  },
});

/** Delete the balance's Exa API key. */
export const deleteApiKey = mutation({
  args: { balance: v.id("balances") },
  handler: async (ctx, args) => {
    await requireOwnedBalance(ctx, args.balance);

    const existing = await ctx.db
      .query("exa_credentials")
      .withIndex("by_balance", (q) => q.eq("balance", args.balance))
      .unique();

    if (existing) await ctx.db.delete("exa_credentials", existing._id);
    return true;
  },
});

/**
 * The balance's still-encrypted Exa secret record, or `null` if none is set.
 * Decryption happens in the calling action at request time.
 */
export const getEncrypted = internalQuery({
  args: { balance: v.id("balances") },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("exa_credentials")
      .withIndex("by_balance", (q) => q.eq("balance", args.balance))
      .unique();
    return row?.encrypted ?? null;
  },
});
