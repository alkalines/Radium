import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { convexQuery } from "@convex-dev/react-query";
import { useQuery } from "@tanstack/react-query";
import { useAction, useMutation, useQueries } from "convex/react";
import { ConvexError } from "convex/values";
import type { FunctionReturnType } from "convex/server";
import { toast } from "sonner";
import { api } from "backend/convex/_generated/api";
import type { Id } from "backend/convex/_generated/dataModel";
import {
  ACP_HISTORY_REQUEST_ITEMS,
  ACP_VIEWER_HEARTBEAT_MS,
  acpAnswerError,
  type AcpCommandPayload,
  type AcpInteractionAnswer,
  type AcpInteractionRequest,
} from "contracts/acp/contract";
import { applyAcpFrames, emptyAcpTimeline, startAcpEpoch, type AcpFrame } from "contracts/acp/fold";
import { isWorkerOnline } from "contracts/worker/presence";
import { acpBrowserTabId } from "./browser-tab";
import { acpChatStatus, acpRunState, createAcpViewModel } from "./view-model";
import {
  createChatKeys,
  rememberChatSeed,
  writableChatKey,
  type ChatScope,
} from "@/lib/crypto/chat-keys";
import { sealTitle } from "@/lib/crypto/chat-content";
import { cryptoClient, currentUserId } from "@/lib/crypto/runtime";
import { KeysLockedError } from "@/lib/crypto/key-manager";
import { useKeyStatus } from "@/lib/crypto/use-key-status";
import { KeylessDowngradeError, workspaceKnownKeyed } from "@/lib/crypto/workspace-keys";
import {
  acpFallbackTitle,
  openAcpError,
  openAcpFrames,
  openAcpInteraction,
  sealAcpAnswer,
  signAcpBinding,
  signAcpCommand,
  type AcpChatContext,
  type AcpFrameRow,
} from "./acp-crypto";
import {
  isHistoricalFrame,
  openHistoricalAcpFrames,
  openHistoricalAcpSession,
  type HistoricalAcpSession,
} from "@/lib/crypto/legacy-relay";

type Interactions = FunctionReturnType<typeof api.acp.OpenInteractions>;
type WorkerStatus = FunctionReturnType<typeof api.acp.WorkerStatus>;

/** An open interaction whose request is readable: plaintext in legacy mode, verified in signed mode. */
export type AcpInteractionView = Omit<Interactions[number], "request" | "sealed"> & {
  request: AcpInteractionRequest;
};
const noInteractions: AcpInteractionView[] = [];
/** Quiet time after which a history request counts as finished (or failed, if nothing came). */
const HISTORY_STALL_MS = 15_000;
const downgradeMessage = new KeylessDowngradeError().message;

/** Read structured Convex errors instead of showing their serialized server envelope. */
export function acpActionError(error: unknown): string | undefined {
  if (error instanceof ConvexError) {
    const data: unknown = error.data;
    const code =
      typeof data === "object" && data !== null && "code" in data ? String(data.code) : undefined;
    if (code === "ACP_INTERACTION_CLOSED") return undefined;
    const messages: Record<string, string> = {
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
    };
    if (code && messages[code]) return messages[code];
    if (
      typeof data === "object" &&
      data !== null &&
      "message" in data &&
      typeof data.message === "string"
    )
      return data.message;
    if (code?.startsWith("ACP_")) return "The agent could not complete this action";
  }
  return error instanceof Error ? error.message : "The agent could not complete this action";
}

function showActionError(error: unknown) {
  const message = acpActionError(error);
  if (message) toast.error(message);
}

/**
 * Quiet metadata stays mounted; native Convex subscriptions are removed immediately when hidden
 * (TanStack's retained query cache would otherwise keep receiving transient content until GC).
 * The immutable fold stays in this hook, independently of those subscriptions.
 */
