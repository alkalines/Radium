import { createFileRoute } from "@tanstack/react-router";

async function proxyToConvex(request: Request) {
  const convexSiteUrl = process.env.VITE_CONVEX_SITE_URL;
  if (!convexSiteUrl) {
    return Response.json({ error: "VITE_CONVEX_SITE_URL is not configured." }, { status: 500 });
  }

  const sourceUrl = new URL(request.url);
  const targetUrl = new URL(`${sourceUrl.pathname}${sourceUrl.search}`, convexSiteUrl);
  const response = await fetch(new Request(targetUrl, request));
  const headers = new Headers(response.headers);

  // fetch decompresses upstream responses, so these headers no longer describe the body.
  headers.delete("content-encoding");
  headers.delete("content-length");

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export const Route = createFileRoute("/api/chatgpt-subscription/$")({
  server: {
    handlers: {
      GET: ({ request }) => proxyToConvex(request),
      POST: ({ request }) => proxyToConvex(request),
    },
  },
});
