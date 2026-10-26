import { useEffect, useMemo, useRef, useState } from "react";
import { convexQuery } from "@convex-dev/react-query";
import { useQuery } from "@tanstack/react-query";
import { useMutation } from "convex/react";
import {
  MoreHorizontalIcon,
  PlusIcon,
  RouteIcon,
  SlidersHorizontalIcon,
  Trash2Icon,
} from "lucide-react";
import { toast } from "sonner";

import { GroupList, Row, RowBlock } from "@/components/harness/group-list";
import { WorkspacePageHeader } from "@/components/settings/workspace-page-header";
import { Button } from "@/components/ui/button";
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
import { api } from "backend/convex/_generated/api";
import type { Id } from "backend/convex/_generated/dataModel";
import { useWorkspace } from "@/components/workspaces/workspace-provider";
import type { WorkspaceProviderView } from "backend/src/workspaces/provider";
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
  const { workspaceId } = useWorkspace();
  const { data: providers } = useQuery(
    convexQuery(api.providers.list, workspaceId ? { workspace: workspaceId } : "skip"),
  );
  const setEnabled = useMutation(api.providers.setEnabled);

  const { data: credentials } = useQuery(
    convexQuery(api.providers.listCredentials, workspaceId ? { workspace: workspaceId } : "skip"),
  );

  // Disabled credentials are kept but never routed, so they do not make a provider connected.
  const connectedSlugs = useMemo(() => {
    const set = new Set<string>();
    for (const credential of credentials ?? []) {
      if (credential.enabled) set.add(credential.provider);
    }
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
      if (!workspaceId) return;
      await setEnabled({ workspace: workspaceId, slug, enabled });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to update provider.");
    }
  }

  return (
    <>
      <WorkspacePageHeader
        title="Providers"
        description="Connect upstream providers, manage their models, and choose which to expose."
        action={
          <Button onClick={() => setImportOpen(true)}>
            <PlusIcon data-icon="inline-start" />
            Add provider
          </Button>
        }
      />

      {showSkeleton || providers === undefined ? (
        <GroupList title="Connected">
          {[0, 1].map((placeholder) => (
            <RowBlock key={placeholder}>
              <Skeleton className="h-6" />
            </RowBlock>
          ))}
        </GroupList>
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
        <GroupList title="Connected">
          {providers.map((provider) => {
            const needsKey = provider.env.length > 0;
            const disconnected = needsKey && !connectedSlugs.has(provider.slug);
            return (
              <Row
                key={provider._id}
                data-disabled={!provider.enabled}
                className="data-[disabled=true]:opacity-60"
                leading={<ProviderLogo slug={provider.slug} className="size-8" />}
                title={provider.name}
                tag={disconnected ? "Not connected" : undefined}
                description={
                  <>
                    <span className="font-mono text-xs">{provider.slug}</span> ·{" "}
                    {provider.models.length} models
                  </>
                }
              >
                <Button variant="outline" size="sm" onClick={() => setManagingSlug(provider.slug)}>
                  <SlidersHorizontalIcon data-icon="inline-start" />
                  Manage models
                </Button>
                <Switch
                  checked={provider.enabled}
                  onCheckedChange={(value) => toggle(provider.slug, value)}
                  aria-label={`${provider.enabled ? "Disable" : "Enable"} ${provider.name}`}
                />
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon-xs" aria-label={`${provider.name} actions`}>
                      <MoreHorizontalIcon />
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
              </Row>
            );
          })}
        </GroupList>
      )}
      <ImportProviderDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        importedSlugs={importedSlugs}
        workspaceId={workspaceId}
      />

      <ModelManagerDialog
        provider={managing}
        onOpenChange={(open) => !open && setManagingSlug(null)}
      />

      <DeleteProviderDialog
        provider={deleting}
        workspaceId={workspaceId}
        onOpenChange={(open) => !open && setDeletingSlug(null)}
      />
    </>
  );
}

function DeleteProviderDialog({
  provider,
  workspaceId,
  onOpenChange,
}: {
  provider: WorkspaceProviderView | null;
  workspaceId: Id<"workspaces"> | undefined;
  onOpenChange: (open: boolean) => void;
}) {
  const deleteProvider = useMutation(api.providers.deleteProvider);
  const [submitting, setSubmitting] = useState(false);

  async function confirm() {
    if (!provider || !workspaceId) return;
    setSubmitting(true);
    try {
      await deleteProvider({ workspace: workspaceId, slug: provider.slug });
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
