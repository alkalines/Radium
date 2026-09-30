import { createFileRoute } from "@tanstack/react-router";

export async function proxyToConvex(request: Request) {
  const convexSiteUrl = process.env.VITE_CONVEX_SITE_URL;
  if (!convexSiteUrl) {
    return Response.json({ error: "VITE_CONVEX_SITE_URL is not configured." }, { status: 500 });
  }

  const sourceUrl = new URL(request.url);
  const targetUrl = new URL(convexSiteUrl);
  targetUrl.pathname = sourceUrl.pathname.replace(/^\/api\/backend\//, "/api/");
  targetUrl.search = sourceUrl.search;
  // Preserve redirects for the caller instead of following them with session headers.
  const response = await fetch(new Request(targetUrl, request), { redirect: "manual" });
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
