import { useState } from "react";
import { convexQuery } from "@convex-dev/react-query";
import { useQuery } from "@tanstack/react-query";
import { SearchIcon } from "lucide-react";

import { api } from "backend/convex/_generated/api";
import { ModelAuthorLogo } from "./model-list";
import { GroupList, Row, RowBlock } from "@/components/harness/group-list";
import { PageHeader } from "@/components/harness/page-header";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useWorkspace } from "@/components/workspaces/workspace-provider";
import { modelDisplayName } from "./model-options";
import { useModelPreferences } from "./model-preferences";

// Short lists read at a glance; a search field only earns its space on longer catalogues.
const searchThreshold = 8;

/**
 * Settings → Account → Models: the signed-in user's pin and hide choices for the models the
 * current workspace can route. Preferences are user-level (`api.preferences`), so they follow the
 * user into every workspace; the list itself comes from the current workspace because that is
 * what the pickers offer. Rows keep their catalogue order so toggling never moves them.
 */
export function ModelPreferencesPanel() {
  const { workspace, workspaceId, isLoading: isWorkspaceLoading } = useWorkspace();
  const { data: models } = useQuery(
    convexQuery(api.models.availableModels, workspaceId ? { workspace: workspaceId } : "skip"),
  );
  const {
    pinnedModels,
    hiddenModels,
    isLoading: isPreferencesLoading,
    setModelPinned,
    setModelHidden,
  } = useModelPreferences();
  const [query, setQuery] = useState("");

  const normalizedQuery = query.trim().toLowerCase();
  const visibleModels = (models ?? []).filter((model) =>
    [model.name, model.slug, model.author?.name ?? ""].some((text) =>
      text.toLowerCase().includes(normalizedQuery),
    ),
  );
  const isListLoading = isWorkspaceLoading || (workspaceId !== undefined && models === undefined);

  let listTitle = "Available models";
  if (workspace) {
    listTitle = `Available in ${workspace.name}`;
  }

  return (
    <>
      <PageHeader
        title="Models"
        description="Pin the models you use most so they list first in model pickers, and hide the rest; a hidden model still shows while selected. These preferences belong to your account and apply in every workspace."
      />

      {(models?.length ?? 0) > searchThreshold ? (
        <InputGroup className="h-8 rounded-xl">
          <InputGroupAddon>
            <SearchIcon />
          </InputGroupAddon>
          <InputGroupInput
            type="search"
            value={query}
            placeholder="Search models"
            aria-label="Search models"
            onChange={(event) => setQuery(event.target.value)}
          />
        </InputGroup>
      ) : null}

      <GroupList title={listTitle}>
        {isListLoading ? (
          <RowBlock aria-busy="true">
            <Skeleton className="h-8" />
            <Skeleton className="h-8" />
            <Skeleton className="h-8" />
          </RowBlock>
        ) : null}

        {!isListLoading && !workspace ? (
          <RowBlock className="text-sm text-muted-foreground">
            Choose a workspace to see the models it offers.
          </RowBlock>
        ) : null}

        {!isListLoading && workspace && models?.length === 0 ? (
          <RowBlock className="text-sm text-muted-foreground">
            No models are available in this workspace yet. Owners connect them under Providers.
          </RowBlock>
        ) : null}

        {!isListLoading && Boolean(models?.length) && visibleModels.length === 0 ? (
          <RowBlock className="text-sm text-muted-foreground">
            No models match your search.
          </RowBlock>
        ) : null}

        {isListLoading
          ? null
          : visibleModels.map((model) => {
              const name = modelDisplayName(model);
              const isPinned = pinnedModels.includes(model.slug);
              const isShown = !hiddenModels.includes(model.slug);
              const pinId = `model-pin-${model.slug}`;
              const showId = `model-show-${model.slug}`;

              return (
                <Row
                  key={model.slug}
                  leading={<ModelAuthorLogo author={model.author} />}
                  title={name}
                  description={<span className="font-mono text-[13px]">{model.slug}</span>}
                >
                  <div className="flex items-center gap-4">
                    <div className="flex items-center gap-2">
                      <Label htmlFor={pinId} className="text-xs font-normal text-muted-foreground">
                        Pin
                      </Label>
                      <Switch
                        id={pinId}
                        checked={isPinned}
                        disabled={isPreferencesLoading}
                        aria-label={`Pin ${name}`}
                        onCheckedChange={(checked) => void setModelPinned(model.slug, checked)}
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <Label htmlFor={showId} className="text-xs font-normal text-muted-foreground">
                        Show
                      </Label>
                      <Switch
                        id={showId}
                        checked={isShown}
                        disabled={isPreferencesLoading}
                        aria-label={`Show ${name} in model pickers`}
                        onCheckedChange={(checked) => void setModelHidden(model.slug, !checked)}
                      />
                    </div>
                  </div>
                </Row>
              );
            })}
      </GroupList>
    </>
  );
}
