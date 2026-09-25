import { useCallback, useEffect, useState } from "react";
import { useMutation } from "convex/react";
import { toast } from "sonner";
import { LoginWithChatGPT } from "@opencoredev/loginwithchatgpt-react";

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
import { api } from "backend/convex/_generated/api";
import type { Id } from "backend/convex/_generated/dataModel";
import { ProviderLogo } from "./provider-logo";
import { authClient } from "@/lib/auth-client";

export type CredentialsTarget = {
  slug: string;
  name: string;
  env: string[];
  credential_type?: "api_key" | "oauth";
  oauth_flow?: string;
};

export function CredentialsDialog({
  target,
  workspaceId,
  hasExisting,
  preview,
  onOpenChange,
}: {
  target: CredentialsTarget | null;
  workspaceId: Id<"workspaces"> | undefined;
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
  const oauthFetch = useCallback(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(
        typeof input === "string" || input instanceof URL ? input : input.url,
        window.location.origin,
      );
      if (workspaceId) url.searchParams.set("workspace", workspaceId);
      const { data } = await authClient.convex.token({ fetchOptions: { throw: false } });
      const headers = new Headers(init?.headers);
      if (data?.token) headers.set("Authorization", `Bearer ${data.token}`);
      return fetch(url, { ...init, headers, credentials: "include" });
    },
    [workspaceId],
  );

  async function save() {
    if (!target || !workspaceId) return;
    setSubmitting(true);
    try {
      await upsertCredentials({
        workspace: workspaceId,
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
    if (!target || !workspaceId) return;
    setSubmitting(true);
    try {
      await deleteCredentials({ workspace: workspaceId, provider: target.slug });
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
            {target?.credential_type === "oauth"
              ? "Connect your plan with OpenAI's device-code flow. Tokens stay encrypted on the server."
              : "Keys are encrypted at rest and only used for your own (BYOK) requests."}
          </DialogDescription>
        </DialogHeader>

        {!workspaceId ? (
          <p className="text-sm text-muted-foreground">
            You need an active workspace before you can store credentials.
          </p>
        ) : target?.credential_type === "oauth" && target.oauth_flow === "chatgpt-device" ? (
          <div className="flex min-h-24 items-center justify-center py-2">
            <LoginWithChatGPT
              basePath="/api/chatgpt-subscription"
              consent={{ appName: "Radium" }}
              fetch={oauthFetch as typeof fetch}
              label={hasExisting ? "Reconnect ChatGPT" : "Connect ChatGPT"}
            />
          </div>
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

        {target?.credential_type !== "oauth" ? (
          <DialogFooter className="sm:justify-between">
            {hasExisting ? (
              <Button variant="ghost" onClick={remove} disabled={submitting || !workspaceId}>
                Remove
              </Button>
            ) : (
              <span />
            )}
            <Button onClick={save} disabled={submitting || !workspaceId || !complete}>
              {submitting && <Spinner data-icon="inline-start" />}
              Save
            </Button>
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
