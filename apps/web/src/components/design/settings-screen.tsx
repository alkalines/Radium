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
import { availableProviders, connectedProviders, demoWorkers } from "./demo-data";

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

const navGroups: { id: SettingsPageId; label: string; icon: LucideIcon }[][] = [
  [
    { id: "preferences", label: "Preferences", icon: SlidersHorizontalIcon },
    { id: "appearance", label: "Appearance", icon: PaletteIcon },
    { id: "shortcuts", label: "Shortcuts", icon: KeyboardIcon },
  ],
  [
    { id: "workspace", label: "Workspace", icon: BlocksIcon },
    { id: "members", label: "Members", icon: UsersIcon },
  ],
  [
    { id: "providers", label: "Providers", icon: CpuIcon },
    { id: "models", label: "Models", icon: BotIcon },
    { id: "api-keys", label: "API keys", icon: KeyRoundIcon },
    { id: "workers", label: "Workers", icon: ServerIcon },
  ],
  [{ id: "about", label: "About", icon: InfoIcon }],
];

/** Settings: 240px nav plus Group lists of Rows (`docs/Interface_Design.md` §5.2). Page switches are instant. */
export function SettingsScreen({ onBack }: { onBack: () => void }) {
  const [pageId, setPageId] = useState<SettingsPageId>("providers");
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLowerCase();

  return (
    <div className="mx-auto grid h-full w-full max-w-260 gap-8 overflow-y-auto px-4 pt-12 pb-8 md:grid-cols-[240px_minmax(0,1fr)] md:px-10">
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

        <InputGroup className="h-8 bg-transparent">
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

        {navGroups.map((group, groupIndex) => {
          const items = group.filter((item) => item.label.toLowerCase().includes(normalizedQuery));
          if (items.length === 0) return null;

          return (
            <ul key={groupIndex} className="flex flex-col gap-0.5">
              {items.map((item) => {
                const isActive = item.id === pageId;

                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      aria-current={isActive ? "page" : undefined}
                      onClick={() => setPageId(item.id)}
                      className={cn(
                        "flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-sm text-muted-foreground transition-colors outline-none hover:bg-accent/60 hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/30",
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
        })}
      </nav>

      <main className="flex max-w-178 min-w-0 flex-col gap-8">
        {pageId === "providers" ? <ProvidersPage /> : null}
        {pageId === "workers" ? <WorkersPage /> : null}
        {pageId === "appearance" ? <AppearancePage /> : null}
        {pageId !== "providers" && pageId !== "workers" && pageId !== "appearance" ? (
          <PageHeader
            title={navGroups.flat().find((item) => item.id === pageId)?.label ?? ""}
            description="Not part of the design reference. Providers, Workers, and Appearance show the patterns."
          />
        ) : null}
      </main>
    </div>
  );
}

function PageHeader({ title, description }: { title: string; description: string }) {
  return (
    <header className="flex flex-col gap-0.5">
      <h1 className="text-base font-medium">{title}</h1>
      <p className="text-sm text-muted-foreground">{description}</p>
    </header>
  );
}

/** Section heading followed by one Group list. Children are Rows. */
function GroupList({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-medium">{title}</h2>
      <ul className="flex flex-col rounded-lg bg-card px-4">{children}</ul>
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
      <DropdownMenuContent align="end">
        <DropdownMenuGroup>
          <DropdownMenuItem>Edit</DropdownMenuItem>
          <DropdownMenuItem variant="destructive">Disconnect</DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ProvidersPage() {
  return (
    <>
      <PageHeader
        title="Providers"
        description="Connect model providers, accounts, and endpoints for this workspace."
      />

      <GroupList title="Connected">
        {connectedProviders.map((provider) => (
          <Row key={provider.id} icon={CpuIcon} title={provider.name} tag={provider.credential}>
            <Button variant="ghost" size="xs" className="text-muted-foreground">
              {provider.account}
              <ChevronDownIcon data-icon="inline-end" />
            </Button>
            <RowMenu label={provider.name} />
          </Row>
        ))}
      </GroupList>

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
    </>
  );
}

function WorkersPage() {
  return (
    <>
      <PageHeader
        title="Workers"
        description="Machines that run files, folders, and commands for agents."
      />

      <GroupList title="Enrolled">
        {demoWorkers.map((worker) => (
          <Row
            key={worker.id}
            icon={ServerIcon}
            title={<span className="font-mono text-[13px]">{worker.name}</span>}
            tag={worker.kind}
            description={worker.host}
          >
            <AgentStatus
              state={worker.online ? "succeeded" : "idle"}
              label={worker.online ? "Online" : "Offline"}
            />
            <RowMenu label={worker.name} />
          </Row>
        ))}
      </GroupList>

      <Button variant="outline" size="sm" className="self-start">
        <PlusIcon data-icon="inline-start" />
        Enroll Worker
      </Button>
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
