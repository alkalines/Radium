import { NextRequest } from "next/server";

export async function GET(req: NextRequest, ctx: RouteContext<"/api/chat/stream/[chatID]">) {
  const data = await fetch(
    `${process.env
      .NEXT_PUBLIC_CONVEX_SITE_URL!}/api/aisdk/chat/stream/${(await ctx.params).chatID}`,
    {
      method: "GET",
      headers: req.headers,
    }
  );

  return data.clone();
}
