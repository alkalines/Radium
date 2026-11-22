import { useState } from "react";
import { skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { inferRouterOutputs } from "@trpc/server";
import { CheckIcon, CopyIcon, KeySquareIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";

import { GroupList, Row, RowBlock } from "@/components/harness/group-list";
import { WorkspacePageHeader } from "@/components/settings/workspace-page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Id } from "backend/convex/_generated/dataModel";
import type { AppRouter } from "server/router";
import { useTrpc } from "@/lib/trpc";
import { useWorkspace } from "@/components/workspaces/workspace-provider";

type KeyRow = inferRouterOutputs<AppRouter>["keys"]["list"][number];

function keyError(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function KeysPanel() {
  const { workspaceId } = useWorkspace();
  const trpc = useTrpc();
  const queryClient = useQueryClient();
  const { data: keys } = useQuery(
    trpc.keys.list.queryOptions(workspaceId ? { workspace: workspaceId } : skipToken),
  );
  const { mutateAsync: setKeyTelemetry } = useMutation(trpc.keys.setKeyTelemetry.mutationOptions());

  const [createOpen, setCreateOpen] = useState(false);
  const [deleting, setDeleting] = useState<KeyRow | null>(null);
  const [savingTelemetry, setSavingTelemetry] = useState<string | null>(null);

  async function changeTelemetry(key: KeyRow, enabled: boolean) {
    if (!workspaceId || key.worker || savingTelemetry) return;
    setSavingTelemetry(key.id);
    try {
      await setKeyTelemetry({
        workspace: workspaceId,
        key: key.id,
        telemetry: enabled ? "workspace" : "off",
      });
      await queryClient.invalidateQueries({ queryKey: trpc.keys.pathKey() });
    } catch (error) {
      toast.error(keyError(error, "Failed to update key telemetry."));
    } finally {
      setSavingTelemetry(null);
    }
  }

  return (
    <>
      <WorkspacePageHeader
        title="API keys"
        description="Issue and manage keys for calling models through the Radium Gateway."
        action={
          <Button onClick={() => setCreateOpen(true)} disabled={!workspaceId}>
            <PlusIcon data-icon="inline-start" />
            Create key
          </Button>
        }
      />

      {!workspaceId && (
        <Alert>
          <AlertTitle>No workspace selected</AlertTitle>
          <AlertDescription>Select or create a workspace before issuing keys.</AlertDescription>
        </Alert>
      )}

      {workspaceId && keys === undefined ? (
        <GroupList title="Keys">
          {[0, 1].map((placeholder) => (
            <RowBlock key={placeholder}>
              <Skeleton className="h-6" />
            </RowBlock>
          ))}
        </GroupList>
      ) : workspaceId && keys && keys.length === 0 ? (
        <Empty className="border border-dashed">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <KeySquareIcon />
            </EmptyMedia>
            <EmptyTitle>No keys yet</EmptyTitle>
            <EmptyDescription>Create a key to start calling the gateway API.</EmptyDescription>
          </EmptyHeader>
          <Button onClick={() => setCreateOpen(true)}>
            <PlusIcon data-icon="inline-start" />
            Create key
          </Button>
        </Empty>
      ) : workspaceId && keys ? (
        <GroupList title="Keys">
          {keys.map((key) => (
            <Row
              key={key.id}
              icon={KeySquareIcon}
              title={key.name}
              tag={
                key.worker
                  ? key.worker.name === key.name
                    ? "Worker"
                    : `Worker · ${key.worker.name}`
                  : "Workspace"
              }
              description={<span className="font-mono text-xs">{key.preview}</span>}
            >
              <KeyTelemetrySwitch
                keyRow={key}
                disabled={savingTelemetry !== null}
                onChange={(enabled) => void changeTelemetry(key, enabled)}
              />
              <Button
                variant="ghost"
                size="icon-xs"
                className="text-muted-foreground hover:text-destructive"
                onClick={() => setDeleting(key)}
                aria-label={`Revoke ${key.name}`}
              >
                <Trash2Icon />
              </Button>
            </Row>
          ))}
        </GroupList>
      ) : null}

      <CreateKeyDialog open={createOpen} onOpenChange={setCreateOpen} workspaceId={workspaceId} />
      <RevokeKeyDialog
        target={deleting}
        workspaceId={workspaceId}
        onOpenChange={(open) => !open && setDeleting(null)}
      />
    </>
  );
}

/** On follows the workspace telemetry settings; a Worker key's switch lives on its Worker. */
function KeyTelemetrySwitch({
  keyRow,
  disabled,
  onChange,
}: {
  keyRow: KeyRow;
  disabled: boolean;
  onChange: (enabled: boolean) => void;
}) {
  const isWorkerKey = keyRow.worker !== null;
  const enabled = keyRow.telemetry === "workspace";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={isWorkerKey ? 0 : -1} className="mr-2 flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Telemetry</span>
          <Switch
            checked={enabled}
            disabled={disabled || isWorkerKey}
            onCheckedChange={onChange}
            aria-label={`Telemetry for ${keyRow.name}`}
          />
        </span>
      </TooltipTrigger>
      <TooltipContent>
        {isWorkerKey
          ? "Set on the Worker"
          : enabled
            ? "Follows the workspace telemetry settings"
            : "Requests with this key are not captured"}
      </TooltipContent>
    </Tooltip>
  );
}

function CreateKeyDialog({
  open,
  onOpenChange,
  workspaceId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: Id<"workspaces"> | undefined;
}) {
  const trpc = useTrpc();
  const queryClient = useQueryClient();
  // The plaintext key lives only in this mutation's result and the `created` state below; the
  // mutation is reset when the dialog closes and never kept past its observer.
  const {
    mutateAsync: createKey,
    reset: resetCreateKey,
  } = useMutation({ ...trpc.keys.create.mutationOptions(), gcTime: 0 });
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [created, setCreated] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  function reset() {
    setName("");
    setCreated(null);
    resetCreateKey();
    setCopied(false);
  }

  async function submit() {
    if (!workspaceId || !name.trim()) return;
    setSubmitting(true);
    try {
      const result = await createKey({
        workspace: workspaceId,
        name: name.trim(),
      });
      setCreated(result.key);
      await queryClient.invalidateQueries({ queryKey: trpc.keys.pathKey() });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to create key.");
    } finally {
      setSubmitting(false);
    }
  }

  async function copy() {
    if (!created) return;
    await navigator.clipboard.writeText(created);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) reset();
      }}
    >
      <DialogContent className="sm:max-w-md">
        {created ? (
          <>
            <DialogHeader>
              <DialogTitle>Key created</DialogTitle>
              <DialogDescription>
                Copy it now — this is the only time the full key is shown.
              </DialogDescription>
            </DialogHeader>
            <InputGroup>
              <InputGroupInput readOnly value={created} className="font-mono" />
              <InputGroupAddon align="inline-end">
                <InputGroupButton onClick={copy} aria-label="Copy key">
                  {copied ? <CheckIcon /> : <CopyIcon />}
                </InputGroupButton>
              </InputGroupAddon>
            </InputGroup>
            <DialogFooter>
              <Button onClick={() => onOpenChange(false)}>Done</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Create API key</DialogTitle>
              <DialogDescription>
                Name your key for identifying gateway requests from this workspace.
              </DialogDescription>
            </DialogHeader>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="key-name">Name</FieldLabel>
                <Input
                  id="key-name"
                  placeholder="Production"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </Field>
            </FieldGroup>
            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
                Cancel
              </Button>
              <Button onClick={submit} disabled={submitting || !name.trim() || !workspaceId}>
                {submitting && <Spinner data-icon="inline-start" />}
                Create key
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function RevokeKeyDialog({
  target,
  workspaceId,
  onOpenChange,
}: {
  target: KeyRow | null;
  workspaceId: Id<"workspaces"> | undefined;
  onOpenChange: (open: boolean) => void;
}) {
  const trpc = useTrpc();
  const queryClient = useQueryClient();
  const { mutateAsync: deleteKey } = useMutation(trpc.keys.delete.mutationOptions());
  const [submitting, setSubmitting] = useState(false);

  async function confirm() {
    if (!target || !workspaceId) return;
    setSubmitting(true);
    try {
      await deleteKey({ workspace: workspaceId, key: target.id });
      await queryClient.invalidateQueries({ queryKey: trpc.keys.pathKey() });
      toast.success(`Revoked ${target.name}.`);
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to revoke key.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={target !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Revoke {target?.name}?</DialogTitle>
          <DialogDescription>
            Requests using this key will immediately stop working. This cannot be undone.
            {target?.worker
              ? " The Worker's Gateway agents stop until the owner issues a new key."
              : null}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="sm:justify-between">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={confirm} disabled={submitting}>
            {submitting && <Spinner data-icon="inline-start" />}
            Revoke key
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
