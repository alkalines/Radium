import { and, eq } from "drizzle-orm";
import type { TelemetrySettings } from "contracts/telemetry/validators";
import {
  decodeCapsule,
  fromBase64Url,
  generateEncryptionKeyPair,
  openCapsule,
  openWithCapsule,
  toBase64Url,
} from "radium-crypto";
import { chats } from "../src/chatroom/schema";
import { e2eeWorkspaceEpochs } from "../src/e2ee/schema";
import type { Runtime } from "../src/runtime";
import {
  telemetryBlobs,
  telemetryNodes,
  telemetryRequests,
  telemetrySessions,
  telemetryToolsetTools,
} from "../src/telemetry/schema";
import { appRouter } from "../src/trpc/router";
import { workspaceMembers, workspaces } from "../src/workspaces/schema";
import { setWorkspaceKeyEpoch } from "../src/workspaces/workspaces";
import { startCapture } from "../src/telemetry/capture";
import { classicUser } from "./users";

/** Telemetry test fixtures: workspaces with members and chats, and rows inserted directly. */

export type Account = { id: string; headers: Headers };

let accounts = 0;

export function caller(runtime: Runtime, account: Account) {
  return appRouter.createCaller({ runtime, headers: account.headers });
}

/** A signed-in account with its own personal workspace. */
export async function account(runtime: Runtime, label = "telemetry") {
  const user = await classicUser(runtime, `${label}${++accounts}-${crypto.randomUUID()}@example.test`);
  const workspace = await caller(runtime, user).workspaces.ensurePersonal();
  return { ...user, workspace: workspace as string };
}

/**
 * An owner's workspace with a member, an outsider, and three chats: the owner's
 * workspace-scoped chat, the member's personal chat and a chat the member shared without the
 * owner. `keyed` gives the workspace an owner key epoch (its seed is returned) so capture seals
 * content.
 */
export async function telemetryWorkspace(runtime: Runtime, options: { keyed?: boolean } = {}) {
  const db = runtime.drivers.db;
  const owner = await account(runtime, "owner");
  const member = await account(runtime, "member");
  const outsider = await account(runtime, "outsider");
  const workspace = owner.workspace;
  await db.insert(workspaceMembers).values({ workspace, userId: member.id, role: "member" });

  const chat = async (userId: string, scope: "personal" | "shared" | "workspace") => {
    const [row] = await db.insert(chats).values({ workspace, userId, scope }).returning();
    return row!.id;
  };

  let seed: Uint8Array | undefined;
  if (options.keyed) {
    const keys = await generateEncryptionKeyPair();
    await db.insert(e2eeWorkspaceEpochs).values({
      workspace,
      epoch: 1,
      suite: 1,
      memberKeyId: toBase64Url(new Uint8Array(16).fill(1)),
      memberPublicKey: keys.publicKey,
      ownerKeyId: toBase64Url(new Uint8Array(16).fill(2)),
      ownerPublicKey: keys.publicKey,
      createdBy: owner.id,
    });
    await setWorkspaceKeyEpoch(db, workspace, 1);
    seed = keys.seed;
  }

  return {
    workspace,
    member,
    owner,
    outsider,
    seed,
    sharedChat: await chat(owner.id, "workspace"),
    memberPersonalChat: await chat(member.id, "personal"),
    memberSharedChat: await chat(member.id, "shared"),
  };
}

export type TelemetryWorkspace = Awaited<ReturnType<typeof telemetryWorkspace>>;

/** Archives (or restores) a workspace directly. */
export async function setArchived(runtime: Runtime, workspace: string, archived: boolean) {
  await runtime.drivers.db
    .update(workspaces)
    .set({ archivedAt: archived ? new Date() : null })
    .where(eq(workspaces.id, workspace));
}

type BlobKind = (typeof telemetryBlobs.$inferInsert)["kind"];

export async function insertBlob(
  runtime: Runtime,
  workspace: string,
  kind: BlobKind,
  hash: string,
  value?: unknown,
  extra: Partial<typeof telemetryBlobs.$inferInsert> = {},
) {
  const content = value === undefined ? undefined : JSON.stringify(value);
  const [row] = await runtime.drivers.db
    .insert(telemetryBlobs)
    .values({ workspace, hash, kind, size: content?.length ?? 0, content, ...extra })
    .returning();
  return row!.id;
}

export async function insertToolset(runtime: Runtime, toolset: string, tools: string[]) {
  if (tools.length === 0) return;
  await runtime.drivers.db
    .insert(telemetryToolsetTools)
    .values(tools.map((tool, position) => ({ toolset, tool, position })));
}

