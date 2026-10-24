import { type ReactNode, useState } from "react";
import type { LucideIcon } from "lucide-react";
import {
  ArrowLeftIcon,
  BlocksIcon,
  BotIcon,
  ChevronDownIcon,
  CpuIcon,
  InfoIcon,
  KeyRoundIcon,
  KeyboardIcon,
  MoreHorizontalIcon,
  PaletteIcon,
  PlusIcon,
  SearchIcon,
  ServerIcon,
  SlidersHorizontalIcon,
  UsersIcon,
} from "lucide-react";
import { useTheme } from "next-themes";

import { AgentStatus } from "@/components/agentic/agent-status";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import {
  availableProviders,
  connectedProviders,
  demoAgents,
  demoWorkers,
  type DemoWorkspace,
} from "./demo-data";
import { ProjectTile } from "./project-tile";
import { WorkspaceSwitcher } from "./workspace-switcher";

type SettingsPageId =
  | "preferences"
  | "appearance"
  | "shortcuts"
  | "workspace"
  | "members"
  | "providers"
  | "models"
  | "api-keys"
  | "workers"
  | "about";

type NavItem = { id: SettingsPageId; label: string; icon: LucideIcon };

// Account pages follow the signed-in user everywhere; workspace pages apply only to the workspace
// selected in the sidebar, so they are listed under its switcher.
const accountItems: NavItem[] = [
  { id: "preferences", label: "Preferences", icon: SlidersHorizontalIcon },
  { id: "appearance", label: "Appearance", icon: PaletteIcon },
  { id: "shortcuts", label: "Shortcuts", icon: KeyboardIcon },
];

const workspaceItems: NavItem[] = [
  { id: "workspace", label: "General", icon: BlocksIcon },
  { id: "members", label: "Members", icon: UsersIcon },
  { id: "providers", label: "Providers", icon: CpuIcon },
  { id: "models", label: "Models", icon: BotIcon },
  { id: "api-keys", label: "API keys", icon: KeyRoundIcon },
  { id: "workers", label: "Workers", icon: ServerIcon },
];

const aboutItem: NavItem = { id: "about", label: "About", icon: InfoIcon };

/**
 * Settings (`docs/Interface_Design.md` §5.2): a 240px sidebar split into Account and the current
 * workspace, plus Group lists shaped like the Composer. Workspace pages name their workspace and
 * become read-only for members. Page switches are instant.
 */
