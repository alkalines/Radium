import { useEffect, useRef, useState, type ReactNode } from "react";
import { convexQuery } from "@convex-dev/react-query";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { RouteIcon } from "lucide-react";
import { toast } from "sonner";

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
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from "@/components/ui/input-group";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useWorkspace } from "@/components/workspaces/workspace-provider";
import { api } from "backend/convex/_generated/api";
import type { Id } from "backend/convex/_generated/dataModel";
import {
  ROUTING_LIMITS,
  type CooldownReason,
  type RoutingSettings,
  type RoutingStrategy,
} from "backend/src/routing/settings";
import { ProviderLogo } from "./provider-logo";
import {
  ProviderRoutingDialog,
  parseInteger,
  type RoutingProvider,
} from "./provider-routing-dialog";

type Cooldown = FunctionReturnType<typeof api.routing.getConfiguration>["cooldowns"][number];

type Option<T extends string> = { value: T; label: string; description: string };

const strategyOptions: Array<Option<RoutingStrategy>> = [
  {
    value: "round-robin",
    label: "Round robin",
    description: "Rotates through providers for each model.",
  },
  {
    value: "weighted-round-robin",
    label: "Weighted round robin",
    description: "Rotates through providers in proportion to their weights.",
  },
  {
    value: "fill-first",
    label: "Fill first",
    description: "Uses the first provider until it is blocked, then the next.",
  },
];

const rebindOptions: Array<Option<RoutingSettings["sessionAffinityRebindOn"]>> = [
  {
    value: "any",
    label: "Any failure",
    description: "Moves the conversation after every provider failure.",
  },
  {
    value: "quota",
    label: "Quota errors",
    description: "Keeps the binding through transient errors.",
  },
];

const reasonLabels: Record<CooldownReason, string> = {
  quota: "Quota",
  unauthorized: "Unauthorized",
  payment_required: "Payment required",
  not_found: "Not found",
  model_unsupported: "Model unsupported",
  transient: "Transient error",
  other: "Error",
};

/**
 * Gateway routing for the current workspace (owner-only; the route gates members): the
 * workspace strategy, session affinity, retry, and cooling settings, each provider's routing
 * overrides, and the credentials currently cooling down. The strategy picks a provider, then
 * requests rotate across that provider's enabled credentials. Semantics follow CLIProxyAPI
 * (`packages/backend/src/routing/settings.ts`).
 */
export function RoutingPanel() {
  const { workspaceId } = useWorkspace();
  const { data: configuration, error } = useQuery(
    convexQuery(api.routing.getConfiguration, workspaceId ? { workspace: workspaceId } : "skip"),
  );
  const resetCooldown = useMutation(api.routing.resetCooldown);
  const now = useCooldownClock(configuration?.cooldowns);
  const [editingSlug, setEditingSlug] = useState<string | null>(null);
  const [resetting, setResetting] = useState<string | null>(null);

  // Resolve the dialog target from live query data so it closes if the provider goes away.
  const editing =
    configuration?.providers.find((provider) => provider.slug === editingSlug) ?? null;

  /** Clears one cooldown row, or every cooldown of the provider when `cooldown` is omitted. */
  async function reset(provider: string, cooldown?: Id<"routing_cooldowns">) {
    if (!workspaceId) return;
    setResetting(cooldown ?? provider);
    try {
      await resetCooldown({ workspace: workspaceId, provider, cooldown });
    } catch (resetError) {
      toast.error(resetError instanceof Error ? resetError.message : "Failed to reset cooldown.");
    } finally {
      setResetting(null);
    }
  }

  return (
    <>
      <WorkspacePageHeader
        title="Routing"
        description="How the Gateway spreads requests across providers and their credentials, retries failures, and cools down failing credentials."
      />

      {error ? (
        <Alert variant="destructive">
          <AlertTitle>Could not load routing</AlertTitle>
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      ) : !workspaceId || configuration === undefined ? (
        <GroupList title="Strategy">
          {[0, 1].map((placeholder) => (
            <RowBlock key={placeholder}>
              <Skeleton className="h-6" />
            </RowBlock>
          ))}
        </GroupList>
      ) : (
        <>
          <RoutingSettingsForm
            key={workspaceId}
            workspaceId={workspaceId}
            settings={configuration.settings}
          />
          <ProviderList
            providers={configuration.providers}
            cooldowns={configuration.cooldowns}
            now={now}
            strategy={configuration.settings.strategy}
            resetting={resetting}
            onEdit={setEditingSlug}
            onReset={(provider) => void reset(provider)}
          />
          {configuration.providers.length > 0 ? (
            <CooldownList
              providers={configuration.providers}
              cooldowns={configuration.cooldowns}
              now={now}
              resetting={resetting}
              onReset={(cooldown) => void reset(cooldown.provider, cooldown._id)}
            />
          ) : null}
        </>
      )}

      <ProviderRoutingDialog
        provider={editing}
        strategy={configuration?.settings.strategy ?? "round-robin"}
        workspaceCoolingDisabled={configuration?.settings.disableCooling ?? false}
        workspaceId={workspaceId}
        onOpenChange={(open) => !open && setEditingSlug(null)}
      />
    </>
  );
}

