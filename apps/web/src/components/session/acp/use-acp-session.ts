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
  ACP_HISTORY_PAGE_ITEMS,
  ACP_VIEWER_HEARTBEAT_MS,
  type AcpInteractionAnswer,
} from "backend/src/acp/contract";
import {
  applyAcpFrames,
  emptyAcpTimeline,
  startAcpEpoch,
  type AcpFrame,
} from "backend/src/acp/fold";
import { isWorkerOnline } from "backend/src/worker/presence";
import { acpBrowserTabId } from "./browser-tab";
import { acpChatStatus, acpRunState, createAcpViewModel } from "./view-model";

type Interactions = FunctionReturnType<typeof api.acp.OpenInteractions>;
type WorkerStatus = FunctionReturnType<typeof api.acp.WorkerStatus>;
const noInteractions: Interactions = [];

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
  const { data: session, error: sessionError } = useQuery(
    convexQuery(api.acp.GetSession, { chat: chatId }),
  );
  const [timeline, setTimeline] = useState(emptyAcpTimeline);
  const timelineRef = useRef(timeline);
  timelineRef.current = timeline;
  const [fromSeq, setFromSeq] = useState(0);
  const followed = useRef(false);
  const caughtUp = useRef(false);
  const previousVisible = useRef(false);
  const [loadingBefore, setLoadingBefore] = useState<number>();
  const requestedHistory = useRef(new Set<string>());
  const [now, setNow] = useState(() => Date.now());
  const lastWorker = useRef<WorkerStatus | undefined>(undefined);
  const watch = useMutation(api.chatroom.Watch);
  const promptMutation = useMutation(api.acp.Prompt);
  const generateTitle = useAction(api.acp.GenerateTitle);
  const cancelMutation = useMutation(api.acp.Cancel);
  const configMutation = useMutation(api.acp.SetConfig);
  const modeMutation = useMutation(api.acp.SetMode);
  const answerMutation = useMutation(api.acp.Answer);
  const historyMutation = useMutation(api.acp.RequestHistory);
  const forkMutation = useMutation(api.acp.Fork);

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
  const frames = results.frames as AcpFrame[] | Error | undefined;
  const interactions = results.interactions as Interactions | Error | undefined;
  const worker = results.worker as WorkerStatus | Error | undefined;
  if (worker && !(worker instanceof Error)) lastWorker.current = worker;

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
    if (frames.length === 64 && consumed && last) setFromSeq(last.seqTo + 1);
  }, [epoch, frames, streamEnabled]);

  useEffect(() => {
    if (loadingBefore !== undefined && timeline.windowStart !== loadingBefore)
      setLoadingBefore(undefined);
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
    setLoadingBefore(state.windowStart);
    try {
      await historyMutation({
        chat: chatId,
        epoch: state.epoch,
        before: state.windowStart,
        limit: ACP_HISTORY_PAGE_ITEMS,
      });
    } catch (error) {
      setLoadingBefore(undefined);
      showActionError(error);
    }
  }, [chatId, historyMutation, isVisible]);

  const prompt = useCallback(
    async (text: string) => {
      try {
        await promptMutation({
          chat: chatId,
          prompt: [{ type: "text", text }],
          clientId: crypto.randomUUID(),
        });
        if (!session?.agent.sessionId) void generateTitle({ chat: chatId, text }).catch(() => {});
      } catch (error) {
        // Composer restores the draft and toasts this readable error when submission rejects.
        throw new Error(acpActionError(error) ?? "The agent could not send this prompt");
      }
    },
    [chatId, generateTitle, promptMutation, session?.agent.sessionId],
  );
  const cancel = useCallback(async () => {
    try {
      await cancelMutation({ chat: chatId });
    } catch (error) {
      showActionError(error);
    }
  }, [cancelMutation, chatId]);
  const setConfig = useCallback(
    async (configId: string, value: string | boolean) => {
      try {
        await configMutation({ chat: chatId, configId, value });
      } catch (error) {
        showActionError(error);
      }
    },
    [chatId, configMutation],
  );
  const setMode = useCallback(
    async (modeId: string) => {
      try {
        await modeMutation({ chat: chatId, modeId });
      } catch (error) {
        showActionError(error);
      }
    },
    [chatId, modeMutation],
  );
  const answer = useCallback(
    async (interaction: Id<"acp_interactions">, answer: AcpInteractionAnswer) => {
      try {
        await answerMutation({ interaction, answer });
        return true;
      } catch (error) {
        showActionError(error);
        return false;
      }
    },
    [answerMutation],
  );
  const fork = useCallback(async () => {
    try {
      return await forkMutation({ chat: chatId, clientId: crypto.randomUUID() });
    } catch (error) {
      showActionError(error);
      return undefined;
    }
  }, [chatId, forkMutation]);
  const [buildView] = useState(createAcpViewModel);
  const view = useMemo(
    () => buildView(timeline, session?.status),
    [buildView, timeline, session?.status],
  );

  return {
    session,
    sessionError,
    timeline,
    ...view,
    runState: acpRunState(session?.status, session?.stopReason, timeline),
    chatStatus: acpChatStatus(session?.status),
    // Hidden Tabs drop the WorkerStatus subscription, so presence is unknown rather than offline.
    workerOnline:
      isVisible &&
      worker !== undefined &&
      !(worker instanceof Error) &&
      isWorkerOnline(worker.lastSeenAt ?? undefined, now),
    workerKnown: isVisible && worker !== undefined && !(worker instanceof Error),
    workerLastSeenAt: lastWorker.current?.lastSeenAt,
    workerName: lastWorker.current?.name,
    interactions: interactions && !(interactions instanceof Error) ? interactions : noInteractions,
    contentError: frames instanceof Error ? frames : undefined,
    loadOlder,
    isLoadingOlder: loadingBefore !== undefined,
    prompt,
    cancel,
    setConfig,
    setMode,
    answer,
    fork,
  };
}