export function useAcpSession({
  chatId,
  isVisible,
}: {
  chatId: Id<"aisdk_chats">;
  isVisible: boolean;
}) {
  const keyStatus = useKeyStatus();
  const { data: liveSession, error: sessionError } = useQuery(
    convexQuery(api.acp.GetSession, { chat: chatId }),
  );
  // Migrated Sessions keep their former error, config, commands and draft in a sealed sidecar.
  // They fill in only where live data is absent, so a Worker's newer values always win.
  const [historicalSession, setHistoricalSession] = useState<HistoricalAcpSession>();
  const historicalSource = liveSession?.legacyContent;
  const liveRecord = liveSession?._id;
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
            error: liveSession.error ?? historicalSession.error,
            config: liveSession.config ?? historicalSession.config,
            commands: liveSession.commands ?? historicalSession.commands,
            draft: liveSession.draft ?? historicalSession.draft,
          }
        : liveSession,
    [historicalSession, liveSession],
  );
  const [timeline, setTimeline] = useState(emptyAcpTimeline);
  const timelineRef = useRef(timeline);
  timelineRef.current = timeline;
  const [fromSeq, setFromSeq] = useState(0);
  const followed = useRef(false);
  const caughtUp = useRef(false);
  const previousVisible = useRef(false);
  const [loadingBefore, setLoadingBefore] = useState<number>();
  /** Window start whose history request failed; automatic loading stops there until a retry. */
  const [failedBefore, setFailedBefore] = useState<number>();
  const requestedHistory = useRef(new Set<string>());
  const [now, setNow] = useState(() => Date.now());
  const lastWorker = useRef<WorkerStatus | undefined>(undefined);
  const watch = useMutation(api.chatroom.Watch);
  const promptMutation = useMutation(api.acp.Prompt);
  const generateTitle = useAction(api.acp.GenerateTitle);
  const fallbackTitleMutation = useMutation(api.acp.SetFallbackTitle);
  const cancelMutation = useMutation(api.acp.Cancel);
  const configMutation = useMutation(api.acp.SetConfig);
  const modeMutation = useMutation(api.acp.SetMode);
  const answerMutation = useMutation(api.acp.Answer);
  const historyMutation = useMutation(api.acp.RequestHistory);
  const forkMutation = useMutation(api.acp.Fork);
  const startForkMutation = useMutation(api.acp.StartFork);

  const epoch = session?.epoch;
  const streamEnabled = isVisible && epoch !== undefined && timeline.epoch === epoch;
  // `useQueries` resubscribes whenever its argument changes identity, so key it on the inputs.
  const queries = useMemo(
    () => ({
      ...(streamEnabled
        ? {
            frames: {
              query: api.chatroom.LiveFrames,
              args: { chat: chatId, stream: `acp:${epoch}`, fromSeq },
            },
          }
        : {}),
      ...(isVisible
        ? {
            interactions: { query: api.acp.OpenInteractions, args: { chat: chatId } },
            worker: { query: api.acp.WorkerStatus, args: { chat: chatId } },
          }
        : {}),
    }),
    [chatId, epoch, fromSeq, isVisible, streamEnabled],
  );
  const results = useQueries(queries);
  const rawFrames = results.frames as AcpFrameRow[] | Error | undefined;
  const rawInteractions = results.interactions as Interactions | Error | undefined;
  const worker = results.worker as WorkerStatus | Error | undefined;
  if (worker && !(worker instanceof Error)) lastWorker.current = worker;

  // Signed mode: the workspace has keys, so every command is sealed to the Worker and every Worker
  // object is verified and opened here instead of being read as the backend delivered it. A
  // workspace this device verified as keyed stays in signed mode when the server calls it keyless,
  // and its commands are refused: nothing is sent or shown in plaintext.
  const downgraded = !!session && session.signed !== true && workspaceKnownKeyed(session.workspace);
  const signed = session?.signed === true || downgraded;
  const workspaceId = session?.workspace;
  const workerId = session?.agent.worker;
  const e2eeId = session?.e2eeId ?? undefined;
  const chatContext = useMemo<AcpChatContext | undefined>(
    () =>
      workspaceId && workerId && e2eeId ? { chatId, workspaceId, workerId, e2eeId } : undefined,
    [chatId, e2eeId, workerId, workspaceId],
  );
  const [openedFrames, setOpenedFrames] = useState<{
    source: AcpFrameRow[];
    frames: AcpFrame[] | Error;
  }>();
  const hasHistoricalFrames =
    !!rawFrames && !(rawFrames instanceof Error) && rawFrames.some(isHistoricalFrame);
  useEffect(() => {
    if (!rawFrames || rawFrames instanceof Error || epoch === undefined || !workspaceId) return;
    // Each row is routed by its own form: sealed history opens through its sidecar, native frames
    // are verified against the roster Worker, and a plaintext stream is used as delivered.
    const historical = rawFrames.filter(isHistoricalFrame);
    const native = rawFrames.filter((row) => !isHistoricalFrame(row));
    if (!signed && historical.length === 0) return;
    if (signed && native.length > 0 && !chatContext) return;
    let cancelled = false;
    void (async () => {
      const history = await openHistoricalAcpFrames(historical, { workspace: workspaceId, chatId });
      if (native.length === 0) return history;
      if (!signed || !chatContext) return [...history, ...(native as AcpFrame[])];
      return [...history, ...(await openAcpFrames(chatContext, epoch, native))];
    })().then(
      (frames) => {
        if (!cancelled) setOpenedFrames({ source: rawFrames, frames });
      },
      (error: unknown) => {
        if (cancelled) return;
        const failure =
          error instanceof Error ? error : new Error("Could not verify the agent's content.");
        setOpenedFrames({ source: rawFrames, frames: failure });
      },
    );
    return () => {
      cancelled = true;
    };
    // `keyStatus` re-runs a decryption that failed while the keys were locked.
  }, [chatContext, chatId, epoch, rawFrames, keyStatus, signed, workspaceId]);
  let frames: AcpFrame[] | Error | undefined;
  if (rawFrames instanceof Error) frames = rawFrames;
  else if (!signed && !hasHistoricalFrames) frames = rawFrames as AcpFrame[] | undefined;
  else if (openedFrames && openedFrames.source === rawFrames) frames = openedFrames.frames;

  const [openedInteractions, setOpenedInteractions] = useState<{
    source: Interactions;
    rows: AcpInteractionView[];
  }>();
  useEffect(() => {
    if (!chatContext || !rawInteractions || rawInteractions instanceof Error) return;
    let cancelled = false;
    void Promise.all(
      rawInteractions.map(async (row): Promise<AcpInteractionView | undefined> => {
        if (!row.sealed) return undefined;
        try {
          const request = await openAcpInteraction(chatContext, {
            requestKey: row.requestKey,
            sealed: row.sealed,
          });
          const { request: _legacy, sealed: _sealed, ...rest } = row;
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
  const interactions = useMemo(() => {
    if (!rawInteractions || rawInteractions instanceof Error) return noInteractions;
    if (signed)
      return openedInteractions?.source === rawInteractions
        ? openedInteractions.rows
        : noInteractions;
    return rawInteractions.flatMap((row) => {
      const { request, sealed: _sealed, ...rest } = row;
      return request ? [{ ...rest, request }] : [];
    });
  }, [openedInteractions, rawInteractions, signed]);

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

  // A paired Worker seals frames and errors only to a chat key epoch bound to this chat, and new
  // chats start with an epoch made before their ID existed. Against an unbound (or rekey-pending)
  // epoch the Worker refuses without a readable error, so the Session would wait for its snapshot
  // forever; a reader starts a bound epoch here instead. Already-bound keys are verified from cache.
  const [keyError, setKeyError] = useState<string>();
  useEffect(() => {
    if (!signed || !e2eeId || keyStatus.state !== "unlocked") return;
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
  }, [chatId, e2eeId, keyStatus.state, signed]);

  // A Worker re-reporting an error seals it into a new box each time; the last opened text stays
  // until the new box opens, so the generic server text only stands in before the first one does.
  const openedMessage = sealedError ? openedError?.message : undefined;
  const errorMessage = downgraded
    ? downgradeMessage
    : (openedMessage ?? session?.error ?? keyError);

  /** Seals and signs a command for this chat's Worker; never used outside signed mode. */
  const signCommand = useCallback(
    (command: AcpCommandPayload, clientId?: string) => {
      if (downgraded) throw new KeylessDowngradeError();
      if (!workspaceId || !workerId) throw new Error("This agent Session is still loading.");
      return signAcpCommand({ workspaceId, workerId, chatId, command, clientId });
    },
    [chatId, downgraded, workerId, workspaceId],
  );

  useEffect(() => {
    // A return from a hidden Tab starts at the fold's next op, not its old subscription page.
    if (isVisible && !previousVisible.current) setFromSeq(timelineRef.current.nextSeq);
    if (!isVisible) {
      followed.current = false;
      caughtUp.current = false;
    }
    previousVisible.current = isVisible;
  }, [isVisible]);

  useEffect(() => {
    if (!isVisible || epoch === undefined || timelineRef.current.epoch === epoch) return;
    const keepOlder = isVisible && followed.current && caughtUp.current;
    const next = startAcpEpoch(timelineRef.current, epoch, { keepOlder });
    timelineRef.current = next;
    setTimeline(next);
    setFromSeq(0);
    setLoadingBefore(undefined);
    setFailedBefore(undefined);
    caughtUp.current = false;
    followed.current = false;
  }, [epoch, isVisible]);

  useEffect(() => {
    if (!streamEnabled || !frames || frames instanceof Error || timelineRef.current.epoch !== epoch)
      return;
    const next = applyAcpFrames(timelineRef.current, frames);
    timelineRef.current = next;
    setTimeline(next);
    followed.current = true;
    const last = frames.at(-1);
    const consumed = !last || next.nextSeq > last.seqTo;
    caughtUp.current = frames.length < 64 && consumed && next.hasSnapshot;
    // Subscribe past every applied frame: a cursor left on a partial page would make each later
    // append re-read the whole page (up to 64 frames of 32 KiB) for every viewer.
    if (consumed && last) setFromSeq(last.seqTo + 1);
  }, [epoch, frames, streamEnabled]);

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

  useEffect(() => {
    if (!isVisible) return;
    const heartbeat = () => {
      void watch({ chat: chatId, tab: acpBrowserTabId() }).catch(showActionError);
    };
    heartbeat();
    const interval = window.setInterval(heartbeat, ACP_VIEWER_HEARTBEAT_MS);
    setNow(Date.now());
    const clock = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => {
      window.clearInterval(interval);
      window.clearInterval(clock);
    };
  }, [chatId, isVisible, watch]);

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
      await historyMutation({
        chat: chatId,
        ...request,
        ...(signed
          ? {
              signed: await signCommand(
                { kind: "history", ...request },
                `history:${chatId}:${request.epoch}:${before}:${crypto.randomUUID()}`,
              ),
            }
          : {}),
      });
    } catch (error) {
      requestedHistory.current.delete(key);
      setLoadingBefore(undefined);
      setFailedBefore(before);
      showActionError(error);
    }
  }, [chatId, historyMutation, isVisible, signCommand, signed]);

  // Hidden Tabs drop the WorkerStatus subscription, so presence is unknown rather than offline.
  const workerKnown = isVisible && worker !== undefined && !(worker instanceof Error);
  const workerOnline = workerKnown && isWorkerOnline(worker.lastSeenAt ?? undefined, now);
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
        if (signed) {
          await promptMutation({
            chat: chatId,
            clientId,
            signed: await signCommand({ kind: "prompt", prompt }, clientId),
          });
          if (!session?.agent.sessionId) {
            // Keyed chats never send the prompt text to a title action; the title is sealed here.
            void (async () => {
              const key = await writableChatKey(chatId);
              const sealedTitle = await sealTitle({ title: acpFallbackTitle(text) }, key);
              await fallbackTitleMutation({ chat: chatId, sealedTitle });
            })().catch(() => {});
          }
          return;
        }
        await promptMutation({ chat: chatId, prompt, clientId });
        if (!session?.agent.sessionId) void generateTitle({ chat: chatId, text }).catch(() => {});
      } catch (error) {
        // Composer restores the draft and toasts this readable error when submission rejects.
        throw new Error(acpActionError(error) ?? "The agent could not send this prompt");
      }
    },
    [
      chatId,
      fallbackTitleMutation,
      generateTitle,
      promptMutation,
      session?.agent.sessionId,
      signCommand,
      signed,
    ],
  );
  const cancel = useCallback(async () => {
    try {
      await cancelMutation({
        chat: chatId,
        ...(signed ? { signed: await signCommand({ kind: "cancel" }) } : {}),
      });
    } catch (error) {
      showActionError(error);
    }
  }, [cancelMutation, chatId, signCommand, signed]);
  const setConfig = useCallback(
    async (configId: string, value: string | boolean) => {
      try {
        await configMutation({
          chat: chatId,
          ...(signed
            ? { signed: await signCommand({ kind: "set_config", configId, value }) }
            : { configId, value }),
        });
      } catch (error) {
        showActionError(error);
      }
    },
    [chatId, configMutation, signCommand, signed],
  );
  const setMode = useCallback(
    async (modeId: string) => {
      try {
        await modeMutation({
          chat: chatId,
          ...(signed ? { signed: await signCommand({ kind: "set_mode", modeId }) } : { modeId }),
        });
      } catch (error) {
        showActionError(error);
      }
    },
    [chatId, modeMutation, signCommand, signed],
  );
  const answer = useCallback(
    async (interaction: Id<"acp_interactions">, response: AcpInteractionAnswer) => {
      try {
        if (!signed) {
          await answerMutation({ interaction, answer: response });
          return true;
        }
        const row = interactions.find((candidate) => candidate._id === interaction);
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
        await answerMutation({ interaction, sealed });
        return true;
      } catch (error) {
        showActionError(error);
        return false;
      }
    },
    [answerMutation, chatId, interactions, signed, workerId, workspaceId],
  );
  const fork = useCallback(async () => {
    try {
      const clientId = crypto.randomUUID();
      if (downgraded) throw new KeylessDowngradeError();
      if (!signed) return await forkMutation({ chat: chatId, clientId });
      if (!session) throw new Error("This agent Session is still loading.");
      // The fork keeps the source's audience but belongs to the caller, who is not a member.
      const source = await cryptoClient().query(api.e2ee.chatKeys, { chatId });
      const scope: ChatScope = source.scope;
      const me = currentUserId();
      const members =
        scope === "shared"
          ? [...new Set([...source.members, source.creatorId])].filter((id) => id !== me)
          : [];
      const keys = await createChatKeys({ workspaceId: session.workspace, scope, members });
      const target = await forkMutation({
        chat: chatId,
        clientId,
        e2ee: { keys: keys.keys, ...(scope === "shared" ? { members } : {}) },
      });
      rememberChatSeed(target, keys.e2eeId, 1, keys.seed);
      // The Worker seals the fork's frames only to a key epoch bound to the target chat.
      await writableChatKey(target);
      await startForkMutation({
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
        signed: await signCommand({ kind: "fork", targetChat: target }),
      });
      return target;
    } catch (error) {
      showActionError(error);
      return undefined;
    }
  }, [chatId, downgraded, forkMutation, session, signCommand, signed, startForkMutation]);
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
    runState: acpRunState(session?.status, session?.stopReason, timeline),
    chatStatus: acpChatStatus(session?.status),
    workerOnline,
    workerKnown,
    workerLastSeenAt: lastWorker.current?.lastSeenAt,
    workerName: lastWorker.current?.name,
    interactions,
    contentError: frames instanceof Error ? frames : undefined,
    errorMessage,
    signed,
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