/**
 * Workspace routing settings. Every control commits on its own (switches and selects on change,
 * numbers on blur or Enter), and each save replaces the whole settings object.
 */
function RoutingSettingsForm({
  workspaceId,
  settings,
}: {
  workspaceId: Id<"workspaces">;
  settings: RoutingSettings;
}) {
  const saveSettings = useMutation(api.routing.setSettings);
  // Saves replace the whole object, so an edit made while an earlier save is in flight builds on
  // that save instead of on the query result it has not updated yet.
  const [pending, setPending] = useState<RoutingSettings | null>(null);
  const pendingRef = useRef<RoutingSettings | null>(null);
  const savesInFlight = useRef(0);
  const view = pending ?? settings;

  const strategy = strategyOptions.find((option) => option.value === view.strategy);
  const rebind = rebindOptions.find((option) => option.value === view.sessionAffinityRebindOn);

  async function update(patch: Partial<RoutingSettings>) {
    const next = { ...(pendingRef.current ?? settings), ...patch };
    pendingRef.current = next;
    setPending(next);
    savesInFlight.current += 1;
    try {
      await saveSettings({ workspace: workspaceId, settings: next });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to update routing settings.");
      pendingRef.current = null;
      setPending(null);
    } finally {
      savesInFlight.current -= 1;
      if (savesInFlight.current === 0) {
        pendingRef.current = null;
        setPending(null);
      }
    }
  }

  return (
    <>
      <GroupList
        title="Strategy"
        description="Higher-priority providers are always tried first; the strategy picks among providers with the same priority."
      >
        <Row title="Strategy" description={strategy?.description}>
          <OptionSelect
            label="Strategy"
            value={view.strategy}
            options={strategyOptions}
            onChange={(value) => void update({ strategy: value })}
          />
        </Row>
      </GroupList>

      <GroupList
        title="Session affinity"
        description="Keeps a conversation on the provider that first served it so prompt caches stay warm."
      >
        <Row title="Session affinity" description="Bind each conversation to one provider.">
          <Switch
            aria-label="Session affinity"
            checked={view.sessionAffinity}
            onCheckedChange={(sessionAffinity) => void update({ sessionAffinity })}
          />
        </Row>
        <SettingRow
          title="Binding lifetime"
          description="Renewed by every request in the conversation."
          disabled={!view.sessionAffinity}
        >
          <IntegerInput
            label="Binding lifetime"
            unit="s"
            value={view.sessionAffinityTtlSeconds}
            min={1}
            max={ROUTING_LIMITS.maxSessionAffinityTtlSeconds}
            disabled={!view.sessionAffinity}
            onCommit={(sessionAffinityTtlSeconds) => void update({ sessionAffinityTtlSeconds })}
          />
        </SettingRow>
        <SettingRow
          title="Subagents inherit"
          description="Child sessions use their parent's provider."
          disabled={!view.sessionAffinity}
        >
          <Switch
            aria-label="Subagents inherit"
            checked={view.sessionAffinitySubagents}
            disabled={!view.sessionAffinity}
            onCheckedChange={(sessionAffinitySubagents) =>
              void update({ sessionAffinitySubagents })
            }
          />
        </SettingRow>
        <SettingRow
          title="Rebind on"
          description={rebind?.description}
          disabled={!view.sessionAffinity}
        >
          <OptionSelect
            label="Rebind on"
            value={view.sessionAffinityRebindOn}
            options={rebindOptions}
            disabled={!view.sessionAffinity}
            onChange={(sessionAffinityRebindOn) => void update({ sessionAffinityRebindOn })}
          />
        </SettingRow>
      </GroupList>

      <GroupList
        title="Retries"
        description="When every provider in a round fails, the Gateway waits for the next cooldown to end and tries another round."
      >
        <Row title="Retry rounds" description="Extra rounds after the first one fails.">
          <IntegerInput
            label="Retry rounds"
            value={view.requestRetry}
            min={0}
            max={ROUTING_LIMITS.maxRequestRetry}
            onCommit={(requestRetry) => void update({ requestRetry })}
          />
        </Row>
        <Row title="Providers per round" description="0 tries every eligible provider.">
          <IntegerInput
            label="Providers per round"
            value={view.maxRetryCredentials}
            min={0}
            max={ROUTING_LIMITS.maxRetryCredentials}
            onCommit={(maxRetryCredentials) => void update({ maxRetryCredentials })}
          />
        </Row>
        <Row title="Max cooldown wait" description="Longest wait between rounds. 0 never waits.">
          <IntegerInput
            label="Max cooldown wait"
            unit="s"
            value={view.maxRetryIntervalSeconds}
            min={0}
            max={ROUTING_LIMITS.maxRetryIntervalSeconds}
            onCommit={(maxRetryIntervalSeconds) => void update({ maxRetryIntervalSeconds })}
          />
        </Row>
      </GroupList>

      <GroupList
        title="Cooling"
        description="A failing provider leaves rotation for a while; repeated failures keep it out longer."
      >
        <Row title="Disable cooling" description="Keep every provider in rotation after failures.">
          <Switch
            aria-label="Disable cooling"
            checked={view.disableCooling}
            onCheckedChange={(disableCooling) => void update({ disableCooling })}
          />
        </Row>
        <SettingRow
          title="Transient error cooldown"
          description="After 408 and 5xx errors. 0 uses 60 s; -1 turns it off."
          disabled={view.disableCooling}
        >
          <IntegerInput
            label="Transient error cooldown"
            unit="s"
            value={view.transientErrorCooldownSeconds}
            min={-1}
            max={ROUTING_LIMITS.maxTransientErrorCooldownSeconds}
            disabled={view.disableCooling}
            onCommit={(transientErrorCooldownSeconds) =>
              void update({ transientErrorCooldownSeconds })
            }
          />
        </SettingRow>
      </GroupList>
    </>
  );
}

