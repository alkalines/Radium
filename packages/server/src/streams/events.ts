import { and, eq } from "drizzle-orm";
import { chatAccess } from "../chatroom/access";
import { acpInteractions, acpSessions } from "../acp/schema";
import { chatMembers, chats } from "../chatroom/schema";
import type { Database } from "../drivers/types";
import type { Runtime } from "../runtime";
import { workers as workerRows } from "../worker/schema";
import { projects, workspaces } from "../workspaces/schema";
import { workspaceAccess } from "../workspaces/access";
import { existingStreams, type StreamScope } from "./rotating";

/**
 * Invalidation events (`docs/Backend_Migration/Live_Data.md`, Invalidation Events): after a
 * change commits, a small `{ topic, ids? }` message on the event stream of everyone who displays
 * it. Browsers map the topic to tRPC query keys and refetch what is mounted.
 *
 * - Events carry topic names and ids, never content.
 * - A workspace stream never names a personal or shared chat: chat events go to the creator's
 *   and members' user streams, and only `workspace`-scoped chats go to the workspace stream.
 * - Publishing is best effort after commit: a lost event means a stale view until the next
 *   refetch on focus or reconnect, never lost data. It never fails the change that caused it.
 */

/**
 * The topic of an event is the tRPC router whose queries it invalidates (`chats`, `acp`,
 * `workers`, `notifications`, …); browsers refetch that router's mounted queries, narrowed to
 * `ids` when the event names them.
 */
export type LiveEvent = { topic: string; ids?: string[] };

/** Routers whose owner changes members see the effect of; other topics reach the owner only. */
const MEMBER_TOPICS: Record<string, true> = {
  workspaces: true,
  projects: true,
  providers: true,
  models: true,
  tools: true,
  chatroom: true,
  e2ee: true,
};

/**
 * Appends `event` to the current stream of each of `scopes` that has one (a scope nobody reads
 * has no stream, and nobody to tell). Never throws.
 */
export async function publishEvent(runtime: Runtime, scopes: readonly StreamScope[], event: LiveEvent) {
  try {
    const paths = await existingStreams(runtime.drivers.kv, [...new Set(scopes)]);
    await Promise.all(paths.map((path) => runtime.streams.append(path, [event])));
  } catch (error) {
    console.error("live: event not published:", error instanceof Error ? error.message : "unknown error");
  }
}

/** {@link publishEvent} after the current response, through `runtime.defer`. */
export function deferEvent(runtime: Runtime, scopes: readonly StreamScope[], event: LiveEvent) {
  if (scopes.length > 0) runtime.defer(publishEvent(runtime, scopes, event));
}

export const userEvents = (user: string): StreamScope => `u/${user}/events`;
export const workspaceEvents = (workspace: string): StreamScope => `w/${workspace}/events`;
/** A Worker's inbox (`k/<worker>/inbox`): doorbells only, read by that Worker. */
export const workerInbox = (worker: string): StreamScope => `k/${worker}/inbox`;

/**
 * Rings `workers`' inboxes with `topic` after the response: each Worker refetches that topic
 * through tRPC. Workers also resync every topic on reconnect and every minute, so a lost
 * doorbell costs at most that delay.
 */
export function ringWorkers(runtime: Runtime, workers: readonly string[], topic: string) {
  deferEvent(runtime, workers.map(workerInbox), { topic });
}

/**
 * Where a workspace-level change of `topic` is announced: the workspace stream when members see
 * its effect, otherwise the owner's own stream (owner-only screens).
 */
export function workspaceTopicScope(topic: string, workspace: { id: string; ownerId: string }): StreamScope {
  return MEMBER_TOPICS[topic] ? workspaceEvents(workspace.id) : userEvents(workspace.ownerId);
}

/**
 * The streams that may show chat `chatId`: the workspace stream for a `workspace`-scoped chat,
 * otherwise the creator's and (shared) members' user streams. Empty for an unknown chat.
 */
export async function chatAudience(db: Database, chatId: string): Promise<StreamScope[]> {
  const [chat] = await db
    .select({ scope: chats.scope, userId: chats.userId, workspace: chats.workspace })
    .from(chats)
    .where(eq(chats.id, chatId));
  if (!chat) return [];
  if (chat.scope === "workspace") return [workspaceEvents(chat.workspace)];
  const scopes = [userEvents(chat.userId)];
  if (chat.scope === "shared") {
    const members = await db
      .select({ userId: chatMembers.userId })
      .from(chatMembers)
      .where(eq(chatMembers.chat, chatId));
    for (const member of members) scopes.push(userEvents(member.userId));
  }
  return scopes;
}