export async function insertNode(
  runtime: Runtime,
  workspace: string,
  hash: string,
  depth: number,
  parent: string | undefined,
  blob: string,
  origin: "input" | "output" = "input",
) {
  const [row] = await runtime.drivers.db
    .insert(telemetryNodes)
    .values({ workspace, hash, depth, parent, blob, origin })
    .returning();
  return row!.id;
}

export async function insertSession(
  runtime: Runtime,
  workspace: string,
  key: string,
  extra: Partial<typeof telemetrySessions.$inferInsert> = {},
) {
  const [row] = await runtime.drivers.db
    .insert(telemetrySessions)
    .values({ workspace, key, source: "gateway", startedAt: new Date(100), ...extra })
    .returning();
  return row!.id;
}

type RequestFields = Partial<typeof telemetryRequests.$inferInsert> & {
  requestId: string;
  startedAt?: Date;
};

/** A request row; `chat` implies a Chatroom request. */
export async function insertRequest(runtime: Runtime, workspace: string, fields: RequestFields) {
  const [row] = await runtime.drivers.db
    .insert(telemetryRequests)
    .values({
      workspace,
      source: fields.chat ? "chatroom" : "gateway",
      model: "provider/model",
      stream: false,
      status: "ok",
      startedAt: new Date(1),
      endedAt: new Date(2),
      durationMs: 1,
      attempts: [],
      recordsInputs: true,
      recordsOutputs: true,
      lineage: { kind: "root" },
      ...fields,
    })
    .returning();
  return row!.id;
}

/** Collects `runtime.defer` work so a test can wait for after-commit jobs. */
export function captureDeferred(runtime: Runtime) {
  const pending: Promise<unknown>[] = [];
  runtime.defer = (work) => {
    pending.push(work.catch(() => {}));
  };
  return async () => {
    while (pending.length > 0) await Promise.all(pending.splice(0));
  };
}

export const recordAll: TelemetrySettings = { enabled: true, recordInputs: true, recordOutputs: true };

let captured = 0;

/** Starts capturing one request as the Gateway drives it; the caller finishes it. */
export function captureRequest(
  runtime: Runtime,
  input: {
    workspace: string;
    userId: string;
    messages: unknown[];
    output?: string;
    requestId?: string;
    settings?: TelemetrySettings;
    sessionKey?: string;
    chatId?: string;
    apiKey?: string;
    extra?: Record<string, unknown>;
  },
) {
  const requestId = input.requestId ?? `captured-${++captured}`;
  const capture = startCapture(
    runtime,
    {
      workspace: input.workspace,
      userId: input.userId,
      requestId,
      settings: input.settings ?? recordAll,
      chatId: input.chatId,
      apiKey: input.apiKey,
    },
    {
      rawBody: { model: "provider/model", messages: input.messages, ...input.extra },
      session: input.sessionKey ? { primary: input.sessionKey, isSubagent: false } : undefined,
      source: input.chatId ? "chatroom" : "gateway",
      model: "provider/model",
      stream: false,
      startedAt: Date.now(),
    },
  );
  if (input.output !== undefined) {
    capture.outputResponse({
      id: "provider-response",
      created: 1,
      model: "m",
      object: "chat.completion",
      usage: {},
      choices: [
        { index: 0, finish_reason: "stop", message: { role: "assistant", content: input.output } },
      ],
    } as never);
  }
  return { capture, requestId };
}

export async function requestRow(runtime: Runtime, workspace: string, requestId: string) {
  const [row] = await runtime.drivers.db
    .select()
    .from(telemetryRequests)
    .where(and(eq(telemetryRequests.workspace, workspace), eq(telemetryRequests.requestId, requestId)));
  return row;
}

/** Opens a sealed blob as returned by the reads, as the owner's client would. */
export async function openWireBlob(
  workspace: string,
  seed: Uint8Array,
  blob: { hash: string; sealed: { requestId: string; capsule: string; envelope: string | null } | null },
) {
  const sealed = blob.sealed!;
  const capsuleKey = await openCapsule({
    seed,
    capsule: decodeCapsule(fromBase64Url(sealed.capsule)),
    aad: {
      table: "telemetry_capsules",
      workspace,
      parent: sealed.requestId,
      record: sealed.requestId,
      field: "capsule",
    },
  });
  const plaintext = await openWithCapsule({
    capsuleKey,
    envelope: fromBase64Url(sealed.envelope!),
    aad: {
      table: "telemetry_blobs",
      workspace,
      parent: sealed.requestId,
      record: blob.hash,
      field: "content",
    },
    pad: "content",
  });
  return JSON.parse(new TextDecoder().decode(plaintext)) as { content?: string; meta?: unknown };
}
