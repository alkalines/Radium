import { and, asc, count, eq, sql } from "drizzle-orm";
import * as z from "zod";
import { MCP_BEARER_SECRET_KEY } from "contracts/chatroom/tools";
import type { Database } from "../drivers/types";
import { AppError } from "../errors";
import { credentialPreview } from "../gateway/credentials";
import {
  getSecret,
  putSecret,
  removeSecret,
  type SecretLocation,
  type SecretReadResult,
} from "../gateway/secrets";
import type { Runtime } from "../runtime";
import {
  EXA_TOOL_CREDENTIAL_PROVIDER,
  normalizeMcpUrl,
  requireExaApiKey,
  requireMcpName,
} from "./aisdk-tools";
import { mcpServers } from "./schema";

/**
 * MCP (Model Context Protocol) server management and the Exa credential. Each server belongs to
 * a workspace and may carry a secret (a bearer token today) in the Secret Store, with a masked
 * preview kept on the row for display. Authorization (owner or member) is the procedure's;
 * writes are owner-only.
 */

type SecretsRuntime = Pick<Runtime, "drivers" | "secrets">;

/** Secret name of an MCP bearer token (`convex/secrets.ts` `MCP_SECRET_NAME`; imported rows). */
const MCP_SECRET_NAME = "bearer";
/** Secret name of the Exa credential (`EXA_SECRET_NAME`). */
const EXA_SECRET_NAME = "exa";
/** Preview key of the Exa API key in the secret's metadata. */
const EXA_API_KEY_SECRET = "apiKey";

/** `workspace:<id>:mcp:<server>` (`workspaceMcpSecretNamespace`). */
function mcpLocation(workspace: string, server: string): SecretLocation {
  return { namespace: `workspace:${workspace}:mcp:${server}`, name: MCP_SECRET_NAME };
}

/** `workspace:<id>:tools` (`workspaceExaSecretNamespace`). */
function exaLocation(workspace: string): SecretLocation {
  return { namespace: `workspace:${workspace}:tools`, name: EXA_SECRET_NAME };
}

/**
 * Reads a secret; a row that exists but cannot be used (undecryptable, expired, key retired)
 * needs recovery and fails loudly instead of reading as absent.
 */
async function readSecret(
  db: Database,
  runtime: Pick<Runtime, "secrets">,
  location: SecretLocation,
  description: string,
): Promise<SecretReadResult> {
  let result: SecretReadResult;
  try {
    result = await getSecret(db, runtime.secrets, location);
  } catch (error) {
    throw new Error(`Secret Store recovery required for ${description}.`, { cause: error });
  }
  if (!result.ok && result.reason !== "not_found") {
    throw new Error(`Secret Store recovery required for ${description} (${result.reason}).`);
  }
  return result;
}

/** Bounds of the MCP inputs. */
export const MAX_MCP_NAME_LENGTH = 200;
export const MAX_MCP_URL_LENGTH = 2048;
export const MAX_MCP_SECRET_LENGTH = 4096;
/** MCP servers per workspace; the list and every tool selection read at most this many. */
const MAX_MCP_SERVERS = 200;

/** How the backend authenticates to an MCP server; only `none` and `bearer` exist. */
export const mcpAuthInput = z.union([
  z.object({ type: z.literal("none") }),
  z.object({ type: z.literal("bearer") }),
]);
export type McpAuthInput = z.infer<typeof mcpAuthInput>;

export const createMcpServerInput = z.object({
  name: z.string().max(MAX_MCP_NAME_LENGTH),
  url: z.string().max(MAX_MCP_URL_LENGTH),
  auth: mcpAuthInput,
  secret: z.string().max(MAX_MCP_SECRET_LENGTH).optional(),
  codeMode: z.boolean().optional(),
});
export type CreateMcpServerInput = z.infer<typeof createMcpServerInput>;

export const updateMcpServerInput = z.object({
  server: z.string().min(1).max(256),
  name: z.string().max(MAX_MCP_NAME_LENGTH).optional(),
  url: z.string().max(MAX_MCP_URL_LENGTH).optional(),
  auth: mcpAuthInput.optional(),
  secret: z.string().max(MAX_MCP_SECRET_LENGTH).optional(),
  codeMode: z.boolean().optional(),
});
export type UpdateMcpServerInput = z.infer<typeof updateMcpServerInput>;