/** Tells chat `chatId`'s audience (and `alsoTo`, an audience it had before) about a change. */
export async function publishChatEvent(
  runtime: Runtime,
  chatId: string,
  topic: string,
  alsoTo: readonly StreamScope[] = [],
) {
  try {
    const scopes = [...alsoTo, ...(await chatAudience(runtime.drivers.db, chatId))];
    await publishEvent(runtime, scopes, { topic, ids: [chatId] });
  } catch (error) {
    console.error("live: chat event not published:", error instanceof Error ? error.message : "unknown error");
  }
}

/** {@link publishChatEvent} after the current response. */
export function deferChatEvent(runtime: Runtime, chatId: string, topic: string) {
  runtime.defer(publishChatEvent(runtime, chatId, topic));
}

/**
 * Announces a change of `topic` in `workspace` that did not come from a browser mutation (a
 * Worker report, a job), after the response: to the workspace or its owner by topic.
 */
export function deferWorkspaceEvent(runtime: Runtime, workspace: string, topic: string) {
  runtime.defer(
    (async () => {
      const row = await workspaceOwner(runtime.drivers.db, workspace);
      if (row) await publishEvent(runtime, [workspaceTopicScope(topic, row)], { topic });
    })(),
  );
}

/** Mutations whose result is the id of a chat they created. */
const CHAT_CREATING: Record<string, true> = {
  "chats.create": true,
  "chats.fork": true,
  "acp.createSession": true,
  "acp.openAgentSession": true,
  "acp.fork": true,
};

/** Mutations that may change who sees a chat: the audience before the change is told too. */
const AUDIENCE_CHANGING: Record<string, true> = { "chats.setScope": true, "chats.delete": true };

/** Routers whose browser mutations need no generic event: nobody else displays their result. */
const SILENT_TOPICS: Record<string, true> = { logging: true, chatFiles: true };

/** Browser mutations that publish nothing generic: heartbeats whose effect has its own event. */
const SILENT_PATHS: Record<string, true> = { "acp.watch": true };

/**
 * Worker inbox doorbells a browser mutation rings (`docs/Backend_Migration/Live_Data.md`,
 * Workers), by full path or, failing that, by router; and which Workers hear them: the chat's
 * bound Worker, the Worker the input names, or every active Worker of the input's workspace.
 */
const WORKER_DOORBELLS: Record<string, { topics: string[]; target: "chat" | "worker" | "workspace" }> = {
  "acp.prompt": { topics: ["commands", "warm"], target: "chat" },
  "acp.cancel": { topics: ["commands"], target: "chat" },
  "acp.setConfig": { topics: ["commands"], target: "chat" },
  "acp.setMode": { topics: ["commands"], target: "chat" },
  "acp.requestHistory": { topics: ["commands"], target: "chat" },
  "acp.startFork": { topics: ["commands"], target: "chat" },
  "acp.answer": { topics: ["answers"], target: "chat" },
  "acp.authenticate": { topics: ["commands"], target: "worker" },
  "acp.logout": { topics: ["commands"], target: "worker" },
  "acp.syncAgentSessions": { topics: ["commands"], target: "workspace" },
  "acp.saveAgentDefinition": { topics: ["definitions"], target: "workspace" },
  "acp.deleteAgentDefinition": { topics: ["definitions"], target: "workspace" },
  "chats.delete": { topics: ["commands", "warm"], target: "chat" },
  "workers.revoke": { topics: ["identity"], target: "worker" },
  "workers.issueGatewayKey": { topics: ["gateway"], target: "worker" },
  "workers.setGatewayAccess": { topics: ["gateway"], target: "worker" },
  "workers.setGatewayTelemetry": { topics: ["gateway"], target: "worker" },
  providers: { topics: ["gateway"], target: "workspace" },
  e2ee: { topics: ["trust"], target: "workspace" },
};

/** What a browser mutation names, read from its input and authorized before it runs. */
export type MutationSubject = {
  topic: string;
  chat?: string;
  project?: string;
  workspace?: string;
  /** The chat's audience before the mutation (audience-changing mutations only). */
  before: StreamScope[];
  /** Worker inbox doorbells to ring once the mutation succeeded. */
  doorbells: { workers: string[]; topics: string[] } | null;
};

/**
 * The subject of browser mutation `path` (`sessionProcedure` and the workspace procedures built
 * on it), or `null` when it publishes nothing generic. It runs before the mutation (so a deleted
 * chat's audience and Worker are still known) on the raw input, which the procedure has not
 * validated yet and may carry extra keys: every id is therefore used only after the caller's
 * access to it is checked here, so a request can never address another tenant's streams or
 * Workers. A chat needs chat access, a workspace needs membership, Worker doorbells need the
 * workspace owner (and a Worker of that workspace). An ACP answer names its interaction, whose
 * chat is looked up here.
 */
