import { ConvexError } from "convex/values";
import type { Doc } from "../../convex/_generated/dataModel";
import type { MutationCtx } from "../../convex/_generated/server";
import { assertLegacyPlaintextAllowed } from "../e2ee/migration-contract";

/**
 * Gate for every plaintext chat write. Plaintext writes stop permanently once encryption cutover
 * freezes or completes, and a chat whose historical plaintext already moved into a sidecar must
 * be written natively: new plaintext beside a sidecar would conflict with the sealed history and
 * block its migration. `chat` is the chat being written, when one exists.
 */
export async function assertPlaintextChatWriteAllowed(
  ctx: MutationCtx,
  chat?: Pick<Doc<"aisdk_chats">, "legacyContent">,
): Promise<void> {
  await assertLegacyPlaintextAllowed(ctx);
  if (chat?.legacyContent) {
    // The browser answers this by creating chat keys first (`ensureChatKeys`).
    throw new ConvexError({ code: "E2EE_KEYS_REQUIRED" });
  }
}
