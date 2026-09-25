import { SecretStore } from "convex-secret-store";
import { components } from "./_generated/api.js";

export const EXA_SECRET_NAMESPACE_PREFIX = "balance:" as const;
export const EXA_SECRET_NAMESPACE_SUFFIX = ":tools" as const;
export const EXA_SECRET_NAME = "exa" as const;

export const WORKSPACE_SECRET_NAMESPACE_PREFIX = "workspace:" as const;

export const MCP_SECRET_NAME = "bearer" as const;

export type SecretNamespace =
  | `provider:${string}`
  | `balance:${string}:tools`
  | `mcp:${string}`
  | `workspace:${string}:provider:${string}`
  | `workspace:${string}:tools`
  | `workspace:${string}:mcp:${string}`;

export type SecretMetadata = {
  kind: "provider" | "exa" | "mcp";
  preview?: Record<string, string>;
  provider?: string;
  balance?: string;
  workspace?: string;
  mcpServer?: string;
};

export const secrets = new SecretStore<SecretNamespace, SecretMetadata>(components.secretStore);

export function providerSecretNamespace(provider: string): SecretNamespace {
  return `provider:${provider}`;
}

/** Workspace-scoped provider credentials. The legacy provider namespace is kept for migration. */
export function workspaceProviderSecretNamespace(
  workspace: string,
  provider: string,
): SecretNamespace {
  return `${WORKSPACE_SECRET_NAMESPACE_PREFIX}${workspace}:provider:${provider}`;
}

export function balanceSecretName(balance: string): string {
  return balance;
}

export function exaSecretNamespace(balance: string): SecretNamespace {
  return `${EXA_SECRET_NAMESPACE_PREFIX}${balance}${EXA_SECRET_NAMESPACE_SUFFIX}`;
}

export function workspaceExaSecretNamespace(workspace: string): SecretNamespace {
  return `${WORKSPACE_SECRET_NAMESPACE_PREFIX}${workspace}:tools`;
}

export function mcpSecretNamespace(server: string): SecretNamespace {
  return `mcp:${server}`;
}

/** Workspace-scoped MCP credentials. The server id remains part of the key to avoid collisions. */
export function workspaceMcpSecretNamespace(workspace: string, server: string): SecretNamespace {
  return `${WORKSPACE_SECRET_NAMESPACE_PREFIX}${workspace}:mcp:${server}`;
}
