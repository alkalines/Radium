import { and, asc, eq, sql } from "drizzle-orm";
import { acpAgentDefinitionStatement, SIGNATURE_BYTES, toBase64Url, verify } from "radium-crypto";
import { z } from "zod";
import {
  ACP_AGENT_DEFINITIONS_MAX,
  acpAgentDefinitionError,
  type AcpAgentDefinition,
} from "contracts/acp/contract";
import { base64urlBytes } from "contracts/wire";
import type { Database } from "../drivers/types";
import { activeIdentity } from "../e2ee/workspace-keys";
import { AppError } from "../errors";
import type { WorkerScope } from "../worker/auth";
import type { Workspace } from "../workspaces/workspaces";
import { acpError } from "./policy";
import { acpAgents } from "./schema";

/*
 * Agent definitions (Convex `src/acp/agents.ts`): owner-managed launch configuration shared by
 * every Worker of the workspace, the Worker's read of them, and the public ACP registry. In a
 * keyed workspace every saved definition carries the owner's signature over the executable
 * (`acpAgentDefinitionStatement`); paired Workers refuse definitions without it.
 */

const envInput = z.array(z.object({ name: z.string().max(256), value: z.string().max(4096) })).max(32);

/** A definition on the wire (`AcpAgentDefinition`, authorization signature as base64url). */
export const agentDefinitionInput = z.object({
  agentId: z.string().max(64),
  name: z.string().max(200),
  command: z.string().max(1100),
  args: z.array(z.string().max(4096)).max(64),
  env: envInput,
  gateway: z.object({ enabled: z.boolean(), env: envInput }).optional(),
  enabled: z.boolean(),
  source: z.enum(["registry", "custom"]),
  icon: z.string().max(2048).optional(),
  version: z.string().max(128).optional(),
  authorization: z
    .object({
      issuedAt: z.number(),
      signerKeyId: z.string().max(64),
      signature: base64urlBytes(SIGNATURE_BYTES),
    })
    .optional(),
});
export type AgentDefinitionInput = z.output<typeof agentDefinitionInput>;

type AgentRow = typeof acpAgents.$inferSelect;

/** A stored definition in its wire form (`AcpAgentDefinition`, signature as base64url text). */
function definitionWire(row: AgentRow) {
  return {
    agentId: row.agentId,
    name: row.name,
    command: row.command,
    args: row.args,
    env: row.env,
    ...(row.gateway ? { gateway: row.gateway } : {}),
    enabled: row.enabled,
    source: row.source,
    ...(row.icon !== null ? { icon: row.icon } : {}),
    ...(row.version !== null ? { version: row.version } : {}),
    ...(row.authorizationIssuedAt && row.authorizationSignerKeyId && row.authorizationSignature
      ? {
          authorization: {
            issuedAt: row.authorizationIssuedAt.getTime(),
            signerKeyId: row.authorizationSignerKeyId,
            signature: toBase64Url(row.authorizationSignature),
          },
        }
      : {}),
  };
}

