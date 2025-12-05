import { api, internal } from "../_generated/api";
import { httpAction } from "../_generated/server";

export const HTTP_Request_OpenAI_Models = httpAction(
  async (ctx, req): Promise<any> => {
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
        { status: 401 }
      );
    const checkKey = await ctx
      .runQuery(api.key.getKeyInfo, {
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
        { status: 401 }
      );
    //

    return Response.json(await ctx.runQuery(internal.models.openaiModels));
  }
);