function bearerPreview(secret: string) {
  return { [MCP_BEARER_SECRET_KEY]: credentialPreview(secret.trim()) };
}

/** A workspace's MCP servers, oldest first. Never returns secrets, only a masked preview. */
export async function listMcpServers(runtime: SecretsRuntime, workspace: string) {
  const db = runtime.drivers.db;
  const rows = await db
    .select()
    .from(mcpServers)
    .where(eq(mcpServers.workspace, workspace))
    .orderBy(asc(mcpServers.createdAt), asc(mcpServers.id))
    .limit(MAX_MCP_SERVERS);

  const result = [];
  for (const server of rows) {
    const secret =
      server.auth.type === "bearer"
        ? await readSecret(
            db,
            runtime,
            mcpLocation(workspace, server.id),
            "workspace MCP bearer token",
          )
        : null;
    result.push({
      id: server.id,
      createdAt: server.createdAt.getTime(),
      name: server.name,
      url: server.url,
      transport: server.transport,
      auth: { type: server.auth.type },
      preview: server.auth.type === "bearer" ? server.preview : null,
      hasSecret: secret?.ok === true,
      codeMode: server.codeMode,
    });
  }
  return result;
}

/**
 * Creates an MCP server and stores its bearer token, in one transaction. `codeMode` (default
 * `true`) keeps its tools inside Code Mode; `false` exposes them as direct tool calls.
 */
export async function createMcpServer(
  runtime: SecretsRuntime,
  workspace: { id: string; ownerId: string },
  input: CreateMcpServerInput,
): Promise<string> {
  const name = requireMcpName(input.name);
  const url = normalizeMcpUrl(input.url);
  const secret = input.secret?.trim();
  if (input.auth.type === "bearer" && !secret) {
    throw new AppError("BAD_REQUEST", "A bearer token is required for bearer authentication.");
  }
  const preview = input.auth.type === "bearer" && secret ? bearerPreview(secret) : null;

  return await runtime.drivers.db.transaction(async (tx) => {
    // Serializes creation per workspace so the server cap holds.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`mcp:${workspace.id}`}, 0))`,
    );
    const [existing] = await tx
      .select({ count: count() })
      .from(mcpServers)
      .where(eq(mcpServers.workspace, workspace.id));
    if (existing!.count >= MAX_MCP_SERVERS) {
      throw new AppError("BAD_REQUEST", "MCP server limit reached.");
    }
    const [server] = await tx
      .insert(mcpServers)
      .values({
        workspace: workspace.id,
        userId: workspace.ownerId,
        name,
        url,
        transport: "http",
        auth: input.auth,
        preview,
        codeMode: input.codeMode ?? true,
      })
      .returning({ id: mcpServers.id });
    if (input.auth.type === "bearer" && secret) {
      await putSecret(tx, runtime.secrets, mcpLocation(workspace.id, server!.id), secret, {
        kind: "mcp",
        mcpServer: server!.id,
        preview,
      });
    }
    return server!.id;
  });
}

/**
 * Updates an MCP server. `secret` is only touched when provided: a new value replaces the
 * stored token, omitting it keeps the existing one (a switch away from `bearer` clears it).
 * The server row is locked, so concurrent updates and deletes of one server apply in turn.
 */
