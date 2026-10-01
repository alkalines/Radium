import { api, internal } from "../../convex/_generated/api";
import type { ActionCtx } from "../../convex/_generated/server";

export async function handleOpenAIModels(ctx: ActionCtx, req: Request): Promise<Response> {
  // Auth
  const authBearer = req.headers.get("Authorization")?.replace("Bearer ", "");
  if (!authBearer || authBearer === "")
    return Response.json(
      {
        error: {
          message: "The Authorization field is empty!",
          code: 401,
        },
      },
      { status: 401 },
    );
  const checkKey = await ctx
    .runQuery(api.keys.getKeyInfo, {
      key: authBearer,
    })
    .catch(() => {});
  if (!checkKey)
    return Response.json(
      {
        error: {
          message: "The Authorization is invalid!",
          code: 401,
        },
      },
      { status: 401 },
    );
  const legacyBalance = "legacyBalance" in checkKey ? checkKey.legacyBalance : undefined;
  const workspace =
    checkKey.workspace ??
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
