import { useMemo } from "react";
import { useLiveQuery } from "@tanstack/react-db";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "server/router";

import { useTrpc } from "@/lib/trpc";
import { trpcClient } from "@/lib/trpc-client";
import { useCollection, type CollectionSource } from "./factory";
import { plainRow, type AcpSessionLive } from "./shapes";

type AcpSession = inferRouterOutputs<AppRouter>["acp"]["getSession"];

/**
 * Chat `chat`'s live session fields, or `undefined` until loaded (or while `chat` is unset).
 * Without Electric the row is `acp.getSession`'s own answer, which `acp` events refresh.
 */
export function useAcpSessionLive(chat: string | undefined): AcpSessionLive | undefined {
  const trpc = useTrpc();
  const source = useMemo(
    (): CollectionSource<"acpSession", AcpSession> | undefined =>
      chat
        ? {
            shape: "acpSession",
            selector: { chat },
            queryKey: trpc.acp.getSession.queryKey({ chat }),
            queryFn: () => trpcClient().acp.getSession.query({ chat }),
            select: (session) => [
              {
                id: session.id,
                sessionId: session.agent.sessionId,
                status: session.status,
                epoch: session.epoch,
                stream: session.stream,
                stopReason: session.stopReason,
                error: session.error,
                sealedError: session.sealedError,
                binding: session.binding,
                config: session.config,
                commands: session.commands,
                usage: session.usage,
                turnUsage: session.turnUsage,
                history: session.history,
              },
            ],
          }
        : undefined,
    [chat, trpc],
  );
  const collection = useCollection(source);
  const { data, isReady } = useLiveQuery((q) =>
    collection ? q.from({ session: collection }).findOne() : undefined,
  );
  return useMemo(
    () => (collection && isReady && data ? plainRow(data) : undefined),
    [collection, data, isReady],
  );
}
