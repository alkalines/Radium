import { ChatCompletions_RequestBody_Type } from "./types/openai/types";
import Providers from "./providers";
import { internal } from "../../convex/_generated/api";
import type { GenericActionCtx } from "convex/server";
import type { Id } from "../../convex/_generated/dataModel";
import { decryptCredentialRecord } from "./credential_crypto";

export default async function AIBalancer(
  ctx: GenericActionCtx<any>,
  balanceId: Id<"balances">,
  Request: ChatCompletions_RequestBody_Type,
) {
  const providerCandidates = await ctx.runQuery(internal.providers.resolveProviderCandidatesForModel, {
    balance: balanceId,
    modelSlug: Request.model,
    providerSlug: Request.provider ?? undefined,
  });
  const provider = providerCandidates[Math.floor(Math.random() * providerCandidates.length)];
  const credentials = await decryptCredentialRecord(
    process.env.PROVIDER_CREDENTIALS_SECRET ?? "",
    provider.credentials,
  );
  const apiKey = provider.env.map((name) => credentials[name]).find(Boolean);

  if (!apiKey) {
    throw new Error(`Missing API key credential for provider ${provider.slug}: ${provider.env.join(", ")}`);
  }

  return {
    info: provider,
    connector: Providers[provider.npm].connector({
      apiKey,
      name: provider.name,
      baseURL: provider.baseURL,
      credentials,
    }),
  };
}
