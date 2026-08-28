import { useEffect, useState } from "react";
import { useMutation } from "convex/react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { ProviderLogo } from "./provider-logo";

export type CredentialsTarget = {
  slug: string;
  name: string;
  env: string[];
};

export function CredentialsDialog({
  target,
  balanceId,
  hasExisting,
  preview,
  onOpenChange,
}: {
  target: CredentialsTarget | null;
  balanceId: Id<"balances"> | undefined;
  hasExisting: boolean;
  preview?: Record<string, string>;
  onOpenChange: (open: boolean) => void;
}) {
  const upsertCredentials = useMutation(api.providers.upsertCredentials);
  const deleteCredentials = useMutation(api.providers.deleteCredentials);
  const [values, setValues] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => setValues({}), [target?.slug]);

  const complete = target?.env.every((name) => values[name]?.trim()) ?? false;

  async function save() {
    if (!target || !balanceId) return;
    setSubmitting(true);
    try {
      await upsertCredentials({
        balance: balanceId,
        provider: target.slug,
        credentials: values,
      });
      toast.success(`Saved credentials for ${target.name}.`);
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to save credentials.");
    } finally {
      setSubmitting(false);
    }
  }

  async function remove() {
    if (!target || !balanceId) return;
    setSubmitting(true);
    try {
      await deleteCredentials({ balance: balanceId as never, provider: target.slug });
      toast.success(`Removed credentials for ${target.name}.`);
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to remove credentials.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={target !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {target && <ProviderLogo slug={target.slug} className="size-6" />}
            {target?.name} credentials
          </DialogTitle>
          <DialogDescription>
            Keys are encrypted at rest and only used for your own (BYOK) requests.
          </DialogDescription>
        </DialogHeader>

        {!balanceId ? (
          <p className="text-sm text-muted-foreground">
            You need an active balance before you can store credentials.
          </p>
        ) : (
          <FieldGroup>
            {target?.env.map((name) => (
              <Field key={name}>
                <FieldLabel htmlFor={`cred-${name}`}>{name}</FieldLabel>
                <Input
                  id={`cred-${name}`}
                  type="password"
                  autoComplete="off"
                  placeholder={hasExisting ? "Replace stored value" : `Enter ${name}`}
                  value={values[name] ?? ""}
                  onChange={(event) =>
                    setValues((prev) => ({ ...prev, [name]: event.target.value }))
                  }
                />
                {hasExisting && preview?.[name] && (
                  <FieldDescription>Current: {preview[name]}</FieldDescription>
                )}
              </Field>
            ))}
          </FieldGroup>
        )}

        <DialogFooter className="sm:justify-between">
          {hasExisting ? (
            <Button variant="ghost" onClick={remove} disabled={submitting || !balanceId}>
              Remove
            </Button>
          ) : (
            <span />
          )}
          <Button onClick={save} disabled={submitting || !balanceId || !complete}>
            {submitting && <Spinner data-icon="inline-start" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
