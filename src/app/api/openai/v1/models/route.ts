import { NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  const data = await fetch(
    `${process.env
      .NEXT_PUBLIC_CONVEX_SITE_URL!}/api/openai/v1/chat/completions`,
    {
      method: "GET",
      headers: {
        Authorization: req.headers.get("Authorization") || "",
      },
    }
  );

  return data.clone();
}
