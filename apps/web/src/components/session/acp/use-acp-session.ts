import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { inferRouterOutputs } from "@trpc/server";
import { toast } from "sonner";
import type { AppRouter } from "server/router";
import {
  ACP_HISTORY_REQUEST_ITEMS,
  ACP_VIEWER_HEARTBEAT_MS,
  acpAnswerError,
  type AcpCommandPayload,
  type AcpInteractionAnswer,
  type AcpInteractionRequest,
} from "contracts/acp/contract";
import { applyAcpFrames, emptyAcpTimeline, startAcpEpoch } from "contracts/acp/fold";
import { isWorkerOnline, WORKER_ONLINE_WINDOW_MS } from "contracts/worker/presence";
import { acpChatStatus, acpRunState, createAcpViewModel } from "./view-model";
import {
  createChatKeys,
  rememberChatSeed,
  writableChatKey,
  type ChatScope,
} from "@/lib/crypto/chat-keys";
import { useAcpSessionLive } from "@/lib/collections/acp-session";
import { sealTitle } from "@/lib/crypto/chat-content";
import { currentUserId } from "@/lib/crypto/runtime";
import { readStream } from "@/lib/stream-reader";
import { trpcClient } from "@/lib/trpc-client";
import { useTrpc } from "@/lib/trpc";
import { isTrpcRefusal, retryTransient } from "@/lib/trpc-error";
import { KeysLockedError } from "@/lib/crypto/key-manager";
import { useKeyStatus } from "@/lib/crypto/use-key-status";
import {
  acpFallbackTitle,
  openAcpError,
  openAcpFrames,
  openAcpInteraction,
  readEpochMessage,
  sealAcpAnswer,
  signAcpBinding,
  signAcpCommand,
  type AcpChatContext,
  type AcpEpochCapsule,
  type AcpFrameRow,
} from "./acp-crypto";
import {
  openHistoricalAcpSession,
  type HistoricalAcpSession,
} from "@/lib/crypto/legacy-relay";

type Interactions = inferRouterOutputs<AppRouter>["acp"]["openInteractions"];

/** An open interaction whose Worker-signed request was verified and opened. */
export type AcpInteractionView = Omit<Interactions[number], "request" | "sealed"> & {
  request: AcpInteractionRequest;
};
const noInteractions: AcpInteractionView[] = [];
/** Quiet time after which a history request counts as finished (or failed, if nothing came). */
const HISTORY_STALL_MS = 15_000;
/** The clock that notices a stale heartbeat, and so when to ask for a fresh one. */
const WORKER_CLOCK_MS = 15_000;

const actionMessages: Record<string, string> = {
  ACP_SESSION_BUSY: "The agent is already running",
  ACP_SESSION_ENDED: "This agent Session has ended",
  ACP_AGENT_UNAVAILABLE: "This agent is not available on the Worker",
  ACP_UNSUPPORTED: "This agent does not support that action",
  ACP_INVALID_PROMPT: "The prompt is empty or too large",
  ACP_INVALID_CONFIG: "This agent setting is no longer available",
  ACP_INVALID_MODE: "This agent mode is no longer available",
  ACP_INVALID_ANSWER: "This answer does not match the agent's request",
  ACP_DENIED: "You no longer have access to this Session",
  ACP_NOT_ACP: "This agent Session is no longer available",
  ACP_COMMAND_CLOSED: "This agent command is no longer available",
  ACP_SESSION_BOUND: "This agent session is already open in another Session",
  ACP_E2EE_REQUIRED:
    "Agent Sessions need workspace encryption keys. Set up encryption for this workspace first.",
  WORKER_NOT_PAIRED:
    "This Worker is not paired for end-to-end encryption. Pair it from Settings → Workers.",
  ACP_BINDING_REQUIRED: "This Session is not bound to its Worker yet. Reopen it and try again.",
  ACP_INVALID_BINDING: "This Session's audience changed. Reopen it and try again.",
  ACP_GATEWAY_UNAVAILABLE: "The Gateway profile is not available for this agent or Worker",
  ACP_GATEWAY_KEY_MISSING: "This Worker has no active Gateway key",
  ACP_WORKER_BUSY: "This Worker already has too many open agent Sessions",
  ACP_STALE_EPOCH: "The agent restarted. Reopen the Session and try again.",
};

