import { createFileRoute } from "@tanstack/react-router";

import { proxyRequest } from "@/lib/server-proxy";

export async function proxyToConvex(request: Request) {
  const convexSiteUrl = process.env.VITE_CONVEX_SITE_URL;
  if (!convexSiteUrl) {
    return Response.json({ error: "VITE_CONVEX_SITE_URL is not configured." }, { status: 500 });
  }

  const sourceUrl = new URL(request.url);
  const targetUrl = new URL(convexSiteUrl);
  targetUrl.pathname = sourceUrl.pathname.replace(/^\/api\/backend\//, "/api/");
  targetUrl.search = sourceUrl.search;
  return proxyRequest(request, targetUrl, new Headers(request.headers));
}

export const Route = createFileRoute("/api/backend/$")({
  server: {
    handlers: {
      GET: ({ request }) => proxyToConvex(request),
      POST: ({ request }) => proxyToConvex(request),
      PUT: ({ request }) => proxyToConvex(request),
      PATCH: ({ request }) => proxyToConvex(request),
      DELETE: ({ request }) => proxyToConvex(request),
      HEAD: ({ request }) => proxyToConvex(request),
      OPTIONS: ({ request }) => proxyToConvex(request),
    },
  },
});
