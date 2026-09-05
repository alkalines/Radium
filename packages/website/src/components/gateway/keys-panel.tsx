import { useState } from "react";
import { convexQuery } from "@convex-dev/react-query";
import { useQuery } from "@tanstack/react-query";
import { useMutation } from "convex/react";
import { CheckIcon, CopyIcon, KeySquareIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
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
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";

function formatCredits(value: number): string {
  return `$${value.toFixed(value < 1 ? 4 : 2)}`;
}

export function KeysPanel() {
  const { data: userInfo } = useQuery(convexQuery(api.auth.userInfo, {}));
  const balanceId = typeof userInfo === "string" ? undefined : userInfo?.balances[0]?._id;
  const { data: keys } = useQuery(
    convexQuery(api.keys.listKeys, balanceId ? { balance: balanceId } : "skip"),
  );

  const [createOpen, setCreateOpen] = useState(false);
  const [deleting, setDeleting] = useState<{ _id: Id<"keys">; name: string } | null>(null);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold tracking-tight">API keys</h2>
          <p className="text-sm text-muted-foreground">
            Issue and manage keys for calling models through the Radium Gateway.
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)} disabled={!balanceId}>
          <PlusIcon data-icon="inline-start" />
          Create key
        </Button>
      </div>

      {!balanceId && userInfo !== undefined && (
        <Alert>
          <AlertTitle>No balance yet</AlertTitle>
          <AlertDescription>A balance is required before keys can be issued.</AlertDescription>
        </Alert>
      )}

      {balanceId && keys === undefined ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
        </div>
      ) : balanceId && keys && keys.length === 0 ? (
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
      ) : balanceId && keys ? (
        <div className="flex flex-col divide-y rounded-lg border">
          {keys.map((key) => (
            <div key={key._id} className="flex items-center gap-3 p-3">
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate font-medium">{key.name}</span>
                <span className="truncate font-mono text-xs text-muted-foreground">
                  {key.preview ?? "rad-sk-…"}
                </span>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1">
                <Badge variant="secondary">{formatCredits(key.usedCredits)} used</Badge>
                {key.creditLimit !== undefined && (
                  <span className="text-xs text-muted-foreground">
                    limit {formatCredits(key.creditLimit)}
                  </span>
                )}
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="text-muted-foreground hover:text-destructive"
                onClick={() => setDeleting({ _id: key._id, name: key.name })}
                aria-label={`Revoke ${key.name}`}
              >
                <Trash2Icon />
              </Button>
            </div>
          ))}
        </div>
      ) : null}

      <CreateKeyDialog open={createOpen} onOpenChange={setCreateOpen} balanceId={balanceId} />
      <RevokeKeyDialog target={deleting} onOpenChange={(open) => !open && setDeleting(null)} />
    </div>
  );
}

function CreateKeyDialog({
  open,
  onOpenChange,
  balanceId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  balanceId: Id<"balances"> | undefined;
}) {
  const createKey = useMutation(api.keys.createKey);
  const [name, setName] = useState("");
  const [limit, setLimit] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [created, setCreated] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  function reset() {
    setName("");
    setLimit("");
    setCreated(null);
    setCopied(false);
  }

  async function submit() {
    if (!balanceId || !name.trim()) return;
    setSubmitting(true);
    try {
      const result = await createKey({
        balance: balanceId,
        name: name.trim(),
        creditLimit: limit.trim() ? Number(limit) : undefined,
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
                Name your key and optionally cap how much credit it can spend.
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
              <Field>
                <FieldLabel htmlFor="key-limit">Credit limit (optional)</FieldLabel>
                <Input
                  id="key-limit"
                  inputMode="decimal"
                  placeholder="No limit"
                  value={limit}
                  onChange={(event) => setLimit(event.target.value.replace(/[^0-9.]/g, ""))}
                />
                <FieldDescription>Maximum credits this key may spend, in dollars.</FieldDescription>
              </Field>
            </FieldGroup>
            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
                Cancel
              </Button>
              <Button onClick={submit} disabled={submitting || !name.trim() || !balanceId}>
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
  onOpenChange,
}: {
  target: { _id: Id<"keys">; name: string } | null;
  onOpenChange: (open: boolean) => void;
}) {
  const deleteKey = useMutation(api.keys.deleteKey);
  const [submitting, setSubmitting] = useState(false);

  async function confirm() {
    if (!target) return;
    setSubmitting(true);
    try {
      await deleteKey({ key: target._id });
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