/**
 * Reads an ACP refusal: the tRPC message of an ACP error is its code (`ACP_SESSION_BUSY`), or a
 * human sentence for the few refusals that carry one. `undefined` means nothing to tell the user.
 */
export function acpActionError(error: unknown): string | undefined {
  const text = error instanceof Error ? error.message : "";
  if (text === "ACP_INTERACTION_CLOSED") return undefined;
  if (actionMessages[text]) return actionMessages[text];
  if (/^[A-Z][A-Z0-9_]+$/.test(text)) {
    return text.startsWith("ACP_") ? "The agent could not complete this action" : text;
  }
  return text || "The agent could not complete this action";
}

function showActionError(error: unknown) {
  const message = acpActionError(error);
  if (message) toast.error(message);
}

/**
 * Quiet metadata (`getSession`, `openInteractions`, `workerStatus`) loads while the Tab is visible
 * and refetches on focus, after the user's own commands and when the chat's invalidation events
 * name it. While visible the Tab heartbeats `acp.watch`, which keeps the session warm, and reads
 * the current epoch's stream (`getSession.stream`) live: the capsule first, then sealed frames,
 * opened and folded into the timeline. A closed or missing stream refetches the session, which
 * names the next epoch once the Worker starts one.
 */
export function useAcpSession({
  chatId,
  isVisible,
}: {
  chatId: string;
  isVisible: boolean;
}) {
  const trpc = useTrpc();
  const queryClient = useQueryClient();
  const keyStatus = useKeyStatus();
  const { data: baseSession, error: liveSessionError } = useQuery(
    trpc.acp.getSession.queryOptions(
      { chat: chatId },
      { retry: retryTransient, refetchOnWindowFocus: true },
    ),
  );
  // The `acpSession` collection carries what the Worker changes (lifecycle, epoch, config,
  // commands, usage) while the Tab is visible: an Electric shape, or `getSession` itself.
  const live = useAcpSessionLive(isVisible ? chatId : undefined);
  const liveSession = useMemo(() => {
    if (!baseSession || !live || live.id !== baseSession.id) return baseSession;
    const { id: _id, sessionId, ...fields } = live;
    return {
      ...baseSession,
      ...fields,
      // Before the agent session exists, `getSession` fills commands from the agent's defaults.
      commands: fields.commands ?? (sessionId ? null : baseSession.commands),
    };
  }, [baseSession, live]);
  // A new epoch names a new stream and capsule; `getSession` re-reads warmth and agent details.
  const liveEpoch = live?.epoch;
  useEffect(() => {
    if (liveEpoch === undefined || baseSession === undefined || liveEpoch === baseSession.epoch) return;
    void queryClient.invalidateQueries({ queryKey: trpc.acp.getSession.queryKey({ chat: chatId }) });
  }, [baseSession, chatId, liveEpoch, queryClient, trpc]);
  // A refusal is final; a network failure only counts while nothing has loaded yet.
  const sessionError =
    liveSessionError && (isTrpcRefusal(liveSessionError) || liveSession === undefined)
      ? liveSessionError
      : null;
  // Migrated Sessions keep their former error, config and commands in a sealed sidecar. They fill
  // in only where live data is absent, so a Worker's newer values always win.
  const [historicalSession, setHistoricalSession] = useState<HistoricalAcpSession>();
  const historicalSource = liveSession?.legacyContent;
  const liveRecord = liveSession?.id;
  const liveWorkspace = liveSession?.workspace;
  useEffect(() => {
    if (!historicalSource || !liveRecord || !liveWorkspace) {
      setHistoricalSession((current) => (current ? undefined : current));
      return;
    }
    let cancelled = false;
    openHistoricalAcpSession(
      { _id: liveRecord, legacyContent: historicalSource },
      { workspace: liveWorkspace, chatId },
    ).then(
      (value) => {
        if (!cancelled) setHistoricalSession(value);
      },
      // Locked keys and recovery custody leave the sidecar unreadable; live fields are unaffected.
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [chatId, historicalSource, keyStatus, liveRecord, liveWorkspace]);
  const session = useMemo(
    () =>
      liveSession && historicalSession
        ? {
            ...liveSession,
            error: liveSession.error ?? historicalSession.error ?? null,
            config: liveSession.config ?? historicalSession.config ?? null,
            commands: liveSession.commands ?? historicalSession.commands ?? null,
          }
        : liveSession,
    [historicalSession, liveSession],
  );
  const [timeline, setTimeline] = useState(emptyAcpTimeline);
  const timelineRef = useRef(timeline);
  timelineRef.current = timeline;
  const [loadingBefore, setLoadingBefore] = useState<number>();
  /** Window start whose history request failed; automatic loading stops there until a retry. */
  const [failedBefore, setFailedBefore] = useState<number>();
  const requestedHistory = useRef(new Set<string>());
  const [now, setNow] = useState(() => Date.now());

  const { data: rawInteractions } = useQuery(
    trpc.acp.openInteractions.queryOptions(isVisible ? { chat: chatId } : skipToken, {
      retry: retryTransient,
      refetchOnWindowFocus: true,
    }),
  );
  const { data: workerData, refetch: refetchWorker } = useQuery(
    trpc.acp.workerStatus.queryOptions(isVisible ? { chat: chatId } : skipToken, {
      retry: retryTransient,
      refetchOnWindowFocus: true,
    }),
  );
  const lastWorker = useRef(workerData);
  if (workerData) lastWorker.current = workerData;

  const promptMutation = useMutation(trpc.acp.prompt.mutationOptions());
  const fallbackTitleMutation = useMutation(trpc.acp.setFallbackTitle.mutationOptions());
  const cancelMutation = useMutation(trpc.acp.cancel.mutationOptions());
  const configMutation = useMutation(trpc.acp.setConfig.mutationOptions());
  const modeMutation = useMutation(trpc.acp.setMode.mutationOptions());
  const answerMutation = useMutation(trpc.acp.answer.mutationOptions());
  const historyMutation = useMutation(trpc.acp.requestHistory.mutationOptions());
  const forkMutation = useMutation(trpc.acp.fork.mutationOptions());
  const startForkMutation = useMutation(trpc.acp.startFork.mutationOptions());

  const epoch = session?.epoch;
  const workspaceId = session?.workspace;
  const workerId = session?.agent.worker;
  const e2eeId = session?.e2eeId ?? undefined;
  const chatContext = useMemo<AcpChatContext | undefined>(
    () =>
      workspaceId && workerId && e2eeId ? { chatId, workspaceId, workerId, e2eeId } : undefined,
    [chatId, e2eeId, workerId, workspaceId],
  );

  /** Refetches what an own command changes now; later changes arrive as invalidation events. */
  const afterCommand = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: trpc.acp.getSession.queryKey({ chat: chatId }) });
    void queryClient.invalidateQueries({
      queryKey: trpc.acp.openInteractions.queryKey({ chat: chatId }),
    });
  }, [chatId, queryClient, trpc]);

  const [openedInteractions, setOpenedInteractions] = useState<{
    source: Interactions;
    rows: AcpInteractionView[];
  }>();
  useEffect(() => {
    if (!chatContext || !rawInteractions) return;
    let cancelled = false;
    void Promise.all(
      rawInteractions.map(async (row): Promise<AcpInteractionView | undefined> => {
        if (!row.sealed) return undefined;
        try {
          const request = await openAcpInteraction(chatContext, {
            requestKey: row.requestKey,
            sealed: row.sealed,
          });
          const { request: _plain, sealed: _sealed, ...rest } = row;
          return { ...rest, request };
        } catch {
          // An unverifiable or unreadable request is dropped: it is never shown or answered.
          return undefined;
        }
      }),
    ).then((rows) => {
      if (!cancelled)
        setOpenedInteractions({
          source: rawInteractions,
          rows: rows.filter((row) => row !== undefined),
        });
    });
    return () => {
      cancelled = true;
    };
  }, [chatContext, rawInteractions, keyStatus]);
  const interactions =
    rawInteractions && openedInteractions?.source === rawInteractions
      ? openedInteractions.rows
      : noInteractions;

  const sealedError = session?.sealedError ?? undefined;
  const [openedError, setOpenedError] = useState<{
    source: NonNullable<typeof sealedError>;
    message: string;
  }>();
  useEffect(() => {
    if (!chatContext || !sealedError) return;
    let cancelled = false;
    openAcpError(chatContext, sealedError).then(
      (message) => {
        if (!cancelled) setOpenedError({ source: sealedError, message });
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [chatContext, sealedError, keyStatus]);

  // A paired Worker seals errors only to a chat key epoch bound to this chat, and new chats start
  // with an epoch made before their ID existed. Against an unbound (or rekey-pending) epoch the
  // Worker refuses without a readable error; a reader starts a bound epoch here instead.
  // Already-bound keys are verified from cache.
  const [keyError, setKeyError] = useState<string>();
  useEffect(() => {
    if (!e2eeId || keyStatus.state !== "unlocked") return;
    let cancelled = false;
    writableChatKey(chatId)
      .catch((error: unknown) => {
        if (error instanceof KeysLockedError) throw error;
        // Another reader (or tab) may have rotated first, which refuses this rotation; the
        // re-read then finds that bound epoch and uses it.
        return writableChatKey(chatId);
      })
      .then(
        () => {
          if (!cancelled) setKeyError(undefined);
        },
        (error: unknown) => {
          if (cancelled || error instanceof KeysLockedError) return;
          setKeyError(
            "Could not prepare this Session's encryption key, so the agent cannot open it.",
          );
        },
      );
    return () => {
      cancelled = true;
    };
  }, [chatId, e2eeId, keyStatus.state]);

  // A Worker re-reporting an error seals it into a new box each time; the last opened text stays
  // until the new box opens, so the generic server text only stands in before the first one does.
  const openedMessage = sealedError ? openedError?.message : undefined;
  /** Set when the epoch stream holds something that does not verify (see the reader below). */
  const [streamError, setStreamError] = useState<string>();
  const errorMessage = openedMessage ?? session?.error ?? keyError ?? streamError;

  /** Seals and signs a command for this chat's Worker. */
  const signCommand = useCallback(
    (command: AcpCommandPayload, clientId?: string) => {
      if (!workspaceId || !workerId) throw new Error("This agent Session is still loading.");
      return signAcpCommand({ workspaceId, workerId, chatId, command, clientId });
    },
    [chatId, workerId, workspaceId],
  );

  useEffect(() => {
    if (!isVisible || epoch === undefined || timelineRef.current.epoch === epoch) return;
    const next = startAcpEpoch(timelineRef.current, epoch, { keepOlder: false });
    timelineRef.current = next;
    setTimeline(next);
    setLoadingBefore(undefined);
    setFailedBefore(undefined);
  }, [epoch, isVisible]);

  // The viewer heartbeat: keeps the session warm while this Tab shows it, and warms a cold one
  // (the Worker then starts a new epoch, announced by an invalidation event).
  const [tab] = useState(() => crypto.randomUUID());
  useEffect(() => {
    if (!isVisible) return;
    const beat = () => {
      trpcClient().acp.watch.mutate({ chat: chatId, tab }).catch(() => {});
    };
    beat();
    const timer = window.setInterval(beat, ACP_VIEWER_HEARTBEAT_MS);
    return () => window.clearInterval(timer);
  }, [chatId, isVisible, tab]);

  // The current epoch's stream, read from its start: the capsule, then frames in order. Reading
  // again (unlocked keys, a new epoch) re-delivers frames the fold already applied, which it skips.
  const stream = session?.stream ?? undefined;
  useEffect(() => {
    setStreamError(undefined);
    if (!isVisible || !chatContext || !stream || epoch === undefined || keyStatus.state !== "unlocked") return;
    const controller = new AbortController();
    let capsule: AcpEpochCapsule | undefined;
    void readStream<unknown>({
      url: `/api/streams/${stream}`,
      offset: "-1",
      signal: controller.signal,
      onMessages: async (messages) => {
        try {
          const rows: AcpFrameRow[] = [];
          for (const message of messages) {
            const read = readEpochMessage(message);
            if ("capsule" in read) capsule ??= read.capsule;
            else rows.push(read.frame);
          }
          if (rows.length === 0) return;
          const frames = await openAcpFrames(chatContext, epoch, capsule, rows);
          if (controller.signal.aborted) return;
          const next = applyAcpFrames(startAcpEpoch(timelineRef.current, epoch, { keepOlder: false }), frames);
          timelineRef.current = next;
          setTimeline(next);
        } catch (error) {
          // An unverifiable stream is never shown; locked keys restart the read once unlocked.
          controller.abort();
          if (!(error instanceof KeysLockedError)) {
            setStreamError("Could not verify this Session's agent output, so it is not shown.");
          }
        }
      },
    }).then((end) => {
      // Closed (rolled over) or gone (cooled, superseded): the session names what comes next.
      if (end !== "aborted") {
        void queryClient.invalidateQueries({ queryKey: trpc.acp.getSession.queryKey({ chat: chatId }) });
      }
    });
    return () => controller.abort();
  }, [chatContext, chatId, epoch, isVisible, keyStatus.state, queryClient, stream, trpc]);

  // One request streams every older page. While pages keep arriving it stays in flight; when they
  // stop with more left (item limit, Worker restart), the next request continues from there, and
  // a request that brought nothing at all counts as failed so the reader can retry.
  useEffect(() => {
    if (loadingBefore === undefined) return;
    const timer = window.setTimeout(() => {
      const state = timelineRef.current;
      if (state.windowStart === loadingBefore) {
        requestedHistory.current.delete(`${state.epoch}:${loadingBefore}`);
        setFailedBefore(loadingBefore);
      }
      setLoadingBefore(undefined);
    }, HISTORY_STALL_MS);
    return () => window.clearTimeout(timer);
  }, [loadingBefore, timeline.windowStart]);

  // The clock decides online/offline from the last heartbeat read, so it also asks for a fresh one
  // once that reading is half a window old (a connected Worker reports every 20 s).
  useEffect(() => {
    if (!isVisible) return;
    setNow(Date.now());
    const clock = window.setInterval(() => {
      const current = Date.now();
      setNow(current);
      const seen = lastWorker.current?.lastSeenAt;
      if (seen == null || current - seen > WORKER_ONLINE_WINDOW_MS / 2) void refetchWorker();
    }, WORKER_CLOCK_MS);
    return () => window.clearInterval(clock);
  }, [isVisible, refetchWorker]);

  const loadOlder = useCallback(async () => {
    const state = timelineRef.current;
    if (
      !isVisible ||
      !state.hasMore ||
      state.epoch === undefined ||
      state.windowStart === undefined
    )
      return;
    const key = `${state.epoch}:${state.windowStart}`;
    if (requestedHistory.current.has(key)) return;
    requestedHistory.current.add(key);
    const before = state.windowStart;
    setFailedBefore(undefined);
    setLoadingBefore(before);
    try {
      const request = { epoch: state.epoch, before, limit: ACP_HISTORY_REQUEST_ITEMS };
      await historyMutation.mutateAsync({
        chat: chatId,
        epoch: request.epoch,
        before,
        signed: await signCommand(
          { kind: "history", ...request },
          `history:${chatId}:${request.epoch}:${before}:${crypto.randomUUID()}`,
        ),
      });
      afterCommand();
    } catch (error) {
      requestedHistory.current.delete(key);
      setLoadingBefore(undefined);
      setFailedBefore(before);
      showActionError(error);
    }
  }, [afterCommand, chatId, historyMutation, isVisible, signCommand]);

  const lastSeenAt = lastWorker.current?.lastSeenAt ?? undefined;
  // Hidden Tabs drop the WorkerStatus query, so presence is unknown rather than offline.
  const workerKnown = isVisible && workerData !== undefined;
  const workerOnline = workerKnown && isWorkerOnline(workerData.lastSeenAt ?? undefined, now);
  const historyFailed = failedBefore !== undefined && failedBefore === timeline.windowStart;
  const loadingHistory = timeline.hasSnapshot && timeline.hasMore && workerOnline && !historyFailed;
  // Where the epoch's snapshot began. While older pages stream in, they stay out of the thread and
  // join it in one step at the end, instead of each page shifting the reader's view.
  const [opened, setOpened] = useState<{ epoch: number; start: number }>();
  if (
    timeline.hasSnapshot &&
    timeline.epoch !== undefined &&
    timeline.windowStart !== undefined &&
    opened?.epoch !== timeline.epoch
  )
    setOpened({ epoch: timeline.epoch, start: timeline.windowStart });
  const shownFrom =
    loadingHistory && opened && opened.epoch === timeline.epoch ? opened.start : undefined;
  // The whole conversation shows: older pages are requested until the agent's first item.
  useEffect(() => {
    if (!workerOnline || !timeline.hasSnapshot || !timeline.hasMore) return;
    if (loadingBefore !== undefined || historyFailed) return;
    void loadOlder();
  }, [
    historyFailed,
    loadOlder,
    loadingBefore,
    timeline.hasMore,
    timeline.hasSnapshot,
    timeline.windowStart,
    workerOnline,
  ]);

  const prompt = useCallback(
    async (text: string) => {
      try {
        const prompt = [{ type: "text" as const, text }];
        const clientId = crypto.randomUUID();
        await promptMutation.mutateAsync({
          chat: chatId,
          clientId,
          signed: await signCommand({ kind: "prompt", prompt }, clientId),
        });
        afterCommand();
        if (!session?.agent.sessionId) {
          // The server never sees the prompt text, so the fallback title is sealed here.
          void (async () => {
            const key = await writableChatKey(chatId);
            const sealedTitle = await sealTitle({ title: acpFallbackTitle(text) }, key);
            await fallbackTitleMutation.mutateAsync({ chat: chatId, sealedTitle });
          })().catch(() => {});
        }
      } catch (error) {
        // Composer restores the draft and toasts this readable error when submission rejects.
        throw new Error(acpActionError(error) ?? "The agent could not send this prompt");
      }
    },
    [
      afterCommand,
      chatId,
      fallbackTitleMutation,
      promptMutation,
      session?.agent.sessionId,
      signCommand,
    ],
  );
  const cancel = useCallback(async () => {
    try {
      await cancelMutation.mutateAsync({
        chat: chatId,
        signed: await signCommand({ kind: "cancel" }),
      });
      afterCommand();
    } catch (error) {
      showActionError(error);
    }
  }, [afterCommand, cancelMutation, chatId, signCommand]);
  const setConfig = useCallback(
    async (configId: string, value: string | boolean) => {
      try {
        await configMutation.mutateAsync({
          chat: chatId,
          signed: await signCommand({ kind: "set_config", configId, value }),
        });
        afterCommand();
      } catch (error) {
        showActionError(error);
      }
    },
    [afterCommand, chatId, configMutation, signCommand],
  );
  const setMode = useCallback(
    async (modeId: string) => {
      try {
        await modeMutation.mutateAsync({
          chat: chatId,
          signed: await signCommand({ kind: "set_mode", modeId }),
        });
        afterCommand();
      } catch (error) {
        showActionError(error);
      }
    },
    [afterCommand, chatId, modeMutation, signCommand],
  );
  const answer = useCallback(
    async (interaction: string, response: AcpInteractionAnswer) => {
      try {
        const row = interactions.find((candidate) => candidate.id === interaction);
        if (!row || !workspaceId || !workerId) throw new Error("This question is no longer open.");
        // The server cannot read a sealed answer, so the browser validates it before sending.
        const invalid = acpAnswerError(row.request, response);
        if (invalid) {
          toast.error(invalid);
          return false;
        }
        const sealed = await sealAcpAnswer({
          workspaceId,
          workerId,
          chatId,
          requestKey: row.requestKey,
          answer: response,
        });
        await answerMutation.mutateAsync({ interaction, sealed });
        afterCommand();
        return true;
      } catch (error) {
        showActionError(error);
        return false;
      }
    },
    [afterCommand, answerMutation, chatId, interactions, workerId, workspaceId],
  );
  const fork = useCallback(async () => {
    try {
      const clientId = crypto.randomUUID();
      if (!session) throw new Error("This agent Session is still loading.");
      // The fork keeps the source's audience but belongs to the caller, who is not a member.
      const source = await trpcClient().e2ee.chatKeys.query({ chatId });
      const scope: ChatScope = source.scope;
      const me = currentUserId();
      const members =
        scope === "shared"
          ? [...new Set([...source.members, source.creatorId])].filter((id) => id !== me)
          : [];
      const keys = await createChatKeys({ workspaceId: session.workspace, scope, members });
      const target = await forkMutation.mutateAsync({
        chat: chatId,
        e2ee: { keys: keys.keys, ...(scope === "shared" ? { members } : {}) },
      });
      rememberChatSeed(target, keys.e2eeId, 1, keys.seed);
      // The Worker seals the fork's frames only to a key epoch bound to the target chat.
      await writableChatKey(target);
      await startForkMutation.mutateAsync({
        chat: chatId,
        target,
        binding: await signAcpBinding({
          workspaceId: session.workspace,
          chatId: target,
          e2eeId: keys.e2eeId,
          workerId: session.agent.worker,
          agentId: session.agent.agentId,
          profile: session.agent.profile,
          cwd: session.agent.cwd,
          scope,
          members,
          version: 1,
        }),
        signed: await signCommand({ kind: "fork", targetChat: target }, clientId),
      });
      return target;
    } catch (error) {
      showActionError(error);
      return undefined;
    }
  }, [chatId, forkMutation, session, signCommand, startForkMutation]);
  const [buildView] = useState(createAcpViewModel);
  const view = useMemo(
    () => buildView(timeline, session?.status, shownFrom),
    [buildView, timeline, session?.status, shownFrom],
  );
  // A snapshot can hold no turn (one oversized item); then the first page that brings one shows.
  if (
    opened &&
    shownFrom !== undefined &&
    view.messages.length === 0 &&
    timeline.windowStart !== undefined &&
    timeline.windowStart < shownFrom
  )
    setOpened({ ...opened, start: timeline.windowStart });

  return {
    session,
    sessionError,
    timeline,
    ...view,
    runState: acpRunState(session?.status, session?.stopReason ?? undefined, timeline),
    chatStatus: acpChatStatus(session?.status),
    workerOnline,
    workerKnown,
    workerLastSeenAt: lastSeenAt,
    workerName: lastWorker.current?.name ?? undefined,
    interactions,
    errorMessage,
    loadOlder,
    historyFailed,
    loadingHistory,
    prompt,
    cancel,
    setConfig,
    setMode,
    answer,
    fork,
  };
}
