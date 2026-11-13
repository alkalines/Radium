import type { Doc } from "../../convex/_generated/dataModel";
import type { MutationCtx } from "../../convex/_generated/server";
import { chatMemberIds, setChatMembers } from "../chatroom/members";
import {
  insertChatEpoch,
  insertChatWraps,
  MAX_CHAT_EPOCHS,
  validateChatEpoch,
  validateChatWraps,
} from "./chat-keys";
import { invalidKeys, type ChatKeyInput, type WrapInput } from "./workspace-contract";
/** Creator-only scope transition; narrowing rotates, widening covers every historical epoch. */
export async function changeChatScope(
  ctx: MutationCtx,
  chat: Doc<"aisdk_chats">,
  workspace: Doc<"workspaces">,
  userId: string,
  input: {
    scope: "personal" | "shared" | "workspace";
    members?: string[];
    keys?: {
      rotate?: ChatKeyInput;
      wraps: WrapInput[];
    };
  },
): Promise<void> {
  if (chat.userId !== userId) {
    throw new Error("Only the chat creator can change its scope.");
  }
  if (input.scope !== "shared" && input.members !== undefined) {
    invalidKeys();
  }
  const oldScope = chat.scope ?? "personal";
  const oldMembers = await chatMemberIds(ctx, chat._id);
  if (chat.agent && input.scope === "shared") {
    invalidKeys();
  }
  const members =
    input.scope === "shared" ? (input.members ?? (oldScope === "shared" ? oldMembers : [])) : [];
  const next = { ...chat, workspace: workspace._id, scope: input.scope };
  // Membership validation and key changes share the mutation transaction and roll back together.
  await setChatMembers(ctx, next, members);
  if (!chat.e2eeId) {
    if (input.keys) {
      invalidKeys();
    }
  } else {
    const narrowing =
      (oldScope === "workspace" && input.scope !== "workspace") ||
      (oldScope === "shared" && input.scope === "personal") ||
      (oldScope === "shared" &&
        input.scope === "shared" &&
        oldMembers.some((id) => !members.includes(id)));
    const added =
      input.scope === "shared"
        ? members.filter(
            (id) => oldScope === "personal" || (oldScope === "shared" && !oldMembers.includes(id)),
          )
        : [];
    const widening = (input.scope === "workspace" && oldScope !== "workspace") || added.length > 0;
    if ((narrowing || widening) && !input.keys) {
      invalidKeys();
    }
    if (narrowing && !input.keys?.rotate) {
      invalidKeys();
    }
    if (input.keys) {
      const epochs = await ctx.db
        .query("e2ee_chat_keys")
        .withIndex("by_chat_and_epoch", (q) => q.eq("chat", chat._id))
        .take(201);
      if (epochs.length > 200) {
        invalidKeys();
      }
      const rotate = input.keys.rotate;
      if (rotate) {
        if (
          rotate.epoch !== (chat.keyEpoch ?? 0) + 1 ||
          rotate.epoch > MAX_CHAT_EPOCHS ||
          !rotate.signature
        ) {
          invalidKeys();
        }
        await validateChatEpoch(ctx, workspace, chat.e2eeId, rotate, userId);
      }
      const allowedEpochs = [...epochs.map((e) => e.epoch), ...(rotate ? [rotate.epoch] : [])];
      await validateChatWraps(
        ctx,
        next,
        workspace,
        members,
        input.keys.wraps,
        allowedEpochs,
        false,
      );
      if (rotate) {
        await validateChatWraps(
          ctx,
          next,
          workspace,
          members,
          input.keys.wraps.filter((w) => w.chatEpoch === rotate.epoch),
          [rotate.epoch],
        );
      }
      if (widening) {
        if (input.scope === "workspace") {
          await validateChatWraps(
            ctx,
            next,
            workspace,
            members,
            input.keys.wraps.filter((w) => epochs.some((e) => e.epoch === w.chatEpoch)),
            epochs.map((e) => e.epoch),
          );
        } else {
          for (const epoch of epochs) {
            for (const userId of added) {
              if (
                !input.keys.wraps.some(
                  (w) =>
                    w.chatEpoch === epoch.epoch &&
                    w.recipient === "identity" &&
                    w.userId === userId,
                )
              ) {
                invalidKeys();
              }
            }
          }
        }
      }
      if (rotate) {
        await insertChatEpoch(ctx, chat, workspace, rotate, userId);
        await ctx.db.patch("aisdk_chats", chat._id, { keyEpoch: rotate.epoch, rekey: false });
      }
      await insertChatWraps(ctx, chat, workspace, input.keys.wraps, userId);
      // Narrowing away from workspace scope must leave no workspace wrap openable by every member.
      if (oldScope === "workspace" && input.scope !== "workspace") {
        for (const epoch of epochs) {
          const stale = await ctx.db
            .query("e2ee_chat_key_wraps")
            .withIndex("by_chat_and_chatEpoch_and_workspaceEpoch", (q) =>
              q.eq("chat", chat._id).eq("chatEpoch", epoch.epoch).gt("workspaceEpoch", 0),
            )
            .take(201);
          if (stale.length > 200) {
            invalidKeys();
          }
          for (const wrap of stale) {
            await ctx.db.delete("e2ee_chat_key_wraps", wrap._id);
          }
        }
      }
    }
  }
  await ctx.db.patch("aisdk_chats", chat._id, { workspace: workspace._id, scope: input.scope });
}