export function SettingsScreen({
  workspace,
  onWorkspaceChange,
  onBack,
}: {
  workspace: DemoWorkspace;
  onWorkspaceChange: (workspace: DemoWorkspace) => void;
  onBack: () => void;
}) {
  const [pageId, setPageId] = useState<SettingsPageId>("providers");
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLowerCase();
  const canManage = workspace.role === "Owner";

  function matching(items: NavItem[]) {
    return items.filter((item) => item.label.toLowerCase().includes(normalizedQuery));
  }

  const isWorkspacePage = workspaceItems.some((item) => item.id === pageId);
  const pageLabel = [...accountItems, ...workspaceItems, aboutItem].find(
    (item) => item.id === pageId,
  )?.label;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto grid w-full max-w-260 gap-8 px-4 pt-12 pb-8 md:grid-cols-[240px_minmax(0,1fr)] md:px-10">
        <nav aria-label="Settings" className="flex flex-col gap-4">
          <Button
            variant="ghost"
            size="sm"
            className="justify-start text-muted-foreground"
            onClick={onBack}
          >
            <ArrowLeftIcon data-icon="inline-start" />
            Back to app
          </Button>

          <InputGroup className="h-8 rounded-xl border-border bg-card">
            <InputGroupAddon>
              <SearchIcon />
            </InputGroupAddon>
            <InputGroupInput
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search"
              aria-label="Search settings"
            />
          </InputGroup>

          <NavSection title="Account">
            <NavList items={matching(accountItems)} pageId={pageId} onSelect={setPageId} />
          </NavSection>

          <NavSection
            title={
              <WorkspaceSwitcher
                variant="heading"
                workspace={workspace}
                onWorkspaceChange={onWorkspaceChange}
              />
            }
          >
            <NavList items={matching(workspaceItems)} pageId={pageId} onSelect={setPageId} />
          </NavSection>

          <NavList items={matching([aboutItem])} pageId={pageId} onSelect={setPageId} />
        </nav>

        <div className="flex max-w-190 min-w-0 flex-col gap-8">
          {pageId === "providers" ? (
            <ProvidersPage workspace={workspace} canManage={canManage} />
          ) : null}
          {pageId === "workers" ? (
            <WorkersPage workspace={workspace} canManage={canManage} />
          ) : null}
          {pageId === "appearance" ? <AppearancePage /> : null}
          {pageId !== "providers" && pageId !== "workers" && pageId !== "appearance" ? (
            <PageHeader
              title={pageLabel ?? ""}
              workspace={isWorkspacePage ? workspace : undefined}
              description="Not part of the design reference. Providers, Workers, and Appearance show the patterns."
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

function NavSection({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex h-7 min-w-0 items-center px-3 text-sm text-subtle-foreground">
        {title}
      </div>
      {children}
    </div>
  );
}

function NavList({
  items,
  pageId,
  onSelect,
}: {
  items: NavItem[];
  pageId: SettingsPageId;
  onSelect: (id: SettingsPageId) => void;
}) {
  if (items.length === 0) return null;

  return (
    <ul className="flex flex-col gap-0.5">
      {items.map((item) => {
        const isActive = item.id === pageId;

        return (
          <li key={item.id}>
            <button
              type="button"
              aria-current={isActive ? "page" : undefined}
              onClick={() => onSelect(item.id)}
              className={cn(
                "flex h-8 w-full items-center gap-2.5 rounded-xl px-3 text-sm text-muted-foreground transition-colors outline-none hover:bg-accent/60 hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/30",
                isActive && "bg-accent text-foreground hover:bg-accent",
              )}
            >
              <item.icon className="size-4" />
              {item.label}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** Screen title. Workspace pages prefix it with the workspace so the scope is never ambiguous. */
function PageHeader({
  title,
  description,
  workspace,
}: {
  title: string;
  description: string;
  workspace?: DemoWorkspace;
}) {
  return (
    <header className="flex flex-col gap-0.5 px-4">
      <h1 className="flex min-w-0 items-center gap-1.5 text-base font-medium">
        {workspace ? (
          <>
            <ProjectTile initial={workspace.initial} />
            <span className="truncate text-muted-foreground">{workspace.name}</span>
            <span className="text-subtle-foreground">/</span>
          </>
        ) : null}
        <span className="truncate">{title}</span>
      </h1>
      <p className="text-sm text-muted-foreground">{description}</p>
    </header>
  );
}

/** Section heading followed by one Group list. Children are Rows. */
function GroupList({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="px-4 text-sm font-medium">{title}</h2>
      <ul className="flex flex-col rounded-2xl border bg-card px-4">{children}</ul>
    </section>
  );
}

function Row({
  icon: Icon,
  title,
  tag,
  description,
  children,
}: {
  icon?: LucideIcon;
  title: ReactNode;
  tag?: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <li className="flex min-h-12 items-center gap-3 border-b py-2.5 last:border-b-0">
      {Icon ? <Icon className="size-4 shrink-0 text-muted-foreground" /> : null}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium">{title}</span>
          {tag ? <Tag>{tag}</Tag> : null}
        </div>
        {description ? (
          <p className="truncate text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {children ? <div className="flex shrink-0 items-center gap-1">{children}</div> : null}
    </li>
  );
}

function Tag({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex h-4 shrink-0 items-center rounded-[2px] border bg-tag px-1 text-[11px] leading-none font-medium text-muted-foreground">
      {children}
    </span>
  );
}

function RowMenu({ label }: { label: string }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-xs" aria-label={`${label} actions`}>
          <MoreHorizontalIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent data-design="harness" align="end">
        <DropdownMenuGroup>
          <DropdownMenuItem>Edit</DropdownMenuItem>
          <DropdownMenuItem variant="destructive">Disconnect</DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// Members use what owners configure but cannot change it (AGENTS.md, workspace ownership), so
// workspace pages keep their content visible and drop the controls.
const memberNotice = "Only workspace owners can change this. You can use what they configure.";

function ProvidersPage({ workspace, canManage }: { workspace: DemoWorkspace; canManage: boolean }) {
  return (
    <>
      <PageHeader
        title="Providers"
        workspace={workspace}
        description={
          canManage
            ? "Connect model providers, accounts, and endpoints for this workspace."
            : memberNotice
        }
      />

      <GroupList title="Connected">
        {connectedProviders.map((provider) => (
          <Row key={provider.id} icon={CpuIcon} title={provider.name} tag={provider.credential}>
            {canManage ? (
              <>
                <Button variant="ghost" size="xs" className="text-muted-foreground">
                  {provider.account}
                  <ChevronDownIcon data-icon="inline-end" />
                </Button>
                <RowMenu label={provider.name} />
              </>
            ) : (
              <span className="px-2 text-xs text-muted-foreground">{provider.account}</span>
            )}
          </Row>
        ))}
      </GroupList>

      {canManage ? (
        <GroupList title="Available">
          {availableProviders.map((provider) => (
            <Row
              key={provider.id}
              icon={CpuIcon}
              title={provider.name}
              description={provider.description}
            >
              <Button variant="outline" size="sm">
                <PlusIcon data-icon="inline-start" />
                Connect
              </Button>
            </Row>
          ))}
        </GroupList>
      ) : null}
    </>
  );
}

function WorkersPage({ workspace, canManage }: { workspace: DemoWorkspace; canManage: boolean }) {
  return (
    <>
      <PageHeader
        title="Workers"
        workspace={workspace}
        description={
          canManage ? "Machines that run files, folders, and commands for agents." : memberNotice
        }
      />

      <GroupList title="Enrolled">
        {demoWorkers.map((worker) => {
          const agentNames = demoAgents
            .filter((agent) => worker.acpAgents.includes(agent.id))
            .map((agent) => agent.name);
          const description =
            agentNames.length > 0
              ? `Runs as ${worker.username} · ACP: ${agentNames.join(", ")}`
              : `Runs as ${worker.username}`;

          return (
            <Row key={worker.id} icon={ServerIcon} title={worker.name} description={description}>
              <AgentStatus
                state={worker.online ? "succeeded" : "idle"}
                label={worker.online ? "Online" : "Offline"}
              />
              {canManage ? <RowMenu label={worker.name} /> : null}
            </Row>
          );
        })}
      </GroupList>

      {canManage ? (
        <Button variant="outline" size="sm" className="self-start">
          <PlusIcon data-icon="inline-start" />
          Enroll Worker
        </Button>
      ) : null}
    </>
  );
}

function AppearancePage() {
  const { theme = "system", setTheme } = useTheme();

  return (
    <>
      <PageHeader title="Appearance" description="How Radium looks on this device." />

      <GroupList title="Theme">
        <Row title="Color scheme" description="Follow the system, or pin light or dark.">
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            value={theme}
            onValueChange={(value) => {
              if (value) setTheme(value);
            }}
          >
            <ToggleGroupItem value="system">System</ToggleGroupItem>
            <ToggleGroupItem value="light">Light</ToggleGroupItem>
            <ToggleGroupItem value="dark">Dark</ToggleGroupItem>
          </ToggleGroup>
        </Row>
        <Row title="Compact lists" description="Use 13px text and tighter rows in long lists.">
          <Switch aria-label="Compact lists" />
        </Row>
      </GroupList>
    </>
  );
}
