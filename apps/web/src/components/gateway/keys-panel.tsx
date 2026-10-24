import { useState } from "react";
import { convexQuery } from "@convex-dev/react-query";
import { useQuery } from "@tanstack/react-query";
import { useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
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
import { api } from "backend/convex/_generated/api";
import type { Id } from "backend/convex/_generated/dataModel";
import { useWorkspace } from "@/components/workspaces/workspace-provider";

type KeyRow = FunctionReturnType<typeof api.keys.listKeys>[number];

export function KeysPanel() {
  const { workspaceId } = useWorkspace();
  const { data: keys } = useQuery(
    convexQuery(api.keys.listKeys, workspaceId ? { workspace: workspaceId } : "skip"),
  );

  const [createOpen, setCreateOpen] = useState(false);
  const [deleting, setDeleting] = useState<KeyRow | null>(null);

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
              key={key._id}
              icon={KeySquareIcon}
              title={key.name}
              tag={key.source === "legacy" ? "Historical" : "Workspace"}
              description={<span className="font-mono text-xs">{key.preview ?? "rad-sk-…"}</span>}
            >
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

function CreateKeyDialog({
  open,
  onOpenChange,
  workspaceId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: Id<"workspaces"> | undefined;
}) {
  const createKey = useMutation(api.keys.createKey);
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [created, setCreated] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  function reset() {
    setName("");
    setCreated(null);
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
  const deleteKey = useMutation(api.keys.deleteKey);
  const deleteLegacyKey = useMutation(api.keys.deleteLegacyKey);
  const [submitting, setSubmitting] = useState(false);

  async function confirm() {
    if (!target) return;
    setSubmitting(true);
    try {
      if (target.source === "legacy") {
        if (!workspaceId) return;
        await deleteLegacyKey({ workspace: workspaceId, keyId: target._id });
      } else {
        await deleteKey({ key: target._id });
      }
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
            {target?.source === "legacy"
              ? "This historical key will stop working immediately. This cannot be undone."
              : "Requests using this key will immediately stop working. This cannot be undone."}
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
