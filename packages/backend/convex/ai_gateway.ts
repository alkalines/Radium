import type { ActionCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { Internal_Chat_Completion, type SettledGeneration } from "../src/http/chat_completion";
import type { TelemetryRequestContext } from "../src/telemetry/capture";
import { createInternalModel, type InternalModelSelection } from "../src/routing/internal-model";

type InternalChatContext = { userId: string; chatId: Id<"aisdk_chats"> };

/**
 * Build trusted in-process SDK models using the ordinary workspace Gateway pipeline.
 * Prompts, reasoning metadata and provider-defined tools do not cross a lossy wire codec.
 * Workspace and chat identities must come from the caller's authorization check.
 */
export function createInternalGatewayProvider(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
  selection: InternalModelSelection,
  onGeneration: ((generation: SettledGeneration) => void) | undefined,
  telemetry: Omit<TelemetryRequestContext, "requestId"> | undefined,
  chatContext: InternalChatContext,
) {
  return (modelId: string) =>
    createInternalModel(modelId, selection, (request, options, rawBody, signal) =>
      Internal_Chat_Completion(
        ctx,
        request,
        workspaceId,
        onGeneration,
        telemetry && { ...telemetry, requestId: crypto.randomUUID() },
        signal,
        { actor: chatContext.userId, chatId: chatContext.chatId },
        rawBody,
        options,
      ),
    );
}
