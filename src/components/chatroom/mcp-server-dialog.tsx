import { useEffect, useState } from "react";
import { useMutation } from "convex/react";
import { toast } from "sonner";

import { MCP_AUTH_TYPES, MCP_BEARER_SECRET_KEY, type McpAuthType } from "@/utils/chatroom/tools";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";

/** An MCP server being edited, or `null` when creating a new one. */
export type McpServerEditTarget = {
  _id: Id<"mcp_servers">;
  name: string;
  url: string;
  auth: { type: McpAuthType };
  preview?: Record<string, string>;
  hasSecret: boolean;
} | null;

/**
 * Create/edit dialog for an MCP server connection. Mirrors the BYOK credentials
 * dialog: secrets are write-only (a masked preview is shown for stored values)
 * and only sent when the user types a new one.
 */
export function McpServerDialog({
  open,
  target,
  balanceId,
  onOpenChange,
}: {
  open: boolean;
  target: McpServerEditTarget;
  balanceId: Id<"balances"> | undefined;
  onOpenChange: (open: boolean) => void;
}) {
  const createServer = useMutation(api.mcp.createServer);
  const updateServer = useMutation(api.mcp.updateServer);

  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [authType, setAuthType] = useState<McpAuthType>("none");
  const [secret, setSecret] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const isEditing = target !== null;

  // Reseed the form whenever the dialog opens for a different target.
  useEffect(() => {
    if (!open) return;
    setName(target?.name ?? "");
    setUrl(target?.url ?? "");
    setAuthType(target?.auth.type ?? "none");
    setSecret("");
  }, [open, target]);

  const authMeta = MCP_AUTH_TYPES.find((entry) => entry.value === authType);
  const needsSecret = authMeta?.requiresSecret ?? false;
  // A bearer server is incomplete only when no secret is stored and none typed.
  const secretSatisfied = !needsSecret || secret.trim().length > 0 || target?.hasSecret === true;
  const complete = name.trim().length > 0 && url.trim().length > 0 && secretSatisfied;

  async function save() {
    if (!complete) return;
    setSubmitting(true);
    try {
      if (isEditing) {
        await updateServer({
          server: target._id,
          name: name.trim(),
          url: url.trim(),
          auth: { type: authType },
          secret: secret.trim() || undefined,
        });
        toast.success(`Updated ${name.trim()}.`);
      } else {
        if (!balanceId) return;
        await createServer({
          balance: balanceId,
          name: name.trim(),
          url: url.trim(),
          auth: { type: authType },
          secret: secret.trim() || undefined,
        });
        toast.success(`Added ${name.trim()}.`);
      }
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to save MCP server.");
    } finally {
      setSubmitting(false);
    }
  }

  const storedPreview = target?.preview?.[MCP_BEARER_SECRET_KEY];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isEditing ? "Edit MCP server" : "Add MCP server"}</DialogTitle>
          <DialogDescription>
            Connect a Model Context Protocol server over HTTP. Tokens are encrypted at rest and
            only used for your own requests.
          </DialogDescription>
        </DialogHeader>

        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="mcp-name">Name</FieldLabel>
            <Input
              id="mcp-name"
              placeholder="My MCP server"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>

          <Field>
            <FieldLabel htmlFor="mcp-url">Server URL</FieldLabel>
            <Input
              id="mcp-url"
              type="url"
              autoComplete="off"
              placeholder="https://example.com/mcp"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
            />
            <FieldDescription>Streamable HTTP transport endpoint.</FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor="mcp-auth">Authentication</FieldLabel>
            <Select value={authType} onValueChange={(value) => setAuthType(value as McpAuthType)}>
              <SelectTrigger id="mcp-auth">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MCP_AUTH_TYPES.map((entry) => (
                  <SelectItem key={entry.value} value={entry.value}>
                    {entry.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {authMeta && <FieldDescription>{authMeta.description}</FieldDescription>}
          </Field>

          {needsSecret && (
            <Field>
              <FieldLabel htmlFor="mcp-secret">Bearer token</FieldLabel>
              <Input
                id="mcp-secret"
                type="password"
                autoComplete="off"
                placeholder={target?.hasSecret ? "Replace stored token" : "Enter token"}
                value={secret}
                onChange={(event) => setSecret(event.target.value)}
              />
              {target?.hasSecret && storedPreview && (
                <FieldDescription>Current: {storedPreview}</FieldDescription>
              )}
            </Field>
          )}
        </FieldGroup>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={save} disabled={submitting || !complete || (!isEditing && !balanceId)}>
            {submitting && <Spinner data-icon="inline-start" />}
            {isEditing ? "Save changes" : "Add server"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
