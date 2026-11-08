import { Link, useNavigate } from "@tanstack/react-router";
import { useSession } from "@better-auth-ui/react";
import { ConvexBetterAuthProvider } from "@convex-dev/better-auth/react";
import { useQueryClient } from "@tanstack/react-query";
import { useConvexAuth, useQuery as useConvexQuery, type ConvexReactClient } from "convex/react";
import { ConvexQueryCacheProvider } from "convex-helpers/react/cache";
import { ConvexQueryCacheContext } from "convex-helpers/react/cache/provider";
import { ThemeProvider, useTheme } from "next-themes";
import { useContext, useEffect, useRef, useState, type ReactNode } from "react";

import { authClient } from "@/lib/auth-client";
import { useFrontendLogger } from "@/lib/logging";
import { api } from "backend/convex/_generated/api";
import { keyManager } from "@/lib/crypto/key-manager";
import { useKeyStatus } from "@/lib/crypto/use-key-status";
import { MotionProvider } from "@/lib/motion";
import { themePlugin } from "@/lib/auth/theme-plugin";
import { AuthProvider } from "./auth/auth-provider";
import { WorkspaceProvider } from "./workspaces/workspace-provider";
import { TooltipProvider } from "./ui/tooltip";

export function Providers({
  children,
  convexClient,
  initialToken,
}: {
  children: ReactNode;
  convexClient: ConvexReactClient;
  initialToken?: string | null;
}) {
  const navigate = useNavigate();

  return (
    <ConvexBetterAuthProvider
      client={convexClient}
      authClient={authClient}
      initialToken={initialToken}
    >
      <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
        <AuthProvider
          authClient={authClient}
          redirectTo="/"
          navigate={navigate}
          plugins={[themePlugin({ useTheme })]}
          Link={Link}
        >
          <ConvexAuthQueryCache>
            <OperationalLogging>
              <WorkspaceProvider>
                <MotionProvider>
                  <TooltipProvider>{children}</TooltipProvider>
                </MotionProvider>
              </WorkspaceProvider>
            </OperationalLogging>
          </ConvexAuthQueryCache>
        </AuthProvider>
      </ThemeProvider>
    </ConvexBetterAuthProvider>
  );
}

function OperationalLogging({ children }: { children: ReactNode }) {
  const log = useFrontendLogger();
  const { isAuthenticated, isLoading } = useConvexAuth();
  const hasLoggedAppLoad = useRef(false);

  useEffect(() => {
    if (isLoading || !isAuthenticated || hasLoggedAppLoad.current) return;
    hasLoggedAppLoad.current = true;
    log({ level: "info", event: "app.loaded", metadata: { runtime: "browser" } });
  }, [isAuthenticated, isLoading, log]);

  return children;
}

/**
 * Convex query keys do not include the Better Auth identity, so discard the
 * client cache before a different user can reuse the previous user's data. The
 * convex-helpers subscription cache (Home's paginated lists) stays mounted with
 * its descendants hidden, and `ReleaseCachedQueries` ends the subscriptions they
 * left idle at once instead of after the cache's expiration.
 */
function ConvexAuthQueryCache({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const { data: session, isPending } = useSession(authClient);
  const userId = session?.user.id;
  const [cacheIdentity, setCacheIdentity] = useState<{
    initialized: boolean;
    userId?: string;
  }>({ initialized: false });
  const identityChanged =
    !isPending && cacheIdentity.initialized && cacheIdentity.userId !== userId;

  useEffect(() => {
    if (isPending) return;

    if (!cacheIdentity.initialized) {
      setCacheIdentity({ initialized: true, userId });
      return;
    }

    if (!identityChanged) return;

    // The previous user's keys must not survive into another identity (or a signed-out tab).
    if (cacheIdentity.userId) void keyManager.forget(cacheIdentity.userId);

    // Hide descendants until the previous user's identity-scoped data is gone.
    queryClient.removeQueries({ queryKey: ["convexQuery"] });
    setCacheIdentity({ initialized: true, userId });
  }, [
    cacheIdentity.initialized,
    cacheIdentity.userId,
    identityChanged,
    isPending,
    queryClient,
    userId,
  ]);

  // Unmounted subscriptions stay open five minutes, so a quick return to Home reuses its pages.
  return (
    <ConvexQueryCacheProvider expiration={5 * 60_000}>
      {identityChanged ? <ReleaseCachedQueries /> : children}
      <EncryptionKeysLifecycle userId={userId} isSessionPending={isPending} />
    </ConvexQueryCacheProvider>
  );
}

/**
 * Binds the key manager to the signed-in user. Whether the account has keys comes from
 * `e2ee:myKeyStatus`; a `null` answer means Convex auth has not caught up with the Better Auth
 * session yet, so nothing is decided then (treating it as "no keys" would delete freshly
 * unlocked keys right after sign-in). A server-side identity that differs from the unlocked one
 * (reset with new keys on another device) locks this tab.
 */
function EncryptionKeysLifecycle({
  userId,
  isSessionPending,
}: {
  userId: string | undefined;
  isSessionPending: boolean;
}) {
  const { isAuthenticated } = useConvexAuth();
  const serverKeys = useConvexQuery(api.e2ee.myKeyStatus, isAuthenticated && userId ? {} : "skip");
  const keyStatus = useKeyStatus();

  useEffect(() => {
    if (isSessionPending) return;
    if (!userId) {
      void keyManager.attachSession(null, false);
      return;
    }
    if (!serverKeys) return;
    void keyManager.attachSession({ id: userId }, serverKeys.state === "ready");
  }, [isSessionPending, serverKeys, userId]);

  const serverKeyId = serverKeys?.state === "ready" ? serverKeys.keyId : null;
  const unlockedKeyId = keyStatus.state === "unlocked" ? keyStatus.keyId : null;
  useEffect(() => {
    if (serverKeyId && unlockedKeyId && serverKeyId !== unlockedKeyId) void keyManager.lock();
  }, [serverKeyId, unlockedKeyId]);

  return null;
}

/**
 * Ends every idle cached subscription now. Rendered in place of the hidden descendants, so it runs
 * after their unmount has left all of the previous identity's subscriptions idle.
 */
function ReleaseCachedQueries() {
  const { registry } = useContext(ConvexQueryCacheContext);
  useEffect(() => {
    if (!registry) return;
    for (const [key, entry] of registry.queries) {
      if (entry.evictTimer === null) continue;
      clearTimeout(entry.evictTimer);
      entry.unsub();
      registry.queries.delete(key);
      registry.idle -= 1;
    }
  }, [registry]);
  return null;
}
