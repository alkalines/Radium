import {
  CODE_MODE_INTERACTION_TIMEOUT_MS,
  codeModeInteractionResponseValidator,
  type CodeModeInteractionKind,
  type CodeModeInteractionResponse,
} from "contracts/chatroom/code-mode";
import type { Database, Kv } from "../drivers/types";
import { AppError } from "../errors";
import { kvDelete, kvGet, kvSet } from "../kv";
import type { Runtime } from "../runtime";
import { signalChat, waitForSignal } from "../streams/signals";
import { requireChatAccess } from "./access";

/**
 * Prompts a running Code Mode program waits on (Convex `codemode_interactions`), kept in Valkey:
 * `cm:<id>` names the chat, the user whose request runs the program and the prompt kind;
 * `cm:<id>:answer` holds the first answer. Both expire shortly after the program's own deadline,
 * so a crashed run leaves nothing behind (Convex's prune cron is not needed). The first answer
 * wins through `SET NX`, then rings the chat's signal stream, which the waiting run long-polls
 * instead of reading the key every second.
 */

/** Kept past the answer deadline so the waiting run, not expiry, normally deletes the keys. */
const INTERACTION_EXPIRY_GRACE_MS = 60_000;
const INTERACTION_TTL_MS = CODE_MODE_INTERACTION_TIMEOUT_MS + INTERACTION_EXPIRY_GRACE_MS;
/** Longest stored answer (question answers are free text). */
const MAX_ANSWER_BYTES = 64 * 1024;
/**
 * One wait of {@link awaitInteractionResponse}. The Code Mode runtime calls it again until its
 * own deadline, so this only bounds how long one call holds a stream read open.
 */
const ANSWER_WAIT_MS = 30_000;
/** Signal topic of a Code Mode answer; `ids` names the prompt. */
const ANSWER_SIGNAL = "codeMode";

type InteractionRecord = { chat: string; user: string; kind: CodeModeInteractionKind };

const recordKey = (id: string) => `cm:${id}`;
const answerKey = (id: string) => `cm:${id}:answer`;

/** Opens a prompt for `userId` on `chatId`; the caller authorized the chat request first. */
export async function openInteraction(
  kv: Kv,
  input: { chatId: string; userId: string; kind: CodeModeInteractionKind },
): Promise<string> {
  const id = crypto.randomUUID();
  const record: InteractionRecord = { chat: input.chatId, user: input.userId, kind: input.kind };
  await kvSet(kv, recordKey(id), JSON.stringify(record), { ttlMs: INTERACTION_TTL_MS });
  return id;
}

/**
 * The first answer to a prompt, waiting up to {@link ANSWER_WAIT_MS} for it on chat `chat`'s
 * signal stream; `null` while it is unanswered (or already closed) or once `signal` aborts.
 */
export async function awaitInteractionResponse(
  runtime: Runtime,
  input: { chat: string; id: string; signal?: AbortSignal },
): Promise<CodeModeInteractionResponse | null> {
  const { kv } = runtime.drivers;
  return await waitForSignal(
    runtime,
    { chat: input.chat, topic: ANSWER_SIGNAL, id: input.id, timeoutMs: ANSWER_WAIT_MS, signal: input.signal },
    async () => {
      const value = await kvGet(kv, answerKey(input.id));
      return value === null ? null : codeModeInteractionResponseValidator.parse(JSON.parse(value));
    },
  );
}

/** Deletes a prompt once its answer was read or the program stopped waiting. Idempotent. */
export async function closeInteraction(kv: Kv, id: string): Promise<void> {
  await kvDelete(kv, answerKey(id));
  await kvDelete(kv, recordKey(id));
}

/**
 * Answers an open prompt (Convex `code_mode.answerInteraction`). Only the user whose request runs
 * the program may answer, and only while they can still access the chat. Missing, foreign and
 * closed prompts read the same; a second answer is refused so the first one stands.
 */
export async function answerInteraction(
  runtime: Runtime,
  userId: string,
  input: { interaction: string; response: CodeModeInteractionResponse },
): Promise<void> {
  const { db, kv } = runtime.drivers;
  const stored = await kvGet(kv, recordKey(input.interaction));
  const record = stored === null ? null : (JSON.parse(stored) as InteractionRecord);
  if (!record || record.user !== userId) {
    throw new AppError("NOT_FOUND", "This request is no longer waiting for an answer.");
  }
  await requireChatAccess(db, userId, record.chat);
  if (record.kind !== input.response.kind) {
    throw new AppError("BAD_REQUEST", "Answer does not match the request.");
  }
  const signed = input.response.kind === "approval" ? input.response.signature : undefined;
  if (
    signed &&
    (!/^[A-Za-z0-9_-]{86}$/.test(signed.signature) ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(signed.signerKeyId) ||
      !Number.isSafeInteger(signed.approvedAt) ||
      signed.approvedAt <= 0)
  ) {
    throw new AppError("BAD_REQUEST", "Invalid approval signature.");
  }
  const answer = JSON.stringify(input.response);
  if (new TextEncoder().encode(answer).byteLength > MAX_ANSWER_BYTES) {
    throw new AppError("BAD_REQUEST", "The answer is too long.");
  }
  const first = await kvSet(kv, answerKey(input.interaction), answer, {
    ttlMs: INTERACTION_TTL_MS,
    onlyIfAbsent: true,
  });
  if (!first) {
    throw new AppError("CONFLICT", "This request was already answered.");
  }
  await signalChat(runtime, record.chat, { topic: ANSWER_SIGNAL, ids: [input.interaction] });
}
