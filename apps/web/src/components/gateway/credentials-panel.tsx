import { useMemo, useState, type ReactNode } from "react";
import { convexQuery } from "@convex-dev/react-query";
import { useQuery } from "@tanstack/react-query";
import { KeyRoundIcon } from "lucide-react";

import { AgentStatus } from "@/components/agentic/agent-status";
import { GroupList, Row, RowBlock } from "@/components/harness/group-list";
import { WorkspacePageHeader } from "@/components/settings/workspace-page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "backend/convex/_generated/api";
import { CredentialsDialog, type CredentialsTarget } from "./credentials-dialog";
import { ProviderLogo } from "./provider-logo";
import { useWorkspace } from "@/components/workspaces/workspace-provider";

/** One-line description of what a provider needs to connect. Environment variable names are Machine text. */
function credentialSummary(provider: { credential_type?: string; env: string[] }): ReactNode {
  if (provider.credential_type === "oauth") return "OAuth device connection";
  if (provider.env.length === 0) return "No credentials required";
  return <span className="font-mono text-xs">{provider.env.join(", ")}</span>;
}

export function CredentialsPanel() {
  const { workspaceId } = useWorkspace();
  const { data: providers } = useQuery(
    convexQuery(api.providers.list, workspaceId ? { workspace: workspaceId } : "skip"),
  );
  const { data: credentials } = useQuery(
    convexQuery(api.providers.listCredentials, workspaceId ? { workspace: workspaceId } : "skip"),
  );

  const credentialsBySlug = useMemo(() => {
    const map = new Map<string, Record<string, string>>();
    for (const credential of credentials ?? []) map.set(credential.provider, credential.preview);
    return map;
  }, [credentials]);

  const [target, setTarget] = useState<CredentialsTarget | null>(null);

  return (
    <>
      <WorkspacePageHeader
        title="Credentials"
        description="Connect API keys or subscription plans. Secrets stay encrypted and are used only for your requests."
      />

      {!workspaceId && (
        <Alert>
          <AlertTitle>No workspace selected</AlertTitle>
          <AlertDescription>
            Select or create a workspace before storing credentials.
          </AlertDescription>
        </Alert>
      )}

      {providers === undefined ? (
        <GroupList title="Providers">
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
              <KeyRoundIcon />
            </EmptyMedia>
            <EmptyTitle>No providers to configure</EmptyTitle>
            <EmptyDescription>Import a provider first, then add your keys here.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <GroupList title="Providers">
          {providers.map((provider) => {
            const preview = credentialsBySlug.get(provider.slug);
            return (
              <Row
                key={provider._id}
                leading={<ProviderLogo slug={provider.slug} className="size-8" />}
                title={provider.name}
                description={credentialSummary(provider)}
              >
                {preview ? (
                  <AgentStatus state="succeeded" label="Connected" />
                ) : (
                  <AgentStatus
                    state="idle"
                    label={provider.credential_type === "oauth" ? "Not connected" : "No key"}
                  />
                )}
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!workspaceId || provider.env.length === 0}
                  onClick={() =>
                    setTarget({
                      slug: provider.slug,
                      name: provider.name,
                      env: provider.env,
                      credential_type: provider.credential_type,
                      oauth_flow: provider.oauth_flow,
                    })
                  }
                >
                  {preview ? "Manage" : provider.credential_type === "oauth" ? "Connect" : "Add"}
                </Button>
              </Row>
            );
          })}
        </GroupList>
      )}

      <CredentialsDialog
        target={target}
        workspaceId={workspaceId}
        hasExisting={Boolean(target && credentialsBySlug.has(target.slug))}
        preview={target ? credentialsBySlug.get(target.slug) : undefined}
        onOpenChange={(open) => !open && setTarget(null)}
      />
    </>
  );
}
