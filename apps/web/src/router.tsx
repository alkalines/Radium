import { createRouter } from "@tanstack/react-router";
import { QueryClient } from "@tanstack/react-query";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import { ConvexQueryClient } from "@convex-dev/react-query";
import { routeTree } from "./routeTree.gen";

/** Creates the app router with a Convex-backed query client for this render. */
export function getRouter() {
  const convexUrl = (import.meta as any).env.VITE_CONVEX_URL!;
  if (!convexUrl) {
    console.error("missing envar VITE_CONVEX_URL");
  }
  const convexQueryClient = new ConvexQueryClient(convexUrl);

  const queryClient: QueryClient = new QueryClient({
    defaultOptions: {
      queries: {
        queryKeyHashFn: convexQueryClient.hashFn(),
        queryFn: convexQueryClient.queryFn(),
      },
    },
  });
  convexQueryClient.connect(queryClient);

  const router = createRouter({
    routeTree,
    defaultPreload: "intent",
    context: { queryClient, convexQueryClient },
    scrollRestoration: true,
  });
  setupRouterSsrQueryIntegration({ router, queryClient });

  return router;
}
