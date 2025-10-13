import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  const data = await fetch(
    `${process.env
      .NEXT_PUBLIC_CONVEX_SITE_URL!}/api/openai/v1/chat/completions`,
    {
      method: "POST",
      body: JSON.stringify(await req.json()),
      headers: req.headers,
    }
  );

  return data.clone()
}
