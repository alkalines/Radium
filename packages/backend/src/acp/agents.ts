import { ConvexError, v, type Infer } from "convex/values";
import type { Doc } from "../../convex/_generated/dataModel";
import { internal } from "../../convex/_generated/api";
import { action } from "../../convex/_generated/server";
import { authComponent } from "../../convex/auth";
import { ownedWorkspaceMutation, ownedWorkspaceQuery } from "../../convex/helpers";
import { workerQuery } from "../worker/machine";
import {
  ACP_AGENT_DEFINITIONS_MAX,
  acpAgentDefinitionError,
  acpAgentDefinitionValidator,
  type AcpAgentDefinition,
} from "./contract";

const definitionView = v.object({
  _id: v.id("acp_agents"),
  ...acpAgentDefinitionValidator.fields,
  updatedAt: v.number(),
});

function definitionFields(row: Doc<"acp_agents">): AcpAgentDefinition {
  const { _id, _creationTime, workspace, updatedAt, ...definition } = row;
  return definition;
}

/** Owner-only launch definitions; machine reports remain separate per Worker. */
export const ListAgentDefinitions = ownedWorkspaceQuery({
  args: {},
  returns: v.array(definitionView),
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("acp_agents")
      .withIndex("by_workspace_and_agentId", (q) => q.eq("workspace", ctx.workspace._id))
      .take(ACP_AGENT_DEFINITIONS_MAX);
    return rows
      .map((row) => ({ _id: row._id, ...definitionFields(row), updatedAt: row.updatedAt }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.agentId.localeCompare(b.agentId));
  },
});

/** Agent IDs are immutable: existing Sessions keep their original agent binding. */
export const SaveAgentDefinition = ownedWorkspaceMutation({
  args: { id: v.optional(v.id("acp_agents")), definition: acpAgentDefinitionValidator },
  returns: v.id("acp_agents"),
  handler: async (ctx, args) => {
    const message = acpAgentDefinitionError(args.definition);
    if (message) throw new ConvexError({ code: "ACP_INVALID_AGENT", message });
    const definition = {
      ...args.definition,
      name: args.definition.name.trim(),
      command: args.definition.command.trim(),
    };
    if (args.id) {
      const existing = await ctx.db.get(args.id);
      if (!existing || existing.workspace !== ctx.workspace._id)
        throw new ConvexError({ code: "ACP_AGENT_NOT_FOUND", message: "Agent not found." });
      if (existing.agentId !== definition.agentId)
        throw new ConvexError({
          code: "ACP_INVALID_AGENT",
          message: "Agent IDs cannot be changed.",
        });
      await ctx.db.replace(args.id, {
        workspace: ctx.workspace._id,
        ...definition,
        updatedAt: Date.now(),
      });
      return args.id;
    }
    const duplicate = await ctx.db
      .query("acp_agents")
      .withIndex("by_workspace_and_agentId", (q) =>
        q.eq("workspace", ctx.workspace._id).eq("agentId", definition.agentId),
      )
      .unique();
    if (duplicate)
      throw new ConvexError({ code: "ACP_AGENT_EXISTS", message: "This agent ID already exists." });
    const rows = await ctx.db
      .query("acp_agents")
      .withIndex("by_workspace_and_agentId", (q) => q.eq("workspace", ctx.workspace._id))
      .take(ACP_AGENT_DEFINITIONS_MAX);
    if (rows.length >= ACP_AGENT_DEFINITIONS_MAX)
      throw new ConvexError({
        code: "ACP_INVALID_AGENT",
        message: `A workspace supports at most ${ACP_AGENT_DEFINITIONS_MAX} agents.`,
      });
    return ctx.db.insert("acp_agents", {
      workspace: ctx.workspace._id,
      ...definition,
      updatedAt: Date.now(),
    });
  },
});

/** Deleting a definition never rewrites or deletes an existing Session. */
export const DeleteAgentDefinition = ownedWorkspaceMutation({
  args: { id: v.id("acp_agents") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.id);
    if (!existing || existing.workspace !== ctx.workspace._id)
      throw new ConvexError({ code: "ACP_AGENT_NOT_FOUND", message: "Agent not found." });
    await ctx.db.delete(args.id);
    return null;
  },
});

/** Workspace comes only from the verified machine identity, never query arguments. */
export const agentDefinitions = workerQuery({
  args: {},
  returns: v.array(acpAgentDefinitionValidator),
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("acp_agents")
      .withIndex("by_workspace_and_agentId", (q) => q.eq("workspace", ctx.worker.workspaceId))
      .take(ACP_AGENT_DEFINITIONS_MAX);
    return rows.filter((row) => row.enabled).map(definitionFields);
  },
});

const registryAgentValidator = v.object({
  id: v.string(),
  name: v.string(),
  version: v.string(),
  description: v.optional(v.string()),
  icon: v.optional(v.string()),
  launch: v.optional(
    v.object({
      command: v.string(),
      args: v.array(v.string()),
      env: v.array(v.object({ name: v.string(), value: v.string() })),
    }),
  ),
  pathCommand: v.optional(v.object({ command: v.string(), args: v.array(v.string()) })),
});
export type RegistryAgent = Infer<typeof registryAgentValidator>;
const REGISTRY_ENTRIES_MAX = 200;
const REGISTRY_BYTES_MAX = 1024 * 1024;
const REGISTRY_URL = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";

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

/** Fetch on demand, after checking workspace ownership through the internal action helper. */
export const RegistryAgents = action({
  args: { workspace: v.id("workspaces") },
  returns: v.array(registryAgentValidator),
  handler: async (ctx, args): Promise<RegistryAgent[]> => {
    const user = await authComponent.getAuthUser(ctx);
    const workspace = user
      ? await ctx.runQuery(internal.workspaces.getOwnedWorkspaceForUser, {
          workspace: args.workspace,
          userId: user._id,
        })
      : null;
    if (!workspace) throw new Error("Workspace not found.");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(REGISTRY_URL, { signal: controller.signal });
      if (!response.ok || !response.body) throw new Error("ACP registry could not be fetched.");
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
            throw new Error("ACP registry exceeds the 1 MiB limit.");
          }
          text += decoder.decode(value, { stream: true });
        }
        text += decoder.decode();
      } finally {
        reader.releaseLock();
      }
      return normalizeRegistryAgents(JSON.parse(text));
    } finally {
      clearTimeout(timeout);
    }
  },
});
