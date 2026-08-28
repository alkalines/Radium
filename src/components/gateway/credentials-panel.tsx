import { useMemo, useState } from "react";
import { convexQuery } from "@convex-dev/react-query";
import { useQuery } from "@tanstack/react-query";
import { KeyRoundIcon } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "../../../convex/_generated/api";
import { CredentialsDialog, type CredentialsTarget } from "./credentials-dialog";
import { ProviderLogo } from "./provider-logo";

export function CredentialsPanel() {
  const { data: providers } = useQuery(convexQuery(api.providers.list, {}));
  const { data: userInfo } = useQuery(convexQuery(api.auth.userInfo, {}));
  const balanceId = typeof userInfo === "string" ? undefined : userInfo?.balances[0]?._id;
  const { data: credentials } = useQuery(
    convexQuery(api.providers.listCredentials, balanceId ? { balance: balanceId } : "skip"),
  );

  const credentialsBySlug = useMemo(() => {
    const map = new Map<string, Record<string, string>>();
    for (const credential of credentials ?? []) map.set(credential.provider, credential.preview);
    return map;
  }, [credentials]);

  const [target, setTarget] = useState<CredentialsTarget | null>(null);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold tracking-tight">Credentials</h2>
        <p className="text-sm text-muted-foreground">
          Bring your own keys (BYOK). Stored encrypted and used only for your own requests.
        </p>
      </div>

      {!balanceId && userInfo !== undefined && (
        <Alert>
          <AlertTitle>No balance yet</AlertTitle>
          <AlertDescription>
            A balance is required before credentials can be stored.
          </AlertDescription>
        </Alert>
      )}

      {providers === undefined ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-14" />
          <Skeleton className="h-14" />
        </div>
      ) : providers.length === 0 ? (
        <Empty className="border border-dashed">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <KeyRoundIcon />
            </EmptyMedia>
            <EmptyTitle>No providers to configure</EmptyTitle>
            <EmptyDescription>Import a provider first, then add your keys here.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="flex flex-col divide-y rounded-lg border">
          {providers.map((provider) => {
            const preview = credentialsBySlug.get(provider.slug);
            return (
              <div key={provider._id} className="flex items-center gap-3 p-3">
                <ProviderLogo slug={provider.slug} className="size-8" />
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-medium">{provider.name}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {provider.env.length > 0 ? provider.env.join(", ") : "No credentials required"}
                  </span>
                </div>
                {preview ? (
                  <Badge className="gap-1">
                    <KeyRoundIcon className="size-3" /> Connected
                  </Badge>
                ) : (
                  <Badge variant="outline">No key</Badge>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!balanceId || provider.env.length === 0}
                  onClick={() =>
                    setTarget({ slug: provider.slug, name: provider.name, env: provider.env })
                  }
                >
                  {preview ? "Manage" : "Add"}
                </Button>
              </div>
            );
          })}
        </div>
      )}

      <CredentialsDialog
        target={target}
        balanceId={balanceId}
        hasExisting={Boolean(target && credentialsBySlug.has(target.slug))}
        preview={target ? credentialsBySlug.get(target.slug) : undefined}
        onOpenChange={(open) => !open && setTarget(null)}
      />
    </div>
  );
}