/** Owner-only launch definitions, by name then agent id. */
export async function listAgentDefinitions(db: Database, workspace: string) {
  const rows = await db
    .select()
    .from(acpAgents)
    .where(eq(acpAgents.workspace, workspace))
    .orderBy(asc(acpAgents.agentId))
    .limit(ACP_AGENT_DEFINITIONS_MAX);
  return rows
    .map((row) => ({ id: row.id, ...definitionWire(row), updatedAt: row.updatedAt.getTime() }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.agentId.localeCompare(b.agentId));
}

/**
 * Checks the owner's executable authorization: required in a keyed workspace, and checked
 * whenever present. The signature must be by the owner's active identity and recent.
 */
async function requireAuthorization(
  db: Database,
  workspace: Workspace,
  definition: AgentDefinitionInput,
) {
  const authorization = definition.authorization;
  if (!workspace.keyEpoch && !authorization) return;
  const identity = await activeIdentity(db, workspace.ownerId);
  const { authorization: _, ...signed } = definition;
  if (
    !authorization ||
    !identity ||
    authorization.signerKeyId !== identity.keyId ||
    authorization.signature.byteLength !== SIGNATURE_BYTES ||
    !Number.isSafeInteger(authorization.issuedAt) ||
    authorization.issuedAt <= 0 ||
    authorization.issuedAt > Date.now() + 5 * 60_000 ||
    !(await verify(
      identity.signingPublicKey,
      acpAgentDefinitionStatement({
        workspaceId: workspace.id,
        issuedAt: authorization.issuedAt,
        definition: signed,
      }),
      authorization.signature,
    ))
  ) {
    acpError("ACP_AGENT_AUTHORIZATION_REQUIRED");
  }
}

function definitionColumns(definition: AgentDefinitionInput) {
  return {
    agentId: definition.agentId,
    name: definition.name,
    command: definition.command,
    args: definition.args,
    env: definition.env,
    gateway: definition.gateway ?? null,
    enabled: definition.enabled,
    source: definition.source,
    icon: definition.icon ?? null,
    version: definition.version ?? null,
    authorizationIssuedAt: definition.authorization
      ? new Date(definition.authorization.issuedAt)
      : null,
    authorizationSignerKeyId: definition.authorization?.signerKeyId ?? null,
    authorizationSignature: definition.authorization?.signature ?? null,
    updatedAt: new Date(),
  };
}

/**
 * Creates or replaces a definition. Agent ids are immutable (existing Sessions keep their agent);
 * an update of an authorized definition needs a newer authorization. At most
 * `ACP_AGENT_DEFINITIONS_MAX` per workspace, counted under a workspace advisory lock.
 */
export async function saveAgentDefinition(
  db: Database,
  workspace: Workspace,
  input: { id?: string; definition: AgentDefinitionInput },
): Promise<string> {
  const invalid = acpAgentDefinitionError(input.definition as AcpAgentDefinition);
  if (invalid) acpError("ACP_INVALID_AGENT", invalid);
  const definition = {
    ...input.definition,
    name: input.definition.name.trim(),
    command: input.definition.command.trim(),
  };
  await requireAuthorization(db, workspace, definition);
  return await db.transaction(async (tx) => {
    if (input.id) {
      const [existing] = await tx
        .select()
        .from(acpAgents)
        .where(and(eq(acpAgents.id, input.id), eq(acpAgents.workspace, workspace.id)))
        .for("update");
      if (!existing) acpError("ACP_AGENT_NOT_FOUND", "Agent not found.");
      if (existing.agentId !== definition.agentId) {
        acpError("ACP_INVALID_AGENT", "Agent IDs cannot be changed.");
      }
      if (
        existing.authorizationIssuedAt &&
        (!definition.authorization ||
          definition.authorization.issuedAt <= existing.authorizationIssuedAt.getTime())
      ) {
        acpError("ACP_STALE_AGENT_AUTHORIZATION");
      }
      await tx.update(acpAgents).set(definitionColumns(definition)).where(eq(acpAgents.id, existing.id));
      return existing.id;
    }
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`acp_agents:${workspace.id}`}, 0))`,
    );
    const [count] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(acpAgents)
      .where(eq(acpAgents.workspace, workspace.id));
    if (count!.count >= ACP_AGENT_DEFINITIONS_MAX) {
      acpError(
        "ACP_INVALID_AGENT",
        `A workspace supports at most ${ACP_AGENT_DEFINITIONS_MAX} agents.`,
      );
    }
    const [row] = await tx
      .insert(acpAgents)
      .values({ workspace: workspace.id, ...definitionColumns(definition) })
      .onConflictDoNothing({ target: [acpAgents.workspace, acpAgents.agentId] })
      .returning({ id: acpAgents.id });
    if (!row) acpError("ACP_AGENT_EXISTS", "This agent ID already exists.");
    return row.id;
  });
}

/** Deleting a definition never rewrites or deletes an existing Session. */
export async function deleteAgentDefinition(db: Database, workspace: string, id: string) {
  const deleted = await db
    .delete(acpAgents)
    .where(and(eq(acpAgents.id, id), eq(acpAgents.workspace, workspace)))
    .returning({ id: acpAgents.id });
  if (deleted.length === 0) acpError("ACP_AGENT_NOT_FOUND", "Agent not found.");
}

/**
 * The calling Worker's workspace definitions, disabled ones included (a disabled signed definition
 * advances the Worker's mark before it stops the agent). Scope comes from the verified identity.
 */
export async function workerAgentDefinitions(db: Database, scope: WorkerScope) {
  const rows = await db
    .select()
    .from(acpAgents)
    .where(eq(acpAgents.workspace, scope.workspaceId))
    .orderBy(asc(acpAgents.agentId))
    .limit(ACP_AGENT_DEFINITIONS_MAX);
  return rows.map(definitionWire);
}

/** The workspace definition of `agentId`, if any. */
export async function findAgentDefinition(db: Database, workspace: string, agentId: string) {
  const [row] = await db
    .select()
    .from(acpAgents)
    .where(and(eq(acpAgents.workspace, workspace), eq(acpAgents.agentId, agentId)));
  return row;
}

/** Agent ids of the enabled definitions of `workspace`. */
export async function enabledAgentIds(db: Database, workspace: string): Promise<string[]> {
  const rows = await db
    .select({ agentId: acpAgents.agentId })
    .from(acpAgents)
    .where(and(eq(acpAgents.workspace, workspace), eq(acpAgents.enabled, true)))
    .limit(ACP_AGENT_DEFINITIONS_MAX);
  return rows.map((row) => row.agentId);
}

// ---------------------------------------------------------------------------------------------
// Registry

export type RegistryAgent = {
  id: string;
  name: string;
  version: string;
  description?: string;
  icon?: string;
  launch?: { command: string; args: string[]; env: { name: string; value: string }[] };
  pathCommand?: { command: string; args: string[] };
};

const REGISTRY_ENTRIES_MAX = 200;
const REGISTRY_BYTES_MAX = 1024 * 1024;
const REGISTRY_TIMEOUT_MS = 10_000;
export const REGISTRY_URL = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function launchFields(value: Record<string, unknown>) {
  const args = value.args === undefined ? [] : value.args;
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) return null;
  const envRecord = value.env === undefined ? {} : record(value.env);
  if (!envRecord || Object.values(envRecord).some((item) => typeof item !== "string")) return null;
  return {
    args: args as string[],
    env: Object.entries(envRecord).map(([name, value]) => ({ name, value: value as string })),
  };
}

/** Pure registry boundary: malformed or unsafe launch entries never reach the settings form. */
export function normalizeRegistryAgents(value: unknown): RegistryAgent[] {
  const registry = record(value);
  if (!registry || typeof registry.version !== "string" || !Array.isArray(registry.agents))
    return [];
  const result: RegistryAgent[] = [];
  const seen = new Set<string>();
  for (const raw of registry.agents.slice(0, REGISTRY_ENTRIES_MAX)) {
    const entry = record(raw);
    if (
      !entry ||
      typeof entry.id !== "string" ||
      seen.has(entry.id) ||
      typeof entry.name !== "string" ||
      typeof entry.version !== "string" ||
      !entry.version.trim() ||
      (entry.description !== undefined && typeof entry.description !== "string") ||
      (entry.icon !== undefined && typeof entry.icon !== "string")
    )
      continue;
    const distribution = record(entry.distribution);
    if (!distribution) continue;
    let launch: RegistryAgent["launch"];
    let pathCommand: RegistryAgent["pathCommand"];
    for (const command of ["npx", "uvx"] as const) {
      const dist = record(distribution[command]);
      if (
        !dist ||
        typeof dist.package !== "string" ||
        !dist.package.trim() ||
        dist.package.startsWith("-")
      )
        continue;
      const fields = launchFields(dist);
      if (!fields) continue;
      launch = {
        command,
        args: [...(command === "npx" ? ["-y"] : []), dist.package, ...fields.args],
        env: fields.env,
      };
      break;
    }
    if (!launch) {
      const binary = record(distribution.binary);
      if (binary) {
        // A PATH hint, not a download: prefer portable Unix names over Windows' .exe variants.
        const platforms = ["linux-x86_64", "linux-aarch64", "darwin-aarch64", "darwin-x86_64"];
        const candidates = [
          ...platforms.map((platform) => binary[platform]),
          ...Object.values(binary),
        ];
        for (const candidate of candidates) {
          const dist = record(candidate);
          if (!dist || typeof dist.cmd !== "string") continue;
          const fields = launchFields(dist);
          const command = dist.cmd.replaceAll("\\", "/").split("/").at(-1);
          if (!fields || !command || command === "." || command === "..") continue;
          pathCommand = { command, args: fields.args };
          break;
        }
      }
    }
    if (!launch && !pathCommand) continue;
    const command = launch ?? { ...pathCommand!, env: [] };
    if (
      acpAgentDefinitionError({
        agentId: entry.id,
        name: entry.name,
        ...command,
        enabled: true,
        source: "registry",
      })
    )
      continue;
    result.push({
      id: entry.id,
      name: entry.name.trim(),
      version: entry.version,
      ...(entry.description !== undefined ? { description: entry.description as string } : {}),
      ...(entry.icon !== undefined ? { icon: entry.icon as string } : {}),
      ...(launch ? { launch } : { pathCommand }),
    });
    seen.add(entry.id);
  }
  return result;
}

/**
 * Fetches and normalizes the public ACP registry on demand (owner-only at the router), reading at
 * most 1 MiB and giving up after ten seconds. Upstream failures are refused generically.
 */
export async function registryAgents(upstream: typeof fetch): Promise<RegistryAgent[]> {
  let response: Response;
  try {
    response = await upstream(REGISTRY_URL, { signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS) });
  } catch {
    throw new AppError("CONFLICT", "ACP registry could not be fetched.");
  }
  if (!response.ok || !response.body) {
    throw new AppError("CONFLICT", "ACP registry could not be fetched.");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > REGISTRY_BYTES_MAX) {
        await reader.cancel();
        throw new AppError("CONFLICT", "ACP registry exceeds the 1 MiB limit.");
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  try {
    return normalizeRegistryAgents(JSON.parse(text));
  } catch {
    throw new AppError("CONFLICT", "ACP registry could not be fetched.");
  }
}
