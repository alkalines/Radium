import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { KeyRoundIcon, PlusIcon, RouteIcon } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { api } from "../../../convex/_generated/api";
import { CredentialsDialog, type CredentialsTarget } from "./credentials-dialog";
import { ImportProviderDialog } from "./import-provider-dialog";
import { ProviderLogo } from "./provider-logo";

export function ProvidersPanel() {
  const providers = useQuery(api.providers.list);
  const userInfo = useQuery(api.auth.userInfo);
  const setEnabled = useMutation(api.providers.setEnabled);

  const balanceId = typeof userInfo === "string" ? undefined : userInfo?.balances[0]?._id;
  const credentials = useQuery(
    api.providers.listCredentials,
    balanceId ? { balance: balanceId } : "skip",
  );

  const credentialsBySlug = useMemo(() => {
    const map = new Map<string, Record<string, string>>();
    for (const credential of credentials ?? []) map.set(credential.provider, credential.preview);
    return map;
  }, [credentials]);

  const [importOpen, setImportOpen] = useState(false);
  const [credTarget, setCredTarget] = useState<CredentialsTarget | null>(null);

  const importedSlugs = (providers ?? []).map((provider) => provider.slug);

  async function toggle(slug: string, enabled: boolean) {
    try {
      await setEnabled({ slug, enabled });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to update provider.");
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold tracking-tight">Providers</h2>
          <p className="text-sm text-muted-foreground">
            Connect upstream providers from models.dev and choose which models to expose.
          </p>
        </div>
        <Button onClick={() => setImportOpen(true)}>
          <PlusIcon data-icon="inline-start" />
          Add provider
        </Button>
      </div>

      {providers === undefined ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <Skeleton className="h-40" />
          <Skeleton className="h-40" />
        </div>
      ) : providers.length === 0 ? (
        <Empty className="border border-dashed">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <RouteIcon />
            </EmptyMedia>
            <EmptyTitle>No providers yet</EmptyTitle>
            <EmptyDescription>
              Import a provider from models.dev to start routing requests through the gateway.
            </EmptyDescription>
          </EmptyHeader>
          <Button onClick={() => setImportOpen(true)}>
            <PlusIcon data-icon="inline-start" />
            Add provider
          </Button>
        </Empty>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {providers.map((provider) => {
            const preview = credentialsBySlug.get(provider.slug);
            return (
              <Card key={provider._id} data-disabled={!provider.enabled} className="data-[disabled=true]:opacity-60">
                <CardHeader>
                  <div className="flex items-center gap-3">
                    <ProviderLogo slug={provider.slug} className="size-9" />
                    <div className="flex min-w-0 flex-col">
                      <CardTitle className="truncate">{provider.name}</CardTitle>
                      <CardDescription className="truncate font-mono text-xs">
                        {provider.slug}
                      </CardDescription>
                    </div>
                  </div>
                  <CardAction>
                    <Switch
                      checked={provider.enabled}
                      onCheckedChange={(value) => toggle(provider.slug, value)}
                      aria-label={`${provider.enabled ? "Disable" : "Enable"} ${provider.name}`}
                    />
                  </CardAction>
                </CardHeader>
                <CardContent className="flex flex-col gap-3">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge variant="secondary">{provider.models.length} models</Badge>
                    <Badge variant="outline" className="font-mono text-[0.6875rem]">
                      {provider.npm.replace(/^@(ai-sdk|openrouter)\//, "")}
                    </Badge>
                    {preview ? (
                      <Badge className="gap-1">
                        <KeyRoundIcon className="size-3" /> Connected
                      </Badge>
                    ) : (
                      <Badge variant="outline">No key</Badge>
                    )}
                  </div>

                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full"
                    onClick={() =>
                      setCredTarget({ slug: provider.slug, name: provider.name, env: provider.env })
                    }
                  >
                    <KeyRoundIcon data-icon="inline-start" />
                    {preview ? "Manage credentials" : "Add credentials"}
                  </Button>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <ImportProviderDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        importedSlugs={importedSlugs}
        balanceId={balanceId}
      />

      <CredentialsDialog
        target={credTarget}
        balanceId={balanceId}
        hasExisting={Boolean(credTarget && credentialsBySlug.has(credTarget.slug))}
        preview={credTarget ? credentialsBySlug.get(credTarget.slug) : undefined}
        onOpenChange={(open) => !open && setCredTarget(null)}
      />
    </div>
  );
}
