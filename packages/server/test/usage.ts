import { eq, isNotNull } from "drizzle-orm";
import { acpCommands, acpSessions } from "../src/acp/schema";
import { chatMembers, chats } from "../src/chatroom/schema";
import { jobs } from "../src/jobs/schema";
import { sweepJobs } from "../src/jobs/outbox";
import { models } from "../src/gateway/schema";
import type { Runtime } from "../src/runtime";
import { chatCompletions } from "../src/usage/schema";
import { workers } from "../src/worker/schema";
import { workspaceMembers, workspaces } from "../src/workspaces/schema";
import { addModel } from "./gateway";
import { classicUser } from "./users";

/** Usage test fixtures: rows written directly, the way the domains that own them would. */

export type Role = "owner" | "member" | "other" | "outsider";
export type Users = Record<Role, { id: string; headers: Headers }>;

/** One account per role; `member` and `other` join every {@link usageWorkspace}. */
export async function usageUsers(runtime: Runtime, prefix: string): Promise<Users> {
  const users = {} as Users;
  for (const role of ["owner", "member", "other", "outsider"] as const) {
    users[role] = await classicUser(runtime, `${prefix}-${role}@example.test`);
  }
  return users;
}

/** The workspace {@link usageWorkspace} creates: its id, its Worker and the test model's id. */
export type UsageFixture = { workspace: string; worker: string; model: string };

/** A workspace of `users.owner` with `member` and `other`, one Worker and the test model. */
export async function usageWorkspace(runtime: Runtime, users: Users): Promise<UsageFixture> {
  const db = runtime.drivers.db;
  const [row] = await db
    .insert(workspaces)
    .values({ ownerId: users.owner.id, name: "Usage" })
    .returning();
  const workspace = row!.id;
  await db.insert(workspaceMembers).values([
    { workspace, userId: users.member.id, role: "member" },
    { workspace, userId: users.other.id, role: "member" },
  ]);
  const [worker] = await db
    .insert(workers)
    .values({ workspace, name: "Box", capabilities: [], status: "active", identityEpoch: 1 })
    .returning();
  const slug = await addModel(runtime, "test/model");
  const [model] = await db.select().from(models).where(eq(models.slug, slug));
  return { workspace, worker: worker!.id, model: model!.id };
}

/** A chat of `userId`; `members` join a shared chat. */
export async function insertChat(
  runtime: Runtime,
  values: {
    workspace: string;
    userId: string;
    scope?: "personal" | "shared" | "workspace";
    members?: string[];
    project?: string;
  },
) {
  const db = runtime.drivers.db;
  const [chat] = await db
    .insert(chats)
    .values({
      workspace: values.workspace,
      userId: values.userId,
      scope: values.scope ?? "personal",
      project: values.project ?? null,
    })
    .returning();
  for (const userId of values.members ?? []) {
    await db.insert(chatMembers).values({
      chat: chat!.id,
      workspace: values.workspace,
      userId,
      lastInteractionAt: new Date(),
    });
  }
  return chat!.id;
}

/** A settled completion as the Gateway records it (only the fields usage reads vary). */
export async function insertCompletion(
  runtime: Runtime,
  values: {
    workspace: string;
    model: string;
    cost: number | null;
    chat?: string;
    userId?: string;
    apiKey?: string;
    clientSession?: string;
    byok?: boolean;
    tokens?: number;
    createdAt?: Date;
  },
) {
  const [row] = await runtime.drivers.db
    .insert(chatCompletions)
    .values({
      workspace: values.workspace,
      chat: values.chat ?? null,
      userId: values.userId ?? null,
      apiKey: values.apiKey ?? null,
      clientSession: values.clientSession ?? null,
      provider: "plain",
      byok: values.byok ?? true,
      model: values.model,
      streamed: false,
      canceled: false,
      genId: "gen",
      providerGenId: "upstream",
      promptTokens: values.tokens ?? 10,
      completionTokens: values.tokens ?? 10,
      usageDetails: { completion_tokens_details: {}, prompt_tokens_details: {} },
      cost: values.cost,
      pricingDetails: { prompt_tokens_details: {} },
      ttft: 1,
      genTime: 1,
      finishReason: "stop",
      ...(values.createdAt ? { createdAt: values.createdAt } : {}),
    })
    .returning({ id: chatCompletions.id });
  return row!.id;
}

/** An ACP chat of `userId` bound to `agentId` on `worker` (its `acp_sessions` row). */
export async function acpChat(
  runtime: Runtime,
  values: {
    workspace: string;
    worker: string;
    userId: string;
    agentId?: string;
    sessionId?: string;
    profile?: "native" | "gateway";
    scope?: "personal" | "shared" | "workspace";
  },
) {
  const chat = await insertChat(runtime, {
    workspace: values.workspace,
    userId: values.userId,
    scope: values.scope,
  });
  const [session] = await runtime.drivers.db
    .insert(acpSessions)
    .values({
      chat,
      workspace: values.workspace,
      worker: values.worker,
      agentId: values.agentId ?? "test-agent",
      agentVersion: "1",
      profile: values.profile ?? "native",
      cwd: "/work",
      sessionId: values.sessionId ?? null,
      status: "running",
      updatedAt: new Date(),
    })
    .returning();
  return { chat, session: session! };
}

/** A claimed command of `chat` (a prompt unless `kind` says otherwise). */
export async function claimedCommand(
  runtime: Runtime,
  values: {
    workspace: string;
    worker: string;
    chat: string;
    issuedBy: string;
    kind?: "prompt" | "cancel";
  },
) {
  const [command] = await runtime.drivers.db
    .insert(acpCommands)
    .values({
      workspace: values.workspace,
      worker: values.worker,
      chat: values.chat,
      kind: values.kind ?? "prompt",
      clientId: crypto.randomUUID(),
      issuedBy: values.issuedBy,
      status: "claimed",
      claimedAt: new Date(),
    })
    .returning({ id: acpCommands.id });
  return command!.id;
}

/**
 * Collects the runtime's deferred work (after-commit job dispatch) so a test can wait for it:
 * `settle()` drains it and the job queue, and fails when any job errored.
 */
export function deferredWork(runtime: Runtime) {
  const pending: Promise<unknown>[] = [];
  runtime.defer = (work) => {
    pending.push(work);
  };
  return async function settle() {
    for (let round = 0; round < 10; round++) {
      while (pending.length > 0) await Promise.all(pending.splice(0));
      if ((await sweepJobs(runtime)) === 0 && pending.length === 0) break;
    }
    const failed = await runtime.drivers.db
      .select({ kind: jobs.kind, lastError: jobs.lastError })
      .from(jobs)
      .where(isNotNull(jobs.lastError));
    if (failed.length > 0) throw new Error(`Jobs failed: ${JSON.stringify(failed)}`);
  };
}
