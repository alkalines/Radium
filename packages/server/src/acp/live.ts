import { and, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { fromBase64Url, toBase64Url } from "radium-crypto";
import { z } from "zod";
import {
  ACP_COLD_AFTER_MS,
  ACP_FRAMES_PER_APPEND,
  ACP_SEALED_FRAME_BYTES,
  acpFrameKindValidator,
  validAcpToken,
} from "contracts/acp/contract";
import type { Database, Kv } from "../drivers/types";
import { dispatchJobs } from "../jobs/outbox";
import { kvDelete, kvGet, kvSet } from "../kv";
import type { Runtime } from "../runtime";
import { queueStreamDeletion } from "../streams/deletion";
import { publishChatEvent, ringWorkers } from "../streams/events";
import { StreamServerError } from "../streams/server";
import { accessibleSession, acpError, findSession } from "./policy";
import { acpSessions } from "./schema";
import { coolingCandidates, coolWarm, isWarm, warmWorkersPage, watchWarm } from "./warm";

/*
 * ACP epochs on Durable Streams (`docs/Backend_Migration/Live_Data.md`, ACP Sessions; Convex
 * `src/acp/live.ts`, `appendFrames` and `coolSessions`). Each warm epoch of a chat is the stream
 * `c/<chat>/acp/<epoch>`: the backend creates it and writes the Worker-signed capsule as its
 * first message; the bound Worker appends sealed frames through `POST /api/streams/…` (the only
 * client append path); viewers read it through the GET proxy. Cooling and supersession delete it.
 */

/** Sliding expiry of an epoch stream: the backstop if a deletion is ever lost. */
const EPOCH_STREAM_TTL_SECONDS = 300;
/** Producer id of the capsule append, distinct from every Worker producer (`<worker>:<epoch>`). */
const CAPSULE_PRODUCER = "radium:capsule";
/** How long the append fence of a chat is cached; startEpoch and cooling drop it at once. */
const FENCE_TTL_MS = 10_000;
/** Chats one cooling run cools at most; the rest wait for the next minute. */
const COOL_BATCH = 256;
/** Warm-Worker pages (`SSCAN`, about 100 each) one cooling run visits at most. */
const COOL_WORKER_PAGES = 20;
/** Where the next cooling run resumes its walk over the warm-Worker set. */
const COOL_CURSOR_KEY = "acp:cool:cursor";
/** Longest serialized frame message (a base64url sealed payload and small metadata). */
const FRAME_JSON_BYTES = Math.ceil((ACP_SEALED_FRAME_BYTES * 4) / 3) + 256;
/** Request bodies of an append are refused past this size before they are parsed. */
export const ACP_APPEND_BODY_BYTES = ACP_FRAMES_PER_APPEND * FRAME_JSON_BYTES;

/** The stream of epoch `epoch` of `chat`. */
export function epochStreamPath(chat: string, epoch: number): string {
  return `c/${chat}/acp/${epoch}`;
}

/**
 * The first message of every epoch stream: the capsule its frames are sealed under, as the Worker
 * signed it (`AcpStreamCapsule`, bytes as base64url). Frames carry no `type`.
 */
type EpochCapsuleMessage = { type: "capsule"; chatEpoch: number; capsule: string; signature: string };

/**
 * Creates the stream of a started epoch and stores its capsule as the first message; repeating it
 * is safe. The capsule append is an idempotent-producer write at sequence 0, so of concurrent or
 * retried starts exactly one capsule is stored; a start with different capsule bytes is then
 * refused (`ACP_FRAME_CONFLICT`), and a stream that is gone (`ACP_STALE_EPOCH`) needs a newer epoch.
 */
export async function writeEpochCapsule(
  runtime: Runtime,
  chat: string,
  epoch: number,
  capsule: { chatEpoch: number; capsule: Uint8Array; signature: Uint8Array },
) {
  const path = epochStreamPath(chat, epoch);
  const message: EpochCapsuleMessage = {
    type: "capsule",
    chatEpoch: capsule.chatEpoch,
    capsule: toBase64Url(capsule.capsule),
    signature: toBase64Url(capsule.signature),
  };
  await runtime.streams.create(path, { ttlSeconds: EPOCH_STREAM_TTL_SECONDS });
  const response = await runtime.streams.forward(path, {
    method: "POST",
    query: new URLSearchParams(),
    headers: {
      "Content-Type": "application/json",
      "Producer-Id": CAPSULE_PRODUCER,
      "Producer-Epoch": "0",
      "Producer-Seq": "0",
    },
    body: new Blob([JSON.stringify([message])]).stream(),
    signal: AbortSignal.timeout(10_000),
  });
  await response.body?.cancel();
  // 200 stored now, 204 an earlier start stored one, 409 the Worker already closed the stream.
  if (response.status === 404 || response.status === 410) acpError("ACP_STALE_EPOCH");
  if (!response.ok && response.status !== 409) throw new StreamServerError(response.status, "append");
  const page = await runtime.streams.read(path, "-1");
  if (!page) acpError("ACP_STALE_EPOCH");
  const stored = page.messages[0] as Partial<EpochCapsuleMessage> | undefined;
  if (
    stored?.type !== "capsule" ||
    stored.chatEpoch !== message.chatEpoch ||
    stored.capsule !== message.capsule ||
    stored.signature !== message.signature
  )
    acpError("ACP_FRAME_CONFLICT");
}

const fenceKey = (chat: string) => `acp:fence:${chat}`;

/** The append fence of a chat: its bound Worker and the epoch it may append to (`null`: none). */
type EpochFence = { worker: string; epoch: number | null };

/**
 * The append fence of `chat` (`null` for a chat without a session): the epoch its bound Worker
 * may append to is the current one when started (`> 0`), above `cooled_epoch` and warm. Cached
 * in Valkey for a few seconds, since every append asks; starting and cooling an epoch drop the
 * cache. A cached fence that would refuse `requested` is re-read from Postgres first, so a cache
 * entry written just before an epoch started (a read racing `startEpoch`) never refuses the new
 * epoch. A stale entry can only admit appends to a stream that cooling or supersession is
 * deleting.
 */
export async function epochFence(runtime: Runtime, chat: string, requested: number): Promise<EpochFence | null> {
  const { db, kv } = runtime.drivers;
  const cached = await kvGet(kv, fenceKey(chat));
  if (cached !== null) {
    const fence = JSON.parse(cached) as EpochFence | null;
    if (fence?.epoch === requested) return fence;
  }
  const session = await findSession(db, chat);
  const fence: EpochFence | null = session
    ? {
        worker: session.worker,
        epoch:
          session.epoch > 0 &&
          session.epoch > (session.cooledEpoch ?? 0) &&
          (await isWarm(kv, session.worker, chat))
            ? session.epoch
            : null,
      }
    : null;
  await kvSet(kv, fenceKey(chat), JSON.stringify(fence), { ttlMs: FENCE_TTL_MS });
  return fence;
}

/** Drops the cached append fence of `chat` (its epoch started, cooled, or the chat is gone). */
export async function forgetEpochFence(kv: Kv, chat: string): Promise<void> {
  await kvDelete(kv, fenceKey(chat));
}

const frameInput = z.object({
  seqFrom: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  seqTo: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  kind: acpFrameKindValidator,
  payload: z.unknown(),
});

/** One frame as an epoch stream stores it; `payload` is the sealed envelope as base64url. */
type EpochFrame = { seqFrom: number; seqTo: number; kind: z.output<typeof acpFrameKindValidator>; payload: string };

/**
 * Validates the JSON body of a Worker append and returns the frames as they are stored: exactly
 * `{seqFrom, seqTo, kind, payload}` with a sealed `payload` (base64url of at most
 * `ACP_SEALED_FRAME_BYTES`), or the ACP code that refuses the append. A payload that is not
 * base64url (the plaintext JSON of the ops) is `ACP_PLAINTEXT_REFUSED`, since every ACP workspace
 * on this backend is keyed.
 */
export function parseAppendFrames(body: unknown): EpochFrame[] | string {
  if (!Array.isArray(body) || body.length < 1 || body.length > ACP_FRAMES_PER_APPEND) return "ACP_INVALID_FRAMES";
  const frames: EpochFrame[] = [];
  for (const entry of body) {
    const parsed = frameInput.safeParse(entry);
    if (!parsed.success || parsed.data.seqTo < parsed.data.seqFrom) return "ACP_INVALID_FRAMES";
    const { payload } = parsed.data;
    if (typeof payload !== "string") return "ACP_PLAINTEXT_REFUSED";
    if (payload.length > Math.ceil((ACP_SEALED_FRAME_BYTES * 4) / 3)) return "ACP_FRAME_TOO_LARGE";
    let bytes: Uint8Array;
    try {
      bytes = fromBase64Url(payload);
    } catch {
      return "ACP_PLAINTEXT_REFUSED";
    }
    if (bytes.byteLength === 0) return "ACP_PLAINTEXT_REFUSED";
    if (bytes.byteLength > ACP_SEALED_FRAME_BYTES) return "ACP_FRAME_TOO_LARGE";
    frames.push({ seqFrom: parsed.data.seqFrom, seqTo: parsed.data.seqTo, kind: parsed.data.kind, payload });
  }
  return frames;
}

export const watchInput = z.object({ chat: z.string().min(1).max(256), tab: z.string().max(64) });

/**
 * Viewer heartbeat of a visible Session Tab (every `ACP_VIEWER_HEARTBEAT_MS`; Convex `Watch`):
 * records the Tab as a viewer and warms the session. A cold → warm transition rings the Worker
 * (`warm`) and tells the chat's viewers. `warm: false` means the Worker is at its warm cap; the
 * next heartbeat tries again.
 */
export async function watch(
  runtime: Runtime,
  userId: string,
  input: z.output<typeof watchInput>,
  now = Date.now(),
) {
  const { session } = await accessibleSession(runtime.drivers.db, userId, input.chat);
  if (!validAcpToken(input.tab, 64)) acpError("ACP_INVALID_TAB");
  const result = await watchWarm(runtime.drivers.kv, { worker: session.worker, chat: session.chat, tab: input.tab, now });
  if (result === "warmed") {
    ringWorkers(runtime, [session.worker], "warm");
    runtime.defer(publishChatEvent(runtime, session.chat, "acp"));
  }
  return { warm: result !== "full" };
}

/**
 * Cooling (`acp.cool`, every minute; Convex `coolSessions`): a chat warmed and last viewed more
 * than `ACP_COLD_AFTER_MS` before `now` leaves its Worker's warm set, its current epoch is cooled
 * (`cooled_epoch = epoch`) and its stream deleted, its Worker is rung (`warm`) and its viewers
 * told. Walks the warm-Worker set with a cursor kept between runs, at most `COOL_BATCH` chats per
 * run.
 */
export async function coolSessions(runtime: Runtime, now: number): Promise<{ cooled: number }> {
  const { kv } = runtime.drivers;
  const cutoff = now - ACP_COLD_AFTER_MS;
  let cursor = (await kvGet(kv, COOL_CURSOR_KEY)) ?? "0";
  let cooled = 0;
  for (let pages = 0; pages < COOL_WORKER_PAGES; pages++) {
    const page = await warmWorkersPage(kv, cursor);
    for (const worker of page.workers) {
      const chats: string[] = [];
      for (const chat of await coolingCandidates(kv, worker, cutoff)) {
        if (cooled + chats.length >= COOL_BATCH) break;
        if (await coolWarm(kv, worker, chat, cutoff)) chats.push(chat);
      }
      if (chats.length > 0) await coolChats(runtime, worker, chats);
      cooled += chats.length;
      // Out of budget: this page is visited again next run (cooled chats are no longer candidates).
      if (cooled >= COOL_BATCH) {
        await kvSet(kv, COOL_CURSOR_KEY, cursor);
        return { cooled };
      }
    }
    cursor = page.cursor;
    if (cursor === "0") break;
  }
  await kvSet(kv, COOL_CURSOR_KEY, cursor);
  return { cooled };
}

/**
 * Cools the current epoch of each of `chats` (already out of `worker`'s warm set) and deletes its
 * stream. The epoch is read in the update itself: `startEpoch` checks warmth under the session
 * row lock, so an epoch started before the chat left the warm set is cooled here, and none can
 * start after.
 */
async function coolChats(runtime: Runtime, worker: string, chats: string[]) {
  const { db, kv } = runtime.drivers;
  const jobs = await db.transaction(async (tx) => {
    const rows = await tx
      .update(acpSessions)
      .set({ cooledEpoch: sql`${acpSessions.epoch}`, updatedAt: new Date() })
      .where(
        and(
          eq(acpSessions.worker, worker),
          inArray(acpSessions.chat, chats),
          gt(acpSessions.epoch, 0),
          or(isNull(acpSessions.cooledEpoch), lt(acpSessions.cooledEpoch, acpSessions.epoch)),
        ),
      )
      .returning({ chat: acpSessions.chat, epoch: acpSessions.epoch });
    return await queueStreamDeletion(
      tx,
      rows.map((row) => epochStreamPath(row.chat, row.epoch)),
    );
  });
  for (const chat of chats) await forgetEpochFence(kv, chat);
  await dispatchJobs(runtime, jobs);
  ringWorkers(runtime, [worker], "warm");
  for (const chat of chats) await publishChatEvent(runtime, chat, "acp");
}

/**
 * Revocation (in the revoke transaction): closes the open epoch of every session of `worker` and
 * queues the deletion of its stream; returns the jobs to dispatch after commit.
 */
export async function closeWorkerEpochs(tx: Database, worker: string) {
  const rows = await tx
    .update(acpSessions)
    .set({ cooledEpoch: sql`${acpSessions.epoch}` })
    .where(
      and(
        eq(acpSessions.worker, worker),
        gt(acpSessions.epoch, 0),
        or(isNull(acpSessions.cooledEpoch), lt(acpSessions.cooledEpoch, acpSessions.epoch)),
      ),
    )
    .returning({ chat: acpSessions.chat, epoch: acpSessions.epoch });
  return await queueStreamDeletion(
    tx,
    rows.map((row) => epochStreamPath(row.chat, row.epoch)),
  );
}
