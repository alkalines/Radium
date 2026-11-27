import { useMemo } from "react";
import { useLiveQuery } from "@tanstack/react-db";

import { useTrpc } from "@/lib/trpc";
import { trpcClient } from "@/lib/trpc-client";
import { useCollection, type CollectionSource } from "./factory";
import { plainRow, type WorkspaceSettings } from "./shapes";

/** A workspace without a settings row reads the column defaults. */
const DEFAULT_SETTINGS: Omit<WorkspaceSettings, "id" | "workspace"> = {
  defaultModel: null,
  titleModel: null,
  chainOfThought: true,
  systemPrompt: { enabled: true, modelIdentity: true },
  workerTools: [],
};

/**
 * Workspace `workspace`'s Chatroom defaults, or `undefined` until loaded (or without a
 * workspace). Without Electric they come from the `chatroom` getters, under a key the `chatroom`
 * router's events refresh.
 */
export function useWorkspaceSettings(
  workspace: string | undefined,
): Omit<WorkspaceSettings, "id"> | undefined {
  const trpc = useTrpc();
  const source = useMemo(
    (): CollectionSource<"workspaceSettings", WorkspaceSettings> | undefined =>
      workspace
        ? {
            shape: "workspaceSettings",
            selector: { workspace },
            // One row read from several getters: a key under the `chatroom` router.
            queryKey: [["chatroom", "settings"], { input: { workspace }, type: "query" }],
            queryFn: async () => {
              const client = trpcClient().chatroom;
              const [defaultModel, titleModel, chainOfThought, systemPrompt, workerTools] =
                await Promise.all([
                  client.getModelDefault.query({ workspace }),
                  client.getTitleModelDefault.query({ workspace }),
                  client.getChainOfThoughtEnabled.query({ workspace }),
                  client.getSystemPromptSettings.query({ workspace }),
                  client.getWorkerToolDefaults.query({ workspace }),
                ]);
              return {
                id: workspace,
                workspace,
                defaultModel,
                titleModel,
                chainOfThought,
                systemPrompt,
                workerTools,
              };
            },
            select: (row) => [row],
          }
        : undefined,
    [trpc, workspace],
  );
  const collection = useCollection(source);
  const { data, isReady } = useLiveQuery((q) =>
    collection ? q.from({ settings: collection }).findOne() : undefined,
  );
  return useMemo(
    () =>
      workspace && collection && isReady
        ? data
          ? plainRow(data)
          : { workspace, ...DEFAULT_SETTINGS }
        : undefined,
    [collection, data, isReady, workspace],
  );
}

type OfferedModel = {
  slug: string;
  type: string;
  architecture: { input_modalities: readonly string[]; output_modalities: readonly string[] };
};

/**
 * `slug` when the workspace still offers it (`models.availableModels`), else `null`: a removed
 * model never sticks as a phantom default (`chatroom.getModelDefault`).
 */
export function offeredModel(slug: string | null, models: readonly OfferedModel[] | undefined) {
  return slug && models?.some((model) => model.slug === slug) ? slug : null;
}

/** `slug` when the workspace still offers it and it can write titles (text in, text out). */
export function offeredTitleModel(
  slug: string | null,
  models: readonly OfferedModel[] | undefined,
) {
  const model = slug ? models?.find((candidate) => candidate.slug === slug) : undefined;
  return model &&
    model.type === "chat" &&
    model.architecture.input_modalities.includes("text") &&
    model.architecture.output_modalities.includes("text")
    ? model.slug
    : null;
}
