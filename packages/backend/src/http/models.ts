import { api, internal } from "../../convex/_generated/api";
import type { ActionCtx } from "../../convex/_generated/server";

/** List models available to the workspace assigned to the supplied API key. */
export async function handleOpenAIModels(ctx: ActionCtx, req: Request): Promise<Response> {
  const bearerToken = req.headers.get("Authorization")?.replace("Bearer ", "");
  if (!bearerToken || bearerToken === "")
    return Response.json(
      {
        error: {
          message: "The Authorization field is empty!",
          code: 401,
        },
      },
      { status: 401 },
    );
  // Treat lookup failures like an invalid key rather than exposing backend errors.
  const keyInfo = await ctx
    .runQuery(api.keys.getKeyInfo, {
      key: bearerToken,
    })
    .catch(() => {});
  if (!keyInfo)
    return Response.json(
      {
        error: {
          message: "The Authorization is invalid!",
          code: 401,
        },
      },
      { status: 401 },
    );
  const legacyBalance = "legacyBalance" in keyInfo ? keyInfo.legacyBalance : undefined;
  const workspace =
    keyInfo.workspace ??
    (legacyBalance
      ? await ctx.runMutation(internal.workspaces.ensureForLegacyBalance, {
          balance: legacyBalance,
        })
      : null);
  if (!workspace) {
    return Response.json(
      { error: { message: "The API key is not assigned to a workspace.", code: 503 } },
      { status: 503 },
    );
  }

  return Response.json(await ctx.runQuery(internal.models.openaiModels, { workspace }));
}
