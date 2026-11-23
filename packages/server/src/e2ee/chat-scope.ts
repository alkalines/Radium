import { eq } from "drizzle-orm";
import { z } from "zod";
import { isAcpChat } from "../acp/sessions";
import type { Chat, ChatWorkspace } from "../chatroom/access";
import { chatMemberIds, setChatMembers } from "../chatroom/members";
import { chats } from "../chatroom/schema";
import type { Database } from "../drivers/types";
import { AppError } from "../errors";
import {
  chatEpochNumbers,
  chatKeyInput,
  deleteWorkspaceWraps,
  insertChatEpoch,
  insertChatWraps,
  validateChatEpoch,
  validateChatWraps,
  wrapInput,
  type ChatKeyInput,
  type WrapInput,
} from "./chat-keys";
import { invalidKeys } from "./workspace-keys";

/** Key changes that come with a scope change. */
export const scopeKeysInput = z.object({
  rotate: chatKeyInput.optional(),
  wraps: z.array(wrapInput).max(1000),
});

/**
 * Creator-only scope transition (Convex `changeChatScope`), in the caller's transaction holding
 * the chat row lock. Every actual scope or member change starts a fresh epoch signed and bound to
 * the NEXT scope and members; widening additionally rewraps every historical epoch to the added
 * readers, and narrowing away from `workspace` deletes the workspace wraps. A chat without keys
 * changes scope without key material.
 */
export async function changeChatScope(
  tx: Database,
  chat: Chat,
  workspace: ChatWorkspace,
  userId: string,
  input: {
    scope: Chat["scope"];
    members?: string[];
    keys?: { rotate?: ChatKeyInput; wraps: WrapInput[] };
  },
): Promise<void> {
  if (chat.userId !== userId) {
    throw new AppError("FORBIDDEN", "Only the chat creator can change its scope.");
  }
  if (input.scope !== "shared" && input.members !== undefined) invalidKeys();
  // An ACP chat's Worker binding must be re-signed for the new audience; that path comes with the
  // ACP slice, so its scope stays fixed until then.
  if (await isAcpChat(tx, chat.id)) {
    throw new AppError("CONFLICT", "ACP chats cannot change scope yet.");
  }
  const oldScope = chat.scope;
  const oldMembers = await chatMemberIds(tx, chat.id);
  const members =
    input.scope === "shared" ? (input.members ?? (oldScope === "shared" ? oldMembers : [])) : [];
  const next = { ...chat, scope: input.scope };
  await setChatMembers(tx, next, workspace, members);

  if (!chat.e2eeId) {
    if (input.keys) invalidKeys();
  } else {
    const added =
      input.scope === "shared"
        ? members.filter(
            (id) => oldScope === "personal" || (oldScope === "shared" && !oldMembers.includes(id)),
          )
        : [];
    const widening = (input.scope === "workspace" && oldScope !== "workspace") || added.length > 0;
    const audienceChanged =
      input.scope !== oldScope ||
      (input.scope === "shared" &&
        (oldMembers.length !== members.length || oldMembers.some((id) => !members.includes(id))));
    if (audienceChanged && !input.keys?.rotate) invalidKeys();
    if (input.keys) {
      const epochs = chatEpochNumbers(chat);
      const rotate = input.keys.rotate;
      if (rotate) {
        if (rotate.epoch !== (chat.keyEpoch ?? 0) + 1 || !rotate.signature) invalidKeys();
        await validateChatEpoch(tx, workspace, chat.e2eeId, rotate, userId, {
          policy: { chat: chat.id, scope: input.scope, creatorId: chat.userId, members },
          required: true,
        });
      }
      const allowedEpochs = [...epochs, ...(rotate ? [rotate.epoch] : [])];
      await validateChatWraps(tx, next, workspace, members, input.keys.wraps, allowedEpochs, false);
      if (rotate) {
        await validateChatWraps(
          tx,
          next,
          workspace,
          members,
          input.keys.wraps.filter((wrap) => wrap.chatEpoch === rotate.epoch),
          [rotate.epoch],
        );
      }
      if (widening) {
        if (input.scope === "workspace") {
          await validateChatWraps(
            tx,
            next,
            workspace,
            members,
            input.keys.wraps.filter((wrap) => epochs.includes(wrap.chatEpoch)),
            epochs,
          );
        } else {
          for (const epoch of epochs) {
            for (const member of added) {
              if (
                !input.keys.wraps.some(
                  (wrap) =>
                    wrap.chatEpoch === epoch &&
                    wrap.recipient === "identity" &&
                    wrap.userId === member,
                )
              ) {
                invalidKeys();
              }
            }
          }
        }
      }
      if (rotate) {
        await insertChatEpoch(tx, chat, rotate, userId);
        await tx
          .update(chats)
          .set({ keyEpoch: rotate.epoch, rekey: false })
          .where(eq(chats.id, chat.id));
      }
      await insertChatWraps(tx, chat, workspace, input.keys.wraps, userId);
      // Narrowing away from workspace scope leaves no workspace wrap every member could open.
      if (oldScope === "workspace" && input.scope !== "workspace") {
        await deleteWorkspaceWraps(tx, chat.id, epochs);
      }
    }
  }
  await tx.update(chats).set({ scope: input.scope }).where(eq(chats.id, chat.id));
}