export async function updateMcpServer(
  runtime: SecretsRuntime,
  workspace: string,
  input: UpdateMcpServerInput,
) {
  const name = input.name === undefined ? undefined : requireMcpName(input.name);
  const url = input.url === undefined ? undefined : normalizeMcpUrl(input.url);
  const secret = input.secret?.trim();

  await runtime.drivers.db.transaction(async (tx) => {
    const [server] = await tx
      .select()
      .from(mcpServers)
      .where(and(eq(mcpServers.id, input.server), eq(mcpServers.workspace, workspace)))
      .for("update");
    if (!server) throw new AppError("NOT_FOUND", "MCP server not found.");

    const auth = input.auth ?? server.auth;
    let preview = server.preview;
    const location = mcpLocation(workspace, server.id);

    if (auth.type !== "bearer") {
      preview = null;
      await removeSecret(tx, location);
    } else if (secret) {
      preview = bearerPreview(secret);
      await putSecret(tx, runtime.secrets, location, secret, {
        kind: "mcp",
        mcpServer: server.id,
        preview,
      });
    } else if (!(await readSecret(tx, runtime, location, "workspace MCP bearer token")).ok) {
      throw new AppError("BAD_REQUEST", "A bearer token is required for bearer authentication.");
    }

    await tx
      .update(mcpServers)
      .set({
        auth,
        preview,
        ...(name === undefined ? {} : { name }),
        ...(url === undefined ? {} : { url }),
        ...(input.codeMode === undefined ? {} : { codeMode: input.codeMode }),
      })
      .where(eq(mcpServers.id, server.id));
  });
}

/**
 * Deletes an MCP server with its secret; unknown servers are a no-op. The server's rows in the
 * workspace defaults and chat overrides go with it (foreign key cascade).
 */
export async function deleteMcpServer(runtime: SecretsRuntime, workspace: string, server: string) {
  await runtime.drivers.db.transaction(async (tx) => {
    const [row] = await tx
      .select({ id: mcpServers.id })
      .from(mcpServers)
      .where(and(eq(mcpServers.id, server), eq(mcpServers.workspace, workspace)))
      .for("update");
    if (!row) return;
    await removeSecret(tx, mcpLocation(workspace, row.id));
    await tx.delete(mcpServers).where(eq(mcpServers.id, row.id));
  });
  return true;
}

export const exaApiKeyInput = z.object({ apiKey: z.string().max(MAX_MCP_SECRET_LENGTH) });

/** The masked preview of the workspace's Exa key, or `null` if none is set. */
export async function getExaApiKey(
  runtime: SecretsRuntime,
  workspace: string,
): Promise<{ preview: string } | null> {
  const row = await readSecret(
    runtime.drivers.db,
    runtime,
    exaLocation(workspace),
    "workspace Exa credential",
  );
  if (!row.ok) return null;
  const metadata = z
    .object({ preview: z.record(z.string(), z.string()) })
    .safeParse(row.metadata);
  const preview = metadata.success ? metadata.data.preview[EXA_API_KEY_SECRET] : undefined;
  return preview ? { preview } : null;
}

/** Creates or replaces the workspace's Exa API key. */
export async function setExaApiKey(runtime: SecretsRuntime, workspace: string, apiKey: string) {
  const key = requireExaApiKey(apiKey);
  await putSecret(runtime.drivers.db, runtime.secrets, exaLocation(workspace), key, {
    kind: "exa",
    workspace,
    preview: { [EXA_API_KEY_SECRET]: credentialPreview(key) },
  });
}

/** Deletes the workspace's Exa API key. */
export async function deleteExaApiKey(runtime: SecretsRuntime, workspace: string) {
  await removeSecret(runtime.drivers.db, exaLocation(workspace));
  return true;
}

/**
 * A built-in tool provider's workspace credential, for server-side execution only. The
 * validated provider picks the secret; callers cannot name arbitrary secrets.
 */
export async function builtinToolCredential(
  runtime: SecretsRuntime,
  workspace: string,
  provider: typeof EXA_TOOL_CREDENTIAL_PROVIDER,
): Promise<string | null> {
  if (provider !== EXA_TOOL_CREDENTIAL_PROVIDER) return null;
  const row = await readSecret(
    runtime.drivers.db,
    runtime,
    exaLocation(workspace),
    "workspace Exa credential",
  );
  return row.ok ? row.value : null;
}

/** The bearer token of a workspace MCP server, for the run that connects to it. */
export async function mcpBearerToken(
  runtime: SecretsRuntime,
  workspace: string,
  server: string,
): Promise<string | null> {
  const row = await readSecret(
    runtime.drivers.db,
    runtime,
    mcpLocation(workspace, server),
    "workspace MCP bearer token",
  );
  return row.ok ? row.value : null;
}
