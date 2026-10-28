import { useEffect, useMemo, useState } from "react";
import { convexQuery } from "@convex-dev/react-query";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useAction, useMutation } from "convex/react";
import { GaugeIcon, RefreshCwIcon } from "lucide-react";
import { toast } from "sonner";

import { GroupList, Row, RowBlock, Tag } from "@/components/harness/group-list";
import { WorkspacePageHeader } from "@/components/settings/workspace-page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
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
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { useWorkspace } from "@/components/workspaces/workspace-provider";
import { cn } from "@/lib/utils";
import { api } from "backend/convex/_generated/api";
import type { Id } from "backend/convex/_generated/dataModel";
import {
  MeterBar,
  RelativeTime,
  formatMeterAmounts,
  formatMeterHeadline,
  formatPlan,
  formatPollError,
  formatResetsIn,
  formatUsd,
  formatUpdated,
  levelText,
  meterLevel,
  useLimitsClock,
  type BudgetPeriod,
  type CredentialLimits,
  type LimitEvent,
  type LimitSettings,
} from "./limit-meters";
import { ProviderLogo } from "./provider-logo";

type ProviderGroup = { slug: string; name: string; credentials: CredentialLimits[] };

const eventKinds: Record<
  LimitEvent["kind"],
  { label: string; variant: "secondary" | "destructive" | "outline" }
> = {
  limit_low: { label: "Low", variant: "secondary" },
  limit_critical: { label: "Critical", variant: "destructive" },
  limit_exhausted: { label: "Exhausted", variant: "destructive" },
  limit_reset: { label: "Reset", variant: "outline" },
  credential_expired: { label: "Key expired", variant: "destructive" },
  credential_restored: { label: "Restored", variant: "outline" },
  poll_failed: { label: "Poll failed", variant: "secondary" },
};

const budgetPeriodLabels: Record<BudgetPeriod, string> = {
  day: "day",
  week: "week",
  month: "month",
};

/**
 * Usage limits for the current workspace (owner-only; the route gates members): every pooled
 * credential grouped by provider with all of its meters, poll state, and a Refresh for providers
 * with a usage endpoint; the workspace thresholds; and the recent limit events. Limits are for
 * display and alerts only and never change routing (`docs/research/Gateway_Usage_Limits.md`).
 */
export function LimitsPanel() {
  const { workspaceId } = useWorkspace();
  const args = workspaceId ? { workspace: workspaceId } : "skip";
  const { data: limits, error } = useQuery(convexQuery(api.limits.list, args));
  const { data: settings, error: settingsError } = useQuery(
    convexQuery(api.limits.getSettings, args),
  );
  const { data: events } = useQuery(convexQuery(api.limits.listEvents, args));

  // `limits.list` is in provider order, then creation order; grouping keeps both.
  const groups = useMemo(() => {
    const byProvider = new Map<string, ProviderGroup>();
    for (const credential of limits ?? []) {
      const group = byProvider.get(credential.provider);
      if (group) group.credentials.push(credential);
      else {
        byProvider.set(credential.provider, {
          slug: credential.provider,
          name: credential.providerName,
          credentials: [credential],
        });
      }
    }
    return [...byProvider.values()];
  }, [limits]);

  const loadError = error ?? settingsError;

  return (
    <>
      <WorkspacePageHeader
        title="Limits"
        description="Usage limits and balances for each credential, from provider responses, usage polls, and budgets you set. Limits are shown for awareness and never change routing."
      />

      {loadError ? (
        <Alert variant="destructive">
          <AlertTitle>Could not load limits</AlertTitle>
          <AlertDescription>{loadError.message}</AlertDescription>
        </Alert>
      ) : !workspaceId || limits === undefined || settings === undefined ? (
        <GroupList title="Credentials">
          {[0, 1].map((placeholder) => (
            <RowBlock key={placeholder}>
              <Skeleton className="h-6" />
            </RowBlock>
          ))}
        </GroupList>
      ) : (
        <>
          {groups.length === 0 ? (
            <Empty className="border border-dashed">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <GaugeIcon />
                </EmptyMedia>
                <EmptyTitle>No credentials to track</EmptyTitle>
                <EmptyDescription>
                  Add an API key or connect an account; its limits, balances, and budgets show here.
                </EmptyDescription>
              </EmptyHeader>
              <Button asChild>
                <Link to="/gateway/$section" params={{ section: "credentials" }}>
                  Open Credentials
                </Link>
              </Button>
            </Empty>
          ) : (
            groups.map((group) => (
              <GroupList
                key={group.slug}
                title={
                  <span className="flex min-w-0 items-center gap-2">
                    <ProviderLogo slug={group.slug} className="size-5" />
                    <span className="truncate">{group.name}</span>
                  </span>
                }
              >
                {group.credentials.map((credential) => (
                  <CredentialLimitsBlock
                    key={credential.credential}
                    workspaceId={workspaceId}
                    limits={credential}
                    settings={settings}
                  />
                ))}
              </GroupList>
            ))
          )}

          <ThresholdsForm key={workspaceId} workspaceId={workspaceId} settings={settings} />

          <EventList events={events} />
        </>
      )}
    </>
  );
}

