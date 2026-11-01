import { v } from "convex/values";
import { internalMutation, internalQuery, mutation } from "../../convex/_generated/server";
import { authComponent } from "../../convex/auth";
import { requireAccessibleChat } from "../../convex/workspaces";
import {
  CODE_MODE_INTERACTION_TIMEOUT_MS,
  codeModeInteractionResponseValidator,
} from "./code-mode";

/**
 * Prompts a running Code Mode program waits on (`codemode_interactions`). The chat action opens
 * one when an inner call needs the user, streams its id in the `execute` call's progress, and polls
 * {@link interactionResponse} until the browser answers through {@link answerInteraction}. Registered
 * through `convex/code_mode.ts`.
 */

const interactionKind = v.union(v.literal("approval"), v.literal("question"));

/** Kept past the answer deadline so the waiting action, not the cron, normally deletes the row. */
const INTERACTION_EXPIRY_GRACE_MS = 60_000;

/**
 * Answer an open interaction. Only the user whose request runs the program can answer, and only
 * while they can still access the chat; a second answer is rejected so the first one stands.
 */
export const answerInteraction = mutation({
  args: {
    interaction: v.id("codemode_interactions"),
    response: codeModeInteractionResponseValidator,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const identity = await authComponent.getAuthUser(ctx);
    if (!identity) throw new Error("Not logged in.");

    const interaction = await ctx.db.get("codemode_interactions", args.interaction);
    // Missing, foreign, and finished prompts read the same so ids reveal nothing.
    if (!interaction || interaction.userId !== identity._id) {
      throw new Error("This request is no longer waiting for an answer.");
    }
    await requireAccessibleChat(ctx, interaction.chatId);
    if (interaction.response) throw new Error("This request was already answered.");
    if (interaction.kind !== args.response.kind)
      throw new Error("Answer does not match the request.");

    await ctx.db.patch("codemode_interactions", args.interaction, { response: args.response });
    return null;
  },
});

/** Open a prompt for `userId` on `chatId`. Callers authorized the chat request first. */
export const openInteraction = internalMutation({
  args: { chatId: v.id("aisdk_chats"), userId: v.string(), kind: interactionKind },
  returns: v.id("codemode_interactions"),
  handler: async (ctx, args) => {
    return await ctx.db.insert("codemode_interactions", {
      ...args,
      expiresAt: Date.now() + CODE_MODE_INTERACTION_TIMEOUT_MS + INTERACTION_EXPIRY_GRACE_MS,
    });
  },
});

/** The answer to a prompt, or `null` while it is unanswered (or already closed). */
export const interactionResponse = internalQuery({
  args: { interaction: v.id("codemode_interactions") },
  returns: v.union(codeModeInteractionResponseValidator, v.null()),
  handler: async (ctx, args) => {
    const interaction = await ctx.db.get("codemode_interactions", args.interaction);
    return interaction?.response ?? null;
  },
});

/** Delete a prompt once its answer was read or the program stopped waiting. Idempotent. */
export const closeInteraction = internalMutation({
  args: { interaction: v.id("codemode_interactions") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const interaction = await ctx.db.get("codemode_interactions", args.interaction);
    if (interaction) await ctx.db.delete("codemode_interactions", args.interaction);
    return null;
  },
});

/** Remove a bounded batch of expired prompts whose action never closed them. */
export const pruneExpiredInteractions = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const records = await ctx.db
      .query("codemode_interactions")
      .withIndex("by_expiresAt", (q) => q.lte("expiresAt", Date.now()))
      .take(200);
    for (const record of records) {
      await ctx.db.delete("codemode_interactions", record._id);
    }
    return records.length;
  },
});