/** Providers in the order routing tries them: priority tiers, highest first. */
function ProviderList({
  providers,
  cooldowns,
  now,
  strategy,
  resetting,
  onEdit,
  onReset,
}: {
  providers: RoutingProvider[];
  cooldowns: Cooldown[];
  now: number;
  strategy: RoutingStrategy;
  resetting: string | null;
  onEdit: (slug: string) => void;
  onReset: (provider: string) => void;
}) {
  if (providers.length === 0) {
    return (
      <Empty className="border border-dashed">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <RouteIcon />
          </EmptyMedia>
          <EmptyTitle>No providers to route</EmptyTitle>
          <EmptyDescription>
            Add a provider to set its priority, weight, cooling, and error rules.
          </EmptyDescription>
        </EmptyHeader>
        <Button asChild>
          <Link to="/gateway/$section" params={{ section: "providers" }}>
            Open Providers
          </Link>
        </Button>
      </Empty>
    );
  }

  const ordered = [...providers].sort((a, b) => b.routing.priority - a.routing.priority);

  return (
    <GroupList
      title="Providers"
      description="Higher priority is tried first; lower tiers serve only when every higher provider is blocked."
    >
      {ordered.map((provider) => {
        const active = activeCooldowns(cooldowns, now).filter(
          (cooldown) => cooldown.provider === provider.slug,
        );
        const details = providerDetails(provider, strategy, active, now);

        return (
          <Row
            key={provider.slug}
            data-disabled={!provider.enabled}
            className="data-[disabled=true]:opacity-60"
            leading={<ProviderLogo slug={provider.slug} className="size-8" />}
            title={provider.name}
            tag={providerTag(provider)}
            description={
              <span title={details.join(" · ")}>
                <span className="font-mono text-xs">{provider.slug}</span>
                <span className="tabular-nums"> · {details.join(" · ")}</span>
              </span>
            }
          >
            {active.length > 0 ? (
              <Button
                variant="ghost"
                size="sm"
                disabled={resetting !== null}
                onClick={() => onReset(provider.slug)}
                aria-label={`Reset every cooldown for ${provider.name}`}
              >
                Reset cooldown
              </Button>
            ) : null}
            <Button variant="outline" size="sm" onClick={() => onEdit(provider.slug)}>
              Edit
            </Button>
          </Row>
        );
      })}
    </GroupList>
  );
}