/** One credential: name, plan, poll state, Refresh, then every meter. */
function CredentialLimitsBlock({
  workspaceId,
  limits,
  settings,
}: {
  workspaceId: Id<"workspaces">;
  limits: CredentialLimits;
  settings: LimitSettings;
}) {
  return (
    <RowBlock data-disabled={!limits.enabled} className="data-[disabled=true]:opacity-60">
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-medium" title={limits.credentialName}>
              {limits.credentialName}
            </span>
            {limits.plan ? <Tag>{formatPlan(limits.plan)}</Tag> : null}
            {!limits.enabled ? <Tag>Disabled</Tag> : null}
          </div>
          <PollStatus limits={limits} />
        </div>
        <RefreshButton workspaceId={workspaceId} limits={limits} />
      </div>

      {limits.meters.length > 0 ? (
        <MeterList limits={limits} settings={settings} />
      ) : (
        <p className="text-sm text-muted-foreground">
          {limits.pollable
            ? "No limit data yet. Refresh, or send a request through this credential."
            : "This provider reports no limits. Set a budget in Credentials to track spend from Radium usage."}
        </p>
      )}
    </RowBlock>
  );
}

/**
 * Second line under the credential name: when the limit data is from, the last poll error, and
 * the budget. Owns its clock so only this text re-renders on a tick.
 */
function PollStatus({ limits }: { limits: CredentialLimits }) {
  const now = useLimitsClock();
  const parts: string[] = [];

  const updated = formatUpdated(limits.meters, now);
  if (updated) parts.push(updated);
  else if (limits.pollable) parts.push("Not polled yet");
  else parts.push("No usage endpoint");

  if (limits.budget) {
    parts.push(
      `Budget ${formatUsd(limits.budget.amount)} per ${budgetPeriodLabels[limits.budget.period]}`,
    );
  }

  return (
    <div className="flex min-w-0 flex-col text-sm text-muted-foreground">
      <span className="truncate tabular-nums">{parts.join(" · ")}</span>
      {limits.pollError ? (
        <span className="truncate text-destructive" title={limits.pollError.message} role="status">
          {formatPollError(limits.pollError, now)}
        </span>
      ) : null}
    </div>
  );
}

