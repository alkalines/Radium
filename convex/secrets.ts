import { SecretStore } from "convex-secret-store";
import { components } from "./_generated/api.js";

export const EXA_SECRET_NAMESPACE_PREFIX = "balance:" as const;
export const EXA_SECRET_NAMESPACE_SUFFIX = ":tools" as const;
export const EXA_SECRET_NAME = "exa" as const;

export const MCP_SECRET_NAME = "bearer" as const;

export type SecretNamespace =
  | `provider:${string}`
  | `balance:${string}:tools`
  | `mcp:${string}`;

export type SecretMetadata = {
  kind: "provider" | "exa" | "mcp";
  preview?: Record<string, string>;
  provider?: string;
  balance?: string;
  mcpServer?: string;
};

export const secrets = new SecretStore<SecretNamespace, SecretMetadata>(components.secretStore);

export function providerSecretNamespace(provider: string): SecretNamespace {
  return `provider:${provider}`;
}

export function balanceSecretName(balance: string): string {
  return balance;
}

export function exaSecretNamespace(balance: string): SecretNamespace {
  return `${EXA_SECRET_NAMESPACE_PREFIX}${balance}${EXA_SECRET_NAMESPACE_SUFFIX}`;
}

export function mcpSecretNamespace(server: string): SecretNamespace {
  return `mcp:${server}`;
}