/**
 * Active cooldowns, soonest to end first. Cooldowns are per credential, optionally per model;
 * each Reset clears that one row.
 */
function CooldownList({
  providers,
  cooldowns,
  now,
  resetting,
  onReset,
}: {
  providers: RoutingProvider[];
  cooldowns: Cooldown[];
  now: number;
  resetting: string | null;
  onReset: (cooldown: Cooldown) => void;
}) {
  const active = activeCooldowns(cooldowns, now).sort((a, b) => a.nextRetryAt - b.nextRetryAt);

  return (
    <GroupList
      title="Active cooldowns"
      description="Credentials resting after failures; the provider's other credentials keep serving. Reset returns one to rotation now."
    >
      {active.length === 0 ? (
        <RowBlock>
          <p className="text-sm text-muted-foreground">No credentials are cooling down.</p>
        </RowBlock>
      ) : (
        active.map((cooldown) => {
          const provider = providers.find((entry) => entry.slug === cooldown.provider);
          const providerName = provider?.name ?? cooldown.provider;
          const subject = cooldown.credentialName
            ? `${providerName} · ${cooldown.credentialName}`
            : providerName;

          return (
            <Row
              key={cooldown._id}
              leading={<ProviderLogo slug={cooldown.provider} className="size-8" />}
              title={
                <span title={subject}>
                  {providerName}
                  {cooldown.credentialName ? (
                    <span className="font-normal text-muted-foreground">
                      {" "}
                      · {cooldown.credentialName}
                    </span>
                  ) : null}
                </span>
              }
              tag={reasonLabels[cooldown.reason]}
              description={
                <span title={cooldown.message}>
                  {cooldown.model ? (
                    <span className="font-mono text-xs">{cooldown.model}</span>
                  ) : (
                    "All models"
                  )}
                  {cooldown.status !== undefined ? (
                    <span className="tabular-nums"> · {cooldown.status}</span>
                  ) : null}
                  <span className="tabular-nums">
                    {" "}
                    · {formatRemaining(cooldown.nextRetryAt - now)} left
                  </span>
                  {cooldown.message ? ` · ${cooldown.message}` : null}
                </span>
              }
            >
              <Button
                variant="outline"
                size="sm"
                disabled={resetting !== null}
                onClick={() => onReset(cooldown)}
                aria-label={`Reset cooldown for ${subject}${cooldown.model ? ` ${cooldown.model}` : ""}`}
              >
                Reset
              </Button>
            </Row>
          );
        })
      )}
    </GroupList>
  );
}

/** Row whose control depends on another setting; dims while that setting is off. */
function SettingRow({
  title,
  description,
  disabled,
  children,
}: {
  title: string;
  description?: string;
  disabled: boolean;
  children: ReactNode;
}) {
  return (
    <Row
      title={title}
      description={description}
      data-disabled={disabled}
      className="data-[disabled=true]:opacity-60"
    >
      {children}
    </Row>
  );
}

function OptionSelect<T extends string>({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  value: T;
  options: Array<Option<T>>;
  disabled?: boolean;
  onChange: (value: T) => void;
}) {
  return (
    <Select
      value={value}
      disabled={disabled}
      onValueChange={(next) => {
        const option = options.find((entry) => entry.value === next);
        if (option) onChange(option.value);
      }}
    >
      <SelectTrigger size="sm" aria-label={label} className="w-auto min-w-32">
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="end">
        <SelectGroup>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

/**
 * Whole-number field that commits on blur or Enter; Escape restores the saved value. Out-of-range
 * input is refused with a message instead of being clamped, matching the backend.
 */
function IntegerInput({
  label,
  unit,
  value,
  min,
  max,
  disabled,
  onCommit,
}: {
  label: string;
  unit?: string;
  value: number;
  min: number;
  max: number;
  disabled?: boolean;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));

  // Follow the saved value (another tab's change, or a rejected save rolling back).
  useEffect(() => setDraft(String(value)), [value]);

  const invalid = parseInteger(draft, min, max) === undefined;

  function commit() {
    const parsed = parseInteger(draft, min, max);
    if (parsed === undefined) {
      toast.error(`${label} must be a whole number from ${min} to ${max}.`);
      setDraft(String(value));
      return;
    }

    if (parsed !== value) onCommit(parsed);
  }

  return (
    <InputGroup className="w-28">
      <InputGroupInput
        aria-label={label}
        aria-invalid={invalid}
        inputMode="numeric"
        className="text-right tabular-nums"
        value={draft}
        disabled={disabled}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") setDraft(String(value));
        }}
      />
      {unit ? (
        <InputGroupAddon align="inline-end">
          <InputGroupText>{unit}</InputGroupText>
        </InputGroupAddon>
      ) : null}
    </InputGroup>
  );
}

