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
import {
  CredentialsDialog,
  type CredentialsTarget,
  type ProviderCredential,
} from "./credentials-dialog";
import { ProviderLogo } from "./provider-logo";
import { useWorkspace } from "@/components/workspaces/workspace-provider";

/** One-line description of what a provider needs to connect. Environment variable names are Machine text. */
function credentialSummary(provider: { credential_type?: string; env: string[] }): ReactNode {
  if (provider.credential_type === "oauth") return "Account sign-in";
  if (provider.env.length === 0) return "No credentials required";
  return <span className="font-mono text-xs">{provider.env.join(", ")}</span>;
}

function countLabel(count: number, singular: string, plural: string) {
  return `${count} ${count === 1 ? singular : plural}`;
}

/**
 * Pool status for one provider: how many enabled credentials it can route through, noting kept
 * but disabled ones. Disabled credentials are never routed, so they do not count as connected.
 */
function PoolStatus({ oauth, credentials }: { oauth: boolean; credentials: ProviderCredential[] }) {
  if (credentials.length === 0) {
    return <AgentStatus state="idle" label={oauth ? "Not connected" : "No key"} />;
  }

  const [singular, plural] = oauth ? ["account", "accounts"] : ["key", "keys"];
  const enabled = credentials.filter((credential) => credential.enabled).length;
  const disabled = credentials.length - enabled;

  if (enabled === 0) {
    return (
      <AgentStatus state="idle" label={`${countLabel(disabled, singular, plural)} disabled`} />
    );
  }

  const label = countLabel(enabled, singular, plural);
  return (
    <AgentStatus
      state="succeeded"
      label={disabled > 0 ? `${label} · ${disabled} disabled` : label}
    />
  );
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
    const map = new Map<string, ProviderCredential[]>();
    for (const credential of credentials ?? []) {
      const pool = map.get(credential.provider);
      if (pool) pool.push(credential);
      else map.set(credential.provider, [credential]);
    }
    return map;
  }, [credentials]);

  const [target, setTarget] = useState<CredentialsTarget | null>(null);

  return (
    <>
      <WorkspacePageHeader
        title="Credentials"
        description="Connect API keys or subscription accounts. A provider with several rotates requests across its enabled ones. Secrets stay encrypted and are never shown again."
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
            const pool = credentialsBySlug.get(provider.slug) ?? [];
            const oauth = provider.credential_type === "oauth";
            return (
              <Row
                key={provider._id}
                leading={<ProviderLogo slug={provider.slug} className="size-8" />}
                title={provider.name}
                description={credentialSummary(provider)}
              >
                <PoolStatus oauth={oauth} credentials={pool} />
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
                  {pool.length > 0 ? "Manage" : oauth ? "Connect" : "Add"}
                </Button>
              </Row>
            );
          })}
        </GroupList>
      )}

      <CredentialsDialog
        target={target}
        workspaceId={workspaceId}
        credentials={(target && credentialsBySlug.get(target.slug)) ?? []}
        onOpenChange={(open) => !open && setTarget(null)}
      />
    </>
  );
}