export async function mutationSubject(
  db: Database,
  userId: string,
  path: string,
  raw: unknown,
): Promise<MutationSubject | null> {
  const topic = path.split(".")[0]!;
  if (SILENT_TOPICS[topic] || SILENT_PATHS[path]) return null;
  const input = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === "string" && value.length <= 256 ? value : undefined);

  let chat = text(input.chatId) ?? text(input.chat);
  const interaction = topic === "acp" ? text(input.interaction) : undefined;
  if (!chat && interaction) {
    const [row] = await db
      .select({ chat: acpInteractions.chat })
      .from(acpInteractions)
      .where(eq(acpInteractions.id, interaction));
    chat = row?.chat;
  }
  if (chat && !(await chatAccess(db, userId, chat))) chat = undefined;

  let workspace = text(input.workspace);
  const access = workspace ? await workspaceAccess(db, userId, workspace) : null;
  if (!access) workspace = undefined;

  const doorbell = WORKER_DOORBELLS[path] ?? WORKER_DOORBELLS[topic];
  let workers: string[] = [];
  if (doorbell?.target === "chat" && chat) {
    const [session] = await db
      .select({ worker: acpSessions.worker })
      .from(acpSessions)
      .where(eq(acpSessions.chat, chat));
    if (session) workers = [session.worker];
  } else if (doorbell && doorbell.target !== "chat" && workspace && access?.role === "owner") {
    const named = doorbell.target === "worker" ? (text(input.workerId) ?? text(input.worker)) : undefined;
    if (doorbell.target === "workspace" || named) {
      const rows = await db
        .select({ id: workerRows.id })
        .from(workerRows)
        .where(
          and(
            eq(workerRows.workspace, workspace),
            named ? eq(workerRows.id, named) : eq(workerRows.status, "active"),
          ),
        );
      workers = rows.map((row) => row.id);
    }
  }

  return {
    topic,
    chat,
    project: text(input.project),
    workspace,
    before: chat && AUDIENCE_CHANGING[path] ? await chatAudience(db, chat) : [],
    doorbells: doorbell && workers.length > 0 ? { workers, topics: doorbell.topics } : null,
  };
}

/**
 * Publishes the generic event of a browser mutation that succeeded, after the response:
 *
 * - a chat mutation (or one that created a chat) tells the chat's audience, ids = the chat;
 * - a Project mutation tells the Project's workspace;
 * - a workspace mutation tells the workspace, or only its owner for owner-only topics;
 * - anything else (preferences, trust store, notifications) tells the caller's other tabs.
 */
export function publishMutationEvent(
  runtime: Runtime,
  subject: MutationSubject,
  context: { path: string; userId: string; result: unknown },
) {
  runtime.defer(
    (async () => {
      if (subject.doorbells) {
        const inboxes = subject.doorbells.workers.map(workerInbox);
        for (const topic of subject.doorbells.topics) await publishEvent(runtime, inboxes, { topic });
      }
      // A created chat is the subject even when the input names another one (a fork's source).
      const created = CHAT_CREATING[context.path] && typeof context.result === "string" ? context.result : undefined;
      const chat = created ?? subject.chat;
      if (chat) {
        await publishChatEvent(runtime, chat, subject.topic, subject.before);
        return;
      }
      // A Project counts only inside a workspace the caller can see (checked in `mutationSubject`
      // for `workspace`; here for the Project's own).
      const projectHome = subject.project ? await projectWorkspace(runtime.drivers.db, subject.project) : null;
      const workspace =
        projectHome && (await workspaceAccess(runtime.drivers.db, context.userId, projectHome.id))
          ? projectHome
          : subject.workspace
            ? await workspaceOwner(runtime.drivers.db, subject.workspace)
            : null;
      const scope = workspace ? workspaceTopicScope(subject.topic, workspace) : userEvents(context.userId);
      await publishEvent(runtime, [scope], { topic: subject.topic });
    })(),
  );
}

async function workspaceOwner(db: Database, workspace: string) {
  const [row] = await db
    .select({ id: workspaces.id, ownerId: workspaces.ownerId })
    .from(workspaces)
    .where(eq(workspaces.id, workspace));
  return row ?? null;
}

async function projectWorkspace(db: Database, project: string) {
  const [row] = await db
    .select({ id: workspaces.id, ownerId: workspaces.ownerId })
    .from(projects)
    .innerJoin(workspaces, eq(workspaces.id, projects.workspace))
    .where(eq(projects.id, project));
  return row ?? null;
}