/** Polls the credential now. Providers without a usage endpoint keep the button disabled. */
function RefreshButton({
  workspaceId,
  limits,
}: {
  workspaceId: Id<"workspaces">;
  limits: CredentialLimits;
}) {
  const refresh = useAction(api.limits.refresh);
  const [pending, setPending] = useState(false);

  async function run() {
    setPending(true);
    try {
      await refresh({ workspace: workspaceId, credential: limits.credential });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to refresh limits.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Button
      variant="outline"
      size="sm"
      disabled={!limits.pollable || pending}
      title={limits.pollable ? undefined : "This provider has no usage endpoint to poll."}
      aria-label={`Refresh limits for ${limits.credentialName}`}
      onClick={() => void run()}
    >
      {pending ? <Spinner data-icon="inline-start" /> : <RefreshCwIcon data-icon="inline-start" />}
      Refresh
    </Button>
  );
}

/** Every meter in adapter order: label, bar, headline, then amounts, reset, source, and age. */
function MeterList({ limits, settings }: { limits: CredentialLimits; settings: LimitSettings }) {
  const now = useLimitsClock();

  return (
    <ul className="flex min-w-0 flex-col gap-3">
      {limits.meters.map((meter) => {
        const level = meterLevel(meter, settings, now);
        const details = [
          formatMeterAmounts(meter, now),
          formatResetsIn(meter, now),
          meter.source === "metered" ? "Radium usage only" : undefined,
        ].filter(Boolean);

        return (
          <li
            key={meter.id}
            className="grid min-w-0 grid-cols-[minmax(0,9rem)_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1"
          >
            <span className="flex min-w-0 items-center gap-1.5 text-sm">
              <span className="truncate" title={meter.label}>
                {meter.label}
              </span>
              {meter.scope === "account" ? (
                <Tag title="Shared by every key of the account">Account</Tag>
              ) : null}
            </span>
            <MeterBar meter={meter} settings={settings} now={now} />
            <span className={cn("text-right text-sm tabular-nums", levelText[level])}>
              {formatMeterHeadline(meter, now)}
            </span>
            <span className="col-start-2 col-end-4 truncate text-xs text-muted-foreground tabular-nums">
              {details.join(" · ")}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Workspace thresholds. Each field commits on blur or Enter and saves the whole settings object;
 * the backend requires 0 < warn < critical ≤ 100 and a non-negative low balance.
 */
function ThresholdsForm({
  workspaceId,
  settings,
}: {
  workspaceId: Id<"workspaces">;
  settings: LimitSettings;
}) {
  const saveSettings = useMutation(api.limits.setSettings);

  async function update(patch: Partial<LimitSettings>) {
    const next = { ...settings, ...patch };
    try {
      await saveSettings({
        workspace: workspaceId,
        settings: {
          warnPercent: next.warnPercent,
          criticalPercent: next.criticalPercent,
          lowBalance: next.lowBalance,
        },
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to update thresholds.");
    }
  }

  return (
    <GroupList
      title="Thresholds"
      description="When a meter counts as running low. Capped limits use percents; balances without a cap use the dollar amount."
    >
      <Row title="Warn at" description="Meters turn amber and record a Low event.">
        <NumberInput
          label="Warn at"
          unit="%"
          value={settings.warnPercent}
          validate={(value) =>
            value > 0 && value < settings.criticalPercent
              ? undefined
              : `Warn at must be above 0% and below ${settings.criticalPercent}%.`
          }
          onCommit={(warnPercent) => void update({ warnPercent })}
        />
      </Row>
      <Row title="Critical at" description="Meters turn red and record a Critical event.">
        <NumberInput
          label="Critical at"
          unit="%"
          value={settings.criticalPercent}
          validate={(value) =>
            value > settings.warnPercent && value <= 100
              ? undefined
              : `Critical at must be above ${settings.warnPercent}% and at most 100%.`
          }
          onCommit={(criticalPercent) => void update({ criticalPercent })}
        />
      </Row>
      <Row title="Low balance" description="Balances under this amount count as low.">
        <NumberInput
          label="Low balance"
          prefix="$"
          value={settings.lowBalance}
          validate={(value) => (value >= 0 ? undefined : "Low balance must be zero or more.")}
          onCommit={(lowBalance) => void update({ lowBalance })}
        />
      </Row>
    </GroupList>
  );
}

/**
 * Decimal field that commits on blur or Enter; Escape restores the saved value. Invalid input is
 * refused with a message instead of being clamped, matching the backend.
 */
function NumberInput({
  label,
  unit,
  prefix,
  value,
  validate,
  onCommit,
}: {
  label: string;
  unit?: string;
  prefix?: string;
  value: number;
  validate: (value: number) => string | undefined;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));

  // Follow the saved value (another tab's change, or a rejected save rolling back).
  useEffect(() => setDraft(String(value)), [value]);

  const parsed = /^\d+(\.\d+)?$/.test(draft.trim()) ? Number(draft) : undefined;
  const invalid = parsed === undefined || validate(parsed) !== undefined;

  function commit() {
    if (parsed === undefined) {
      toast.error(`${label} must be a number.`);
      setDraft(String(value));
      return;
    }
    const message = validate(parsed);
    if (message) {
      toast.error(message);
      setDraft(String(value));
      return;
    }
    if (parsed !== value) onCommit(parsed);
  }

  return (
    <InputGroup className="w-28">
      {prefix ? (
        <InputGroupAddon>
          <InputGroupText>{prefix}</InputGroupText>
        </InputGroupAddon>
      ) : null}
      <InputGroupInput
        aria-label={label}
        aria-invalid={invalid}
        inputMode="decimal"
        className="text-right tabular-nums"
        value={draft}
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

/** Recorded limit events, newest first. Read-only; nothing here delivers them anywhere. */
function EventList({ events }: { events: LimitEvent[] | undefined }) {
  return (
    <GroupList
      title="Recent events"
      description="Thresholds crossed, windows reset, and credential or poll problems, newest first."
    >
      {events === undefined ? (
        <RowBlock>
          <Skeleton className="h-6" />
        </RowBlock>
      ) : events.length === 0 ? (
        <RowBlock>
          <p className="text-sm text-muted-foreground">No limit events yet.</p>
        </RowBlock>
      ) : (
        events.map((event) => {
          const kind = eventKinds[event.kind];
          return (
            <Row
              key={event._id}
              leading={<ProviderLogo slug={event.provider} className="size-8" />}
              title={<span title={event.message}>{event.message}</span>}
              description={
                <>
                  {event.credentialName} · <RelativeTime at={event.occurredAt} />
                </>
              }
            >
              <Badge variant={kind.variant}>{kind.label}</Badge>
            </Row>
          );
        })
      )}
    </GroupList>
  );
}
