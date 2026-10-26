import { Fragment, useRef, useState } from "react";
import { useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { PlusIcon, Trash2Icon } from "lucide-react";
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
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { api } from "backend/convex/_generated/api";
import type { Id } from "backend/convex/_generated/dataModel";
import {
  ROUTING_LIMITS,
  type ErrorRule,
  type ErrorRuleAction,
  type ProviderRouting,
  type RoutingStrategy,
} from "backend/src/routing/settings";
import { ProviderLogo } from "./provider-logo";

export type RoutingProvider = FunctionReturnType<
  typeof api.routing.getConfiguration
>["providers"][number];

const actionOptions: Array<{ value: ErrorRuleAction; label: string }> = [
  { value: "stop", label: "Stop" },
  { value: "stop-and-cooldown", label: "Stop and cool down" },
  { value: "continue", label: "Try next provider" },
  { value: "continue-and-cooldown", label: "Try next and cool down" },
];

type RuleDraft = {
  key: number;
  status: string;
  match: string;
  matchRegex: string;
  action: ErrorRuleAction;
};

type RoutingDraft = {
  priority: string;
  weight: string;
  disableCooling: boolean;
  modelLevelCooling: boolean;
  rules: RuleDraft[];
};

type CredentialDraft = {
  credential: Id<"workspace_credentials">;
  name: string;
  enabled: boolean;
  priority: string;
  weight: string;
};

type CredentialPlacement = {
  credential: Id<"workspace_credentials">;
  priority: number;
  weight: number;
};

/** Parses a whole number typed into a field; `undefined` when it is not an integer in range. */
export function parseInteger(text: string, min: number, max: number): number | undefined {
  const trimmed = text.trim();
  if (!/^-?\d+$/.test(trimmed)) return undefined;

  const value = Number(trimmed);
  if (value < min || value > max) return undefined;
  return value;
}

/**
 * Edits one provider's routing overrides (priority, weight, cooling, error rules) and its
 * credentials' priority and weight inside the provider, saved together through
 * `api.routing.setProviderRouting` (overrides as a full replacement, only changed credentials).
 * Owner only; the route gates members.
 */
export function ProviderRoutingDialog({
  provider,
  strategy,
  workspaceCoolingDisabled,
  workspaceId,
  onOpenChange,
}: {
  provider: RoutingProvider | null;
  strategy: RoutingStrategy;
  workspaceCoolingDisabled: boolean;
  workspaceId: Id<"workspaces"> | undefined;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={provider !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85svh] gap-0 overflow-hidden p-0 sm:max-w-lg">
        {provider && workspaceId ? (
          <ProviderRoutingForm
            key={provider.slug}
            provider={provider}
            strategy={strategy}
            workspaceCoolingDisabled={workspaceCoolingDisabled}
            workspaceId={workspaceId}
            onClose={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function ProviderRoutingForm({
  provider,
  strategy,
  workspaceCoolingDisabled,
  workspaceId,
  onClose,
}: {
  provider: RoutingProvider;
  strategy: RoutingStrategy;
  workspaceCoolingDisabled: boolean;
  workspaceId: Id<"workspaces">;
  onClose: () => void;
}) {
  const save = useMutation(api.routing.setProviderRouting);
  const initial = provider.routing;
  const [priority, setPriority] = useState(String(initial.priority));
  const [weight, setWeight] = useState(String(initial.weight));
  const [disableCooling, setDisableCooling] = useState(initial.disableCooling);
  const [modelLevelCooling, setModelLevelCooling] = useState(initial.modelLevelCooling);
  const [rules, setRules] = useState<RuleDraft[]>(() =>
    initial.errorRules.map((rule, index) => ruleToDraft(rule, index)),
  );
  const nextRuleKey = useRef(initial.errorRules.length);
  const [credentials, setCredentials] = useState<CredentialDraft[]>(() =>
    provider.credentials.map((credential) => ({
      credential: credential._id,
      name: credential.name,
      enabled: credential.enabled,
      priority: String(credential.priority),
      weight: String(credential.weight),
    })),
  );
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const isWeighted = strategy === "weighted-round-robin";
  const canAddRule = rules.length < ROUTING_LIMITS.maxErrorRules;

  function addRule() {
    const key = nextRuleKey.current;
    nextRuleKey.current += 1;
    setRules((current) => [
      ...current,
      { key, status: "400", match: "", matchRegex: "", action: "stop" },
    ]);
  }

  function updateRule(key: number, patch: Partial<Omit<RuleDraft, "key">>) {
    setRules((current) => current.map((rule) => (rule.key === key ? { ...rule, ...patch } : rule)));
  }

  function updateCredential(
    credential: Id<"workspace_credentials">,
    patch: Partial<Pick<CredentialDraft, "priority" | "weight">>,
  ) {
    setCredentials((current) =>
      current.map((draft) => (draft.credential === credential ? { ...draft, ...patch } : draft)),
    );
  }

  function removeRule(key: number) {
    setRules((current) => current.filter((rule) => rule.key !== key));
  }

  async function submit() {
    const routing = buildProviderRouting({
      priority,
      weight,
      disableCooling,
      modelLevelCooling,
      rules,
    });
    if (typeof routing === "string") {
      setError(routing);
      return;
    }
    const placements = buildCredentialPlacements(credentials, provider.credentials);
    if (typeof placements === "string") {
      setError(placements);
      return;
    }

    setError(null);
    setSubmitting(true);
    try {
      await save({
        workspace: workspaceId,
        provider: provider.slug,
        routing,
        credentials: placements,
      });
      toast.success(`Saved routing for ${provider.name}.`);
      onClose();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Failed to save provider routing.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <DialogHeader className="p-6 pb-4">
        <div className="flex min-w-0 items-center gap-3">
          <ProviderLogo slug={provider.slug} className="size-8" />
          <div className="flex min-w-0 flex-col">
            <DialogTitle className="truncate">{provider.name}</DialogTitle>
            <DialogDescription className="truncate font-mono text-xs">
              {provider.slug}
            </DialogDescription>
          </div>
        </div>
      </DialogHeader>

      <div className="max-h-[58svh] overflow-y-auto border-y px-6 py-4">
        <FieldGroup>
          <div className="grid grid-cols-2 gap-4">
            <Field>
              <FieldLabel htmlFor="routing-priority">Priority</FieldLabel>
              <Input
                id="routing-priority"
                inputMode="numeric"
                className="tabular-nums"
                value={priority}
                onChange={(event) => setPriority(event.target.value)}
              />
              <FieldDescription>
                Higher goes first. Lower tiers serve only when every higher one is blocked.
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="routing-weight">Weight</FieldLabel>
              <Input
                id="routing-weight"
                inputMode="numeric"
                className="tabular-nums"
                value={weight}
                onChange={(event) => setWeight(event.target.value)}
              />
              <FieldDescription>
                {isWeighted
                  ? "Share of requests within its priority. 0 excludes this provider."
                  : "Only used by the weighted round robin strategy."}
              </FieldDescription>
            </Field>
          </div>

          {credentials.length > 0 ? (
            <section className="flex flex-col gap-3">
              <div className="flex min-w-0 flex-col gap-0.5">
                <h3 className="text-sm font-medium">Credentials</h3>
                <p className="text-sm text-muted-foreground">
                  {isWeighted
                    ? "Order and share inside this provider. Higher priority is used first; weight splits requests within a priority, and 0 skips a credential."
                    : "Order inside this provider. Higher priority is used first; weights apply only under weighted round robin."}
                </p>
              </div>
              <div className="grid grid-cols-[minmax(0,1fr)_5rem_5rem] items-center gap-x-3 gap-y-2">
                <span />
                <span className="text-xs text-muted-foreground">Priority</span>
                <span
                  data-disabled={!isWeighted}
                  className="text-xs text-muted-foreground data-[disabled=true]:opacity-60"
                >
                  Weight
                </span>
                {credentials.map((draft) => (
                  <Fragment key={draft.credential}>
                    <span
                      data-disabled={!draft.enabled}
                      className="truncate text-sm data-[disabled=true]:opacity-60"
                      title={draft.name}
                    >
                      {draft.name}
                      {draft.enabled ? null : (
                        <span className="text-muted-foreground"> · Disabled</span>
                      )}
                    </span>
                    <Input
                      aria-label={`${draft.name} priority`}
                      inputMode="numeric"
                      className="tabular-nums"
                      value={draft.priority}
                      onChange={(event) =>
                        updateCredential(draft.credential, { priority: event.target.value })
                      }
                    />
                    <Input
                      aria-label={`${draft.name} weight`}
                      inputMode="numeric"
                      className="tabular-nums"
                      value={draft.weight}
                      onChange={(event) =>
                        updateCredential(draft.credential, { weight: event.target.value })
                      }
                    />
                  </Fragment>
                ))}
              </div>
            </section>
          ) : null}

          <Field orientation="horizontal">
            <FieldContent>
              <FieldLabel htmlFor="routing-disable-cooling">Disable cooling</FieldLabel>
              <FieldDescription>
                {workspaceCoolingDisabled
                  ? "Cooling is already off for the whole workspace."
                  : "Keep this provider in rotation after failures."}
              </FieldDescription>
            </FieldContent>
            <Switch
              id="routing-disable-cooling"
              checked={disableCooling}
              onCheckedChange={setDisableCooling}
            />
          </Field>
          <Field orientation="horizontal">
            <FieldContent>
              <FieldLabel htmlFor="routing-model-cooling">Model-level cooling</FieldLabel>
              <FieldDescription>
                Quota errors cool down only the requested model on the failing credential, not all
                of its models.
              </FieldDescription>
            </FieldContent>
            <Switch
              id="routing-model-cooling"
              checked={modelLevelCooling}
              onCheckedChange={setModelLevelCooling}
            />
          </Field>

          <section className="flex flex-col gap-3">
            <div className="flex items-end justify-between gap-3">
              <div className="flex min-w-0 flex-col gap-0.5">
                <h3 className="text-sm font-medium">Error rules</h3>
                <p className="text-sm text-muted-foreground">
                  Match an upstream error by status and any body substring or regex. Stop returns it
                  to the caller, Try next moves on to another provider, and cool down also takes the
                  failing credential out of rotation.
                </p>
              </div>
              <Button variant="outline" size="sm" onClick={addRule} disabled={!canAddRule}>
                <PlusIcon data-icon="inline-start" />
                Add rule
              </Button>
            </div>

            {rules.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No rules. Errors get the default handling.
              </p>
            ) : (
              rules.map((rule, index) => (
                <ErrorRuleEditor
                  key={rule.key}
                  rule={rule}
                  index={index}
                  onChange={(patch) => updateRule(rule.key, patch)}
                  onRemove={() => removeRule(rule.key)}
                />
              ))
            )}
          </section>
        </FieldGroup>
      </div>

      {error ? <FieldError className="px-6 pt-3">{error}</FieldError> : null}

      <DialogFooter className="p-4">
        <Button variant="outline" onClick={onClose} disabled={submitting}>
          Cancel
        </Button>
        <Button onClick={() => void submit()} disabled={submitting}>
          {submitting && <Spinner data-icon="inline-start" />}
          Save
        </Button>
      </DialogFooter>
    </>
  );
}

function ErrorRuleEditor({
  rule,
  index,
  onChange,
  onRemove,
}: {
  rule: RuleDraft;
  index: number;
  onChange: (patch: Partial<Omit<RuleDraft, "key">>) => void;
  onRemove: () => void;
}) {
  const id = `routing-rule-${rule.key}`;
  const label = `Rule ${index + 1}`;

  return (
    <div className="flex flex-col gap-3 rounded-xl border p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm text-muted-foreground">{label}</span>
        <Button
          variant="ghost"
          size="icon-xs"
          className="text-muted-foreground hover:text-destructive"
          onClick={onRemove}
          aria-label={`Remove ${label}`}
        >
          <Trash2Icon />
        </Button>
      </div>

      <div className="grid grid-cols-[6rem_minmax(0,1fr)] gap-3">
        <Field>
          <FieldLabel htmlFor={`${id}-status`}>Status</FieldLabel>
          <Input
            id={`${id}-status`}
            inputMode="numeric"
            placeholder="400"
            className="tabular-nums"
            value={rule.status}
            onChange={(event) => onChange({ status: event.target.value })}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor={`${id}-action`}>Action</FieldLabel>
          <Select
            value={rule.action}
            onValueChange={(value) => {
              const option = actionOptions.find((entry) => entry.value === value);
              if (option) onChange({ action: option.value });
            }}
          >
            <SelectTrigger id={`${id}-action`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {actionOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
      </div>

      <Field>
        <FieldLabel htmlFor={`${id}-match`}>Body contains</FieldLabel>
        <Textarea
          id={`${id}-match`}
          rows={2}
          placeholder="context_length_exceeded"
          className="font-mono text-[13px] md:text-[13px]"
          value={rule.match}
          onChange={(event) => onChange({ match: event.target.value })}
        />
        <FieldDescription>One substring per line.</FieldDescription>
      </Field>
      <Field>
        <FieldLabel htmlFor={`${id}-regex`}>Body matches</FieldLabel>
        <Textarea
          id={`${id}-regex`}
          rows={2}
          placeholder="quota.*exceeded"
          className="font-mono text-[13px] md:text-[13px]"
          value={rule.matchRegex}
          onChange={(event) => onChange({ matchRegex: event.target.value })}
        />
        <FieldDescription>One regular expression per line.</FieldDescription>
      </Field>
    </div>
  );
}

function ruleToDraft(rule: ErrorRule, key: number): RuleDraft {
  return {
    key,
    status: String(rule.status),
    match: rule.match.join("\n"),
    matchRegex: rule.matchRegex.join("\n"),
    action: rule.action,
  };
}

/** Non-blank lines of a pattern field, kept verbatim so substrings may include spaces. */
function patternLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .filter((line) => line.trim().length > 0);
}

/**
 * Validates credential priority and weight drafts like `assertValidPlacement` and returns only
 * the credentials whose values changed, or a message naming the first invalid field.
 */
function buildCredentialPlacements(
  drafts: CredentialDraft[],
  saved: RoutingProvider["credentials"],
): CredentialPlacement[] | string {
  const placements: CredentialPlacement[] = [];
  for (const draft of drafts) {
    const priority = parseInteger(
      draft.priority,
      -ROUTING_LIMITS.maxPriority,
      ROUTING_LIMITS.maxPriority,
    );
    if (priority === undefined) {
      return `${draft.name}: priority must be a whole number from ${-ROUTING_LIMITS.maxPriority} to ${ROUTING_LIMITS.maxPriority}.`;
    }
    const weight = parseInteger(draft.weight, 0, ROUTING_LIMITS.maxWeight);
    if (weight === undefined) {
      return `${draft.name}: weight must be a whole number from 0 to ${ROUTING_LIMITS.maxWeight}.`;
    }

    const current = saved.find((credential) => credential._id === draft.credential);
    if (current?.priority !== priority || current.weight !== weight) {
      placements.push({ credential: draft.credential, priority, weight });
    }
  }
  return placements;
}
/**
 * Validates the form against the backend's rules (`assertValidProviderRouting`) so most mistakes
 * get a message naming the field before the save; returns that message or the routing to save.
 */
function buildProviderRouting(draft: RoutingDraft): ProviderRouting | string {
  const priority = parseInteger(
    draft.priority,
    -ROUTING_LIMITS.maxPriority,
    ROUTING_LIMITS.maxPriority,
  );
  if (priority === undefined) {
    return `Priority must be a whole number from ${-ROUTING_LIMITS.maxPriority} to ${ROUTING_LIMITS.maxPriority}.`;
  }

  const weight = parseInteger(draft.weight, 0, ROUTING_LIMITS.maxWeight);
  if (weight === undefined) {
    return `Weight must be a whole number from 0 to ${ROUTING_LIMITS.maxWeight}.`;
  }

  if (draft.rules.length > ROUTING_LIMITS.maxErrorRules) {
    return `At most ${ROUTING_LIMITS.maxErrorRules} error rules are allowed.`;
  }

  const errorRules: ErrorRule[] = [];
  for (const [index, rule] of draft.rules.entries()) {
    const label = `Rule ${index + 1}`;
    const status = parseInteger(rule.status, 100, 599);
    if (status === undefined) return `${label}: status must be from 100 to 599.`;

    const match = patternLines(rule.match);
    const matchRegex = patternLines(rule.matchRegex);
    const patterns = [...match, ...matchRegex];
    if (patterns.length === 0) return `${label}: add at least one substring or regex.`;
    if (patterns.length > ROUTING_LIMITS.maxErrorRuleMatches) {
      return `${label}: at most ${ROUTING_LIMITS.maxErrorRuleMatches} patterns are allowed.`;
    }

    if (patterns.some((pattern) => pattern.length > ROUTING_LIMITS.maxErrorRuleMatchLength)) {
      return `${label}: patterns must be at most ${ROUTING_LIMITS.maxErrorRuleMatchLength} characters.`;
    }

    for (const pattern of matchRegex) {
      try {
        new RegExp(pattern);
      } catch {
        return `${label}: invalid regular expression ${pattern}`;
      }
    }

    errorRules.push({ status, match, matchRegex, action: rule.action });
  }

  return {
    priority,
    weight,
    disableCooling: draft.disableCooling,
    modelLevelCooling: draft.modelLevelCooling,
    errorRules,
  };
}
