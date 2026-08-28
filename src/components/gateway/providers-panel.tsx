import { useEffect, useMemo, useRef, useState } from "react";
import { convexQuery } from "@convex-dev/react-query";
import { useQuery } from "@tanstack/react-query";
import { useMutation } from "convex/react";
import {
  MoreVerticalIcon,
  PlusIcon,
  RouteIcon,
  SlidersHorizontalIcon,
  Trash2Icon,
} from "lucide-react";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { api } from "../../../convex/_generated/api";
import type { Doc } from "../../../convex/_generated/dataModel";
import { ImportProviderDialog } from "./import-provider-dialog";
import { ModelManagerDialog } from "./model-manager-dialog";
import { ProviderLogo } from "./provider-logo";

/**
 * Keeps `isLoading` reported as `true` for at least `minMs` once it ever starts,
 * so fast-resolving data does not produce a jarring skeleton flash. Returns
 * `false` from the first render if loading never started (e.g. warm cache).
 */
function useMinimumLoading(isLoading: boolean, minMs = 450): boolean {
  const [held, setHeld] = useState(isLoading);
  const startedAt = useRef<number | null>(isLoading ? Date.now() : null);

  useEffect(() => {
    if (isLoading) {
      if (startedAt.current === null) startedAt.current = Date.now();
      setHeld(true);
      return;
    }

    if (startedAt.current === null) {
      setHeld(false);
      return;
    }

    const remaining = minMs - (Date.now() - startedAt.current);
    if (remaining <= 0) {
      startedAt.current = null;
      setHeld(false);
      return;
    }

    const timeout = window.setTimeout(() => {
      startedAt.current = null;
      setHeld(false);
    }, remaining);
    return () => window.clearTimeout(timeout);
  }, [isLoading, minMs]);

  return held;
}

export function ProvidersPanel() {
  const { data: providers } = useQuery(convexQuery(api.providers.list, {}));
  const { data: userInfo } = useQuery(convexQuery(api.auth.userInfo, {}));
  const setEnabled = useMutation(api.providers.setEnabled);

  const balanceId = typeof userInfo === "string" ? undefined : userInfo?.balances[0]?._id;
  const { data: credentials } = useQuery(
    convexQuery(api.providers.listCredentials, balanceId ? { balance: balanceId } : "skip"),
  );

  const connectedSlugs = useMemo(() => {
    const set = new Set<string>();
    for (const credential of credentials ?? []) set.add(credential.provider);
    return set;
  }, [credentials]);

  const [importOpen, setImportOpen] = useState(false);
  const [managingSlug, setManagingSlug] = useState<string | null>(null);
  const [deletingSlug, setDeletingSlug] = useState<string | null>(null);

  const showSkeleton = useMinimumLoading(providers === undefined);

  const importedSlugs = (providers ?? []).map((provider) => provider.slug);

  // Resolve dialog targets from live query data so edits reflect immediately.
  const managing = providers?.find((provider) => provider.slug === managingSlug) ?? null;
  const deleting = providers?.find((provider) => provider.slug === deletingSlug) ?? null;

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
            Connect upstream providers, manage their models, and choose which to expose.
          </p>
        </div>
        <Button onClick={() => setImportOpen(true)}>
          <PlusIcon data-icon="inline-start" />
          Add provider
        </Button>
      </div>

      {showSkeleton || providers === undefined ? (
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
              Import a provider from models.dev — or add a custom one — to start routing requests.
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
            const needsKey = provider.env.length > 0;
            const disconnected = needsKey && !connectedSlugs.has(provider.slug);
            return (
              <Card
                key={provider._id}
                data-disabled={!provider.enabled}
                className="data-[disabled=true]:opacity-60"
              >
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
                  <CardAction className="flex items-center gap-1">
                    <Switch
                      checked={provider.enabled}
                      onCheckedChange={(value) => toggle(provider.slug, value)}
                      aria-label={`${provider.enabled ? "Disable" : "Enable"} ${provider.name}`}
                    />
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" aria-label={`${provider.name} actions`}>
                          <MoreVerticalIcon />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onSelect={() => setManagingSlug(provider.slug)}>
                          <SlidersHorizontalIcon />
                          Manage models
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          variant="destructive"
                          onSelect={() => setDeletingSlug(provider.slug)}
                        >
                          <Trash2Icon />
                          Delete provider
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </CardAction>
                </CardHeader>
                <CardContent className="flex flex-col gap-3">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge variant="secondary">{provider.models.length} models</Badge>
                    {disconnected && <Badge variant="outline">Not connected</Badge>}
                  </div>

                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full"
                    onClick={() => setManagingSlug(provider.slug)}
                  >
                    <SlidersHorizontalIcon data-icon="inline-start" />
                    Manage models
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

      <ModelManagerDialog
        provider={managing}
        onOpenChange={(open) => !open && setManagingSlug(null)}
      />

      <DeleteProviderDialog
        provider={deleting}
        onOpenChange={(open) => !open && setDeletingSlug(null)}
      />
    </div>
  );
}

function DeleteProviderDialog({
  provider,
  onOpenChange,
}: {
  provider: Doc<"providers"> | null;
  onOpenChange: (open: boolean) => void;
}) {
  const deleteProvider = useMutation(api.providers.deleteProvider);
  const [submitting, setSubmitting] = useState(false);

  async function confirm() {
    if (!provider) return;
    setSubmitting(true);
    try {
      await deleteProvider({ slug: provider.slug });
      toast.success(`Deleted ${provider.name}.`);
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to delete provider.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={provider !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete {provider?.name}?</DialogTitle>
          <DialogDescription>
            This removes the provider and any stored BYOK credentials for it. Models stay in the
            global catalogue and remain available through other providers.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="sm:justify-between">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={confirm} disabled={submitting}>
            {submitting && <Spinner data-icon="inline-start" />}
            Delete provider
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
