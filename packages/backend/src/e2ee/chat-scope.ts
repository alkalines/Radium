import type { Doc } from "../../convex/_generated/dataModel";
import type { MutationCtx } from "../../convex/_generated/server";
import { chatMemberIds, setChatMembers } from "../chatroom/members";
import type { AcpSignedBinding } from "../acp/contract";
import { findSession } from "../acp/policy";
import { verifyNextBinding } from "../acp/sealed";
import {
  chatEpochNumbers,
  insertChatEpoch,
  insertChatWraps,
  validateChatEpoch,
  validateChatWraps,
} from "./chat-keys";
import { invalidKeys, type ChatKeyInput, type WrapInput } from "./workspace-contract";
import { invalidateTelemetryProofs } from "./migration-telemetry-proofs";
/**
 * Creator-only scope transition. Every actual scope or member change starts a fresh epoch signed
 * and bound (`bindingSignature`) to the NEXT scope and members; widening additionally rewraps
 * every historical epoch to the added readers, without re-signing or re-encrypting history. An ACP
 * chat whose binding was published must come with the creator's next binding version for exactly
 * the new audience, so its Worker authorizes the new members (or stops authorizing removed ones).
 */
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
    acpBinding?: AcpSignedBinding;
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
  const session = chat.agent ? await findSession(ctx, chat._id) : null;
  if (!session?.binding && input.acpBinding) {
    invalidKeys();
  }
  const members =
    input.scope === "shared" ? (input.members ?? (oldScope === "shared" ? oldMembers : [])) : [];
  const next = { ...chat, workspace: workspace._id, scope: input.scope };
  // Membership validation and key changes share the mutation transaction and roll back together.
  await setChatMembers(ctx, next, members);
  if (session?.binding) {
    if (!input.acpBinding) {
      invalidKeys();
    }
    await verifyNextBinding(ctx, {
      session,
      chat: next,
      scope: input.scope,
      members,
      binding: input.acpBinding,
    });
    await ctx.db.patch("acp_sessions", session._id, { binding: input.acpBinding });
  }
  if (!chat.e2eeId) {
    if (input.keys) {
      invalidKeys();
    }
  } else {
    const added =
      input.scope === "shared"
        ? members.filter(
            (id) => oldScope === "personal" || (oldScope === "shared" && !oldMembers.includes(id)),
          )
        : [];
    const widening = (input.scope === "workspace" && oldScope !== "workspace") || added.length > 0;
    // Any actual audience change starts a fresh epoch bound to the NEXT scope and members, even a
    // widening (old history is rewrapped below, never re-signed or re-encrypted).
    const audienceChanged =
      input.scope !== oldScope ||
      (input.scope === "shared" &&
        (oldMembers.length !== members.length || oldMembers.some((id) => !members.includes(id))));
    if (audienceChanged && !input.keys?.rotate) {
      invalidKeys();
    }
    if (input.keys) {
      // Historical epochs are exactly 1..keyEpoch. A widening must wrap all of them in this one
      // mutation, which the bounded wrap list (`validateChatWraps`) limits; rotation itself is
      // not capped.
      const epochs = chatEpochNumbers(chat);
      const rotate = input.keys.rotate;
      if (rotate) {
        if (rotate.epoch !== (chat.keyEpoch ?? 0) + 1 || !rotate.signature) {
          invalidKeys();
        }
        await validateChatEpoch(ctx, workspace, chat.e2eeId, rotate, userId, {
          policy: { chat: chat._id, scope: input.scope, creatorId: chat.userId, members },
          required: true,
        });
      }
      const allowedEpochs = [...epochs, ...(rotate ? [rotate.epoch] : [])];
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
            input.keys.wraps.filter((w) => epochs.includes(w.chatEpoch)),
            epochs,
          );
        } else {
          for (const epoch of epochs) {
            for (const userId of added) {
              if (
                !input.keys.wraps.some(
                  (w) =>
                    w.chatEpoch === epoch && w.recipient === "identity" && w.userId === userId,
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
              q.eq("chat", chat._id).eq("chatEpoch", epoch).gt("workspaceEpoch", 0),
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
  await invalidateTelemetryProofs(ctx, workspace._id);
}