/**
 * `Date.now()` that ticks every second until the latest cooldown ends, so countdowns update and
 * expired cooldowns drop out. Cooldown rows outlive their expiry (they carry the backoff level),
 * so only the clock decides what is active. `0` until mounted, which shows no cooldowns.
 */
function useCooldownClock(cooldowns: Cooldown[] | undefined): number {
  const [now, setNow] = useState(0);
  const latestRetryAt =
    cooldowns?.reduce((latest, cooldown) => Math.max(latest, cooldown.nextRetryAt), 0) ?? 0;

  useEffect(() => {
    setNow(Date.now());
    if (latestRetryAt <= Date.now()) return;

    const interval = window.setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (current >= latestRetryAt) window.clearInterval(interval);
    }, 1000);
    return () => window.clearInterval(interval);
  }, [latestRetryAt]);

  return now;
}

function activeCooldowns(cooldowns: Cooldown[], now: number): Cooldown[] {
  if (now === 0) return [];
  return cooldowns.filter((cooldown) => cooldown.nextRetryAt > now);
}

function providerTag(provider: RoutingProvider) {
  if (!provider.enabled) return "Disabled";
  if (!provider.credentials.some((credential) => credential.enabled)) return "No credentials";
  return undefined;
}

/** Second-line summary of a provider's routing: priority, weight, credentials, overrides, and cooling. */
function providerDetails(
  provider: RoutingProvider,
  strategy: RoutingStrategy,
  active: Cooldown[],
  now: number,
): string[] {
  const { routing } = provider;
  const details = [`Priority ${routing.priority}`];

  if (strategy === "weighted-round-robin") details.push(`Weight ${routing.weight}`);

  const enabledCredentials = provider.credentials.filter((credential) => credential.enabled);
  if (enabledCredentials.length > 1) details.push(`${enabledCredentials.length} credentials`);

  const ruleCount = routing.errorRules.length;
  if (ruleCount > 0) details.push(`${ruleCount} error ${ruleCount === 1 ? "rule" : "rules"}`);

  if (routing.disableCooling) details.push("Cooling disabled");
  else if (routing.modelLevelCooling) details.push("Model-level cooling");

  // `model === ""` blocks every model of one credential; other rows block one model of one.
  const credentialWide = active.filter((cooldown) => cooldown.model === "");
  const blockedCredentials = new Set(
    credentialWide.map((cooldown) => cooldown.credential ?? "legacy"),
  );
  const blockedModels = new Set(
    active.filter((cooldown) => cooldown.model !== "").map((cooldown) => cooldown.model),
  );

  // Without listed credentials (a legacy one), any credential-wide cooldown blocks the provider.
  const allBlocked =
    blockedCredentials.size > 0 &&
    (enabledCredentials.length === 0 ||
      enabledCredentials.every((credential) => blockedCredentials.has(credential._id)));
  if (allBlocked) {
    // Every enabled credential rests, so the provider serves again when the first one returns.
    const nextRetryAt = Math.min(...credentialWide.map((cooldown) => cooldown.nextRetryAt));
    details.push(`Cooling down, ${formatRemaining(nextRetryAt - now)} left`);
  } else if (blockedCredentials.size > 0) {
    const count = blockedCredentials.size;
    details.push(`${count} ${count === 1 ? "credential" : "credentials"} cooling down`);
  }

  if (blockedModels.size > 0) {
    const count = blockedModels.size;
    details.push(`${count} ${count === 1 ? "model" : "models"} cooling down`);
  }

  return details;
}

function formatRemaining(ms: number): string {
  const totalSeconds = Math.max(1, Math.ceil(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;

  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes}m ${String(totalSeconds % 60).padStart(2, "0")}s`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;

  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}
