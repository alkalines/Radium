import {
  useCallback,
  useId,
  useMemo,
  useState,
  type ComponentType,
  type FormEvent,
  type ReactNode,
} from "react";
import { convexQuery } from "@convex-dev/react-query";
import { useQuery } from "@tanstack/react-query";
import { useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import {
  CheckIcon,
  CopyIcon,
  ExternalLinkIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
import { toast } from "sonner";
import {
  LoginWithChatGPT,
  type UseLoginWithChatGPTResult,
} from "@opencoredev/loginwithchatgpt-react";

import { AgentStatus } from "@/components/agentic/agent-status";
import { GroupList, Row, RowBlock } from "@/components/harness/group-list";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  InputGroupText,
} from "@/components/ui/input-group";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { api } from "backend/convex/_generated/api";
import type { Id } from "backend/convex/_generated/dataModel";
import {
  CompactCredentialMeters,
  formatPlan,
  type BudgetPeriod,
  type CredentialLimits,
  type LimitSettings,
} from "./limit-meters";
import { ProviderLogo } from "./provider-logo";
import { authClient } from "@/lib/auth-client";

export type CredentialsTarget = {
  slug: string;
  name: string;
  env: string[];
  credential_type?: "api_key" | "oauth";
  oauth_flow?: string;
};

/**
 * One pooled credential from `api.providers.listCredentials`. Values are masked previews only;
 * `_id` is absent for a legacy credential that has not been migrated to its own row yet.
 */
export type ProviderCredential = FunctionReturnType<typeof api.providers.listCredentials>[number];

const CHATGPT_BASE_PATH = "/api/backend/subscription/chatgpt-subscription";

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

/**
 * Per-provider credential pool manager (owner-only). Lists the provider's credentials in
 * fill-first order, toggles, relabels, and removes them, and adds new ones: an env-var form for
 * API-key providers, the provider's registered sign-in flow for OAuth accounts. Secrets are
 * write-only; nothing here reads a stored value back.
 */
export function CredentialsDialog({
  target,
  workspaceId,
  credentials,
  onOpenChange,
}: {
  target: CredentialsTarget | null;
  workspaceId: Id<"workspaces"> | undefined;
  /** This provider's credentials only. */
  credentials: ProviderCredential[];
  onOpenChange: (open: boolean) => void;
}) {
  const isOAuth = target?.credential_type === "oauth";

  return (
    <Dialog open={target !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {target && <ProviderLogo slug={target.slug} className="size-6" />}
            {target?.name} credentials
          </DialogTitle>
          <DialogDescription>
            {isOAuth
              ? "Each connected account is one credential. Requests rotate across the enabled accounts, and their sessions stay encrypted on the server."
              : "Each key is one credential. Requests rotate across the enabled keys. Keys are encrypted at rest and never shown again."}
          </DialogDescription>
        </DialogHeader>

        {target && !workspaceId ? (
          <p className="text-sm text-muted-foreground">
            You need an active workspace before you can store credentials.
          </p>
        ) : null}

        {target && workspaceId && isOAuth ? (
          <OAuthAccountPool
            key={target.slug}
            target={target}
            workspaceId={workspaceId}
            credentials={credentials}
          />
        ) : null}

        {target && workspaceId && !isOAuth ? (
          <ApiKeyPool
            key={target.slug}
            target={target}
            workspaceId={workspaceId}
            credentials={credentials}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/** API-key pool: the stored keys, then an add form with an optional label and one field per env name. */
function ApiKeyPool({
  target,
  workspaceId,
  credentials,
}: {
  target: CredentialsTarget;
  workspaceId: Id<"workspaces">;
  credentials: ProviderCredential[];
}) {
  const createCredential = useMutation(api.providers.createCredential);
  const fieldId = useId();
  const [adding, setAdding] = useState(credentials.length === 0);
  const [label, setLabel] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  const complete = target.env.every((name) => values[name]?.trim());

  async function add(event: FormEvent) {
    event.preventDefault();
    if (!complete) return;

    setSubmitting(true);
    try {
      await createCredential({
        workspace: workspaceId,
        provider: target.slug,
        label: label.trim() || undefined,
        credentials: values,
      });
      toast.success(`Added a ${target.name} key.`);
      setLabel("");
      setValues({});
      setAdding(false);
    } catch (error) {
      toast.error(errorMessage(error, "Failed to add the key."));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-6">
      {credentials.length > 0 ? (
        <CredentialList
          title="Keys"
          workspaceId={workspaceId}
          credentials={credentials}
          env={target.env}
        />
      ) : null}

      {adding ? (
        <GroupList title="New key">
          <RowBlock>
            <form onSubmit={add} className="flex flex-col gap-4">
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor={`${fieldId}-label`}>Label</FieldLabel>
                  <Input
                    id={`${fieldId}-label`}
                    autoComplete="off"
                    placeholder="Optional, such as Team or Personal"
                    value={label}
                    onChange={(event) => setLabel(event.target.value)}
                  />
                </Field>
                {target.env.map((name) => (
                  <Field key={name}>
                    <FieldLabel htmlFor={`${fieldId}-${name}`} className="font-mono text-[13px]">
                      {name}
                    </FieldLabel>
                    <Input
                      id={`${fieldId}-${name}`}
                      type="password"
                      autoComplete="off"
                      placeholder={`Enter ${name}`}
                      value={values[name] ?? ""}
                      onChange={(event) =>
                        setValues((prev) => ({ ...prev, [name]: event.target.value }))
                      }
                    />
                  </Field>
                ))}
              </FieldGroup>
              <div className="flex justify-end gap-2">
                {credentials.length > 0 ? (
                  <Button type="button" variant="ghost" onClick={() => setAdding(false)}>
                    Cancel
                  </Button>
                ) : null}
                <Button type="submit" disabled={submitting || !complete}>
                  {submitting && <Spinner data-icon="inline-start" />}
                  Add key
                </Button>
              </div>
            </form>
          </RowBlock>
        </GroupList>
      ) : (
        <Button variant="outline" className="self-start" onClick={() => setAdding(true)}>
          <PlusIcon data-icon="inline-start" />
          Add key
        </Button>
      )}
    </div>
  );
}

/**
 * Contract for one OAuth sign-in flow. A flow adds one account to the provider's pool on the
 * server; it never lists or removes accounts (the Convex query and `deleteCredential` own that).
 * `onConnected` fires once per completed sign-in.
 */
type OAuthFlowProps = {
  workspaceId: Id<"workspaces">;
  providerName: string;
  onConnected: () => void;
};

/** Sign-in flows by provider `oauth_flow`. A provider whose flow is missing can list accounts only. */
const oauthFlows: Record<string, ComponentType<OAuthFlowProps>> = {
  "chatgpt-device": ChatGPTDeviceFlow,
};

/** OAuth account pool: connected accounts, then the provider's registered sign-in flow. */
function OAuthAccountPool({
  target,
  workspaceId,
  credentials,
}: {
  target: CredentialsTarget;
  workspaceId: Id<"workspaces">;
  credentials: ProviderCredential[];
}) {
  const Flow = target.oauth_flow ? oauthFlows[target.oauth_flow] : undefined;

  return (
    <div className="flex min-w-0 flex-col gap-6">
      {credentials.length > 0 ? (
        <CredentialList
          title="Connected accounts"
          workspaceId={workspaceId}
          credentials={credentials}
        />
      ) : (
        <p className="text-sm text-muted-foreground">No {target.name} accounts connected yet.</p>
      )}

      {Flow ? (
        <Flow
          workspaceId={workspaceId}
          providerName={target.name}
          onConnected={() => toast.success(`${target.name} account connected.`)}
        />
      ) : (
        <p className="text-sm text-muted-foreground">
          Connecting new {target.name} accounts is not supported in this interface yet.
        </p>
      )}
    </div>
  );
}

/**
 * ChatGPT device-code sign-in. Every completed login adds an account on the server
 * (re-authorizing a connected account replaces its session), so the Convex query refreshes the
 * account list on its own.
 */
function ChatGPTDeviceFlow({ workspaceId, onConnected }: OAuthFlowProps) {
  const oauthFetch = useCallback(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      // Scope the request to this workspace while retaining the browser session.
      const url = new URL(
        typeof input === "string" || input instanceof URL ? input : input.url,
        window.location.origin,
      );
      url.searchParams.set("workspace", workspaceId);
      const { data } = await authClient.convex.token({ fetchOptions: { throw: false } });
      const headers = new Headers(init?.headers);
      if (data?.token) headers.set("Authorization", `Bearer ${data.token}`);
      return fetch(url, { ...init, headers, credentials: "include" });
    },
    [workspaceId],
  );

  return (
    <LoginWithChatGPT
      basePath={CHATGPT_BASE_PATH}
      fetch={oauthFetch as typeof fetch}
      onAuthenticated={onConnected}
    >
      {(state) => <ChatGPTLogin state={state} />}
    </LoginWithChatGPT>
  );
}

/**
 * Our rendering of the library's device-code state. A custom renderer owns the consent step:
 * adding an account lets Radium spend that plan's limits, so login only starts from Continue.
 * The library's `logout` is never used; it would end the browser session, not remove one account.
 */
function ChatGPTLogin({ state }: { state: UseLoginWithChatGPTResult }) {
  const [consenting, setConsenting] = useState(false);

  if (state.isPending) {
    return (
      <div className="flex flex-col gap-3 rounded-2xl border bg-card p-4">
        <p className="text-sm text-muted-foreground">
          Enter this code on OpenAI's verification page to add the account.
        </p>
        <div className="flex items-center gap-2">
          <span className="font-mono text-[13px] font-medium tracking-widest">
            {state.userCode}
          </span>
          <Button variant="ghost" size="xs" onClick={() => void state.copyCode()}>
            {state.copied ? (
              <CheckIcon data-icon="inline-start" />
            ) : (
              <CopyIcon data-icon="inline-start" />
            )}
            {state.copied ? "Copied" : "Copy"}
          </Button>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <AgentStatus state="awaiting" label="Waiting for approval" />
          {state.verificationUrl ? (
            <Button variant="outline" size="sm" asChild>
              <a
                href={state.verificationUrl}
                target="_blank"
                rel="noreferrer"
                onClick={(event) => {
                  // Focus the login tab the flow already opened instead of opening another.
                  event.preventDefault();
                  state.reopen();
                }}
              >
                Open verification page
                <ExternalLinkIcon data-icon="inline-end" />
              </a>
            </Button>
          ) : null}
        </div>
      </div>
    );
  }

  if (consenting) {
    return (
      <div className="flex flex-col gap-3 rounded-2xl border bg-card p-4">
        <p className="text-sm font-medium">Add a ChatGPT account?</p>
        <ul className="flex list-disc flex-col gap-1.5 pl-4 text-sm text-muted-foreground">
          <li>
            Radium can send requests on that ChatGPT plan until you remove the account. Heavy use
            can exhaust the plan's usage limits.
          </li>
          <li>Prompts and files pass through this Radium server on their way to OpenAI.</li>
          <li>Radium never sees your ChatGPT password; you sign in on OpenAI's own page.</li>
          <li>Removing the account here deletes its stored session.</li>
        </ul>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => setConsenting(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={() => {
              setConsenting(false);
              void state.login();
            }}
          >
            Continue
          </Button>
        </div>
      </div>
    );
  }

  let problem: string | undefined;
  if (state.error) problem = state.error;
  else if (state.status === "expired") problem = "The code expired before it was approved.";
  else if (state.status === "error") problem = "Sign-in did not complete.";

  return (
    <div className="flex flex-col items-start gap-2">
      <Button variant="outline" disabled={state.isConnecting} onClick={() => setConsenting(true)}>
        {state.isConnecting ? (
          <Spinner data-icon="inline-start" />
        ) : (
          <PlusIcon data-icon="inline-start" />
        )}
        {state.isConnecting ? "Connecting…" : "Add account"}
      </Button>
      {problem ? (
        <p role="alert" className="text-sm text-destructive">
          {problem} Try again.
        </p>
      ) : null}
    </div>
  );
}

/**
 * The provider's credentials in fill-first order. Every credential with a row can be relabeled.
 * Passing `env` marks them as API keys: previews render as Machine text and values can be
 * replaced. OAuth accounts never take new values here; signing in again replaces a session.
 * Rows show their tightest usage meters from `api.limits.list`, joined by credential id; Edit
 * waits for that query so the budget fields start from the stored budget.
 */
function CredentialList({
  title,
  workspaceId,
  credentials,
  env,
}: {
  title: string;
  workspaceId: Id<"workspaces">;
  credentials: ProviderCredential[];
  env?: string[];
}) {
  const [editingId, setEditingId] = useState<Id<"workspace_credentials"> | null>(null);
  const limitsQuery = useQuery(convexQuery(api.limits.list, { workspace: workspaceId }));
  const { data: limitSettings } = useQuery(
    convexQuery(api.limits.getSettings, { workspace: workspaceId }),
  );
  const limitsByCredential = useMemo(
    () => new Map(limitsQuery.data?.map((entry) => [entry.credential, entry])),
    [limitsQuery.data],
  );
  // A failed limits query must not lock editing; the form then leaves out the limit fields.
  const limitsSettled = limitsQuery.data !== undefined || limitsQuery.isError;

  return (
    <GroupList title={title}>
      {credentials.map((credential) => {
        const credentialId = credential._id;
        const key = credentialId ?? `legacy:${credential.provider}`;
        const limits = credentialId ? limitsByCredential.get(credentialId) : undefined;

        // Legacy credentials (no row yet) can only be removed, so they are never editable.
        if (credentialId && credentialId === editingId) {
          return (
            <CredentialEditForm
              key={key}
              workspaceId={workspaceId}
              credentialId={credentialId}
              credential={credential}
              limits={limitsQuery.data ? (limits ?? null) : undefined}
              env={env ?? []}
              onDone={() => setEditingId(null)}
            />
          );
        }

        return (
          <CredentialRow
            key={key}
            workspaceId={workspaceId}
            credential={credential}
            limits={limits}
            limitSettings={limitSettings}
            isKey={env !== undefined}
            onEdit={credentialId && limitsSettled ? () => setEditingId(credentialId) : undefined}
          />
        );
      })}
    </GroupList>
  );
}

/**
 * One credential: name, masked preview, placement, enable switch, and actions. When the
 * credential has limit data, up to two compact meters sit under the preview (tooltip: every meter).
 */
function CredentialRow({
  workspaceId,
  credential,
  limits,
  limitSettings,
  isKey,
  onEdit,
}: {
  workspaceId: Id<"workspaces">;
  credential: ProviderCredential;
  limits?: CredentialLimits;
  limitSettings?: LimitSettings;
  isKey: boolean;
  onEdit?: () => void;
}) {
  const updateCredential = useMutation(api.providers.updateCredential);
  const deleteCredential = useMutation(api.providers.deleteCredential);
  const [pending, setPending] = useState(false);
  const credentialId = credential._id;

  async function setEnabled(enabled: boolean) {
    if (!credentialId) return;
    setPending(true);
    try {
      await updateCredential({ workspace: workspaceId, credential: credentialId, enabled });
    } catch (error) {
      toast.error(errorMessage(error, "Failed to update the credential."));
    } finally {
      setPending(false);
    }
  }

  async function remove() {
    setPending(true);
    try {
      // A legacy credential has no row yet; omitting `credential` removes it by provider.
      await deleteCredential({
        workspace: workspaceId,
        provider: credential.provider,
        credential: credentialId,
      });
      toast.success(`Removed ${credential.name}.`);
    } catch (error) {
      toast.error(errorMessage(error, "Failed to remove the credential."));
      setPending(false);
    }
  }

  let preview: ReactNode;
  if (isKey) {
    const masked = Object.entries(credential.preview)
      .map(([name, value]) => `${name} ${value}`)
      .join(" · ");
    preview = <span className="font-mono text-[13px]">{masked}</span>;
  } else if (credential.label) {
    // Unlabeled accounts are already named after their preview.
    preview = Object.values(credential.preview).join(" · ");
  }

  // Defaults (priority 0, weight 1) match providers and stay implicit.
  const placement = [
    credential.priority !== 0 ? `Priority ${credential.priority}` : null,
    credential.weight !== 1 ? `Weight ${credential.weight}` : null,
  ].filter(Boolean);
  const summary =
    placement.length > 0 ? (
      <>
        {preview}
        {preview ? " · " : null}
        <span className="tabular-nums">{placement.join(" · ")}</span>
      </>
    ) : (
      preview
    );
  const description =
    limits && limitSettings ? (
      <>
        {summary ? <div className="truncate">{summary}</div> : null}
        <CompactCredentialMeters limits={limits} settings={limitSettings} />
      </>
    ) : (
      summary
    );

  return (
    <Row
      data-disabled={!credential.enabled}
      className="data-[disabled=true]:opacity-60"
      title={<span title={credential.name}>{credential.name}</span>}
      tag={credentialId ? limits?.plan && formatPlan(limits.plan) : "Legacy"}
      description={description}
    >
      {credentialId ? (
        <Switch
          checked={credential.enabled}
          disabled={pending}
          onCheckedChange={(checked) => void setEnabled(checked)}
          aria-label={`Use ${credential.name} for requests`}
        />
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            className="text-muted-foreground"
            disabled={pending}
            aria-label={`Actions for ${credential.name}`}
          >
            <MoreHorizontalIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {onEdit ? (
            <DropdownMenuItem onSelect={onEdit}>
              <PencilIcon />
              Edit
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem variant="destructive" onSelect={() => void remove()}>
            <Trash2Icon />
            Remove
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </Row>
  );
}

const budgetPeriods: Array<{ value: BudgetPeriod; label: string }> = [
  { value: "day", label: "Day" },
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
];

/**
 * Inline edit for one credential. Label, priority, and weight save on their own; for API keys
 * (`env` non-empty), values replace the stored ones only when every env field is filled, since
 * the backend replaces all values at once. Priority and weight rank the credential inside its
 * provider; the backend rejects out-of-range values.
 *
 * `limits` is the credential's `api.limits.list` entry (`null` when it has none, `undefined` when
 * the query failed, which leaves the limit fields out). The budget (USD per UTC day, week, or
 * month, metered from Radium usage) saves with the form; an empty amount clears it. A provider
 * whose limit adapter declares an extra key (`limitKey`) gets a write-only field for it.
 */
function CredentialEditForm({
  workspaceId,
  credentialId,
  credential,
  limits,
  env,
  onDone,
}: {
  workspaceId: Id<"workspaces">;
  credentialId: Id<"workspace_credentials">;
  credential: ProviderCredential;
  limits: CredentialLimits | null | undefined;
  env: string[];
  onDone: () => void;
}) {
  const updateCredential = useMutation(api.providers.updateCredential);
  const setBudget = useMutation(api.limits.setBudget);
  const setLimitKey = useMutation(api.limits.setLimitKey);
  const fieldId = useId();
  const [label, setLabel] = useState(credential.label ?? "");
  const [priority, setPriority] = useState(String(credential.priority));
  const [weight, setWeight] = useState(String(credential.weight));
  const [values, setValues] = useState<Record<string, string>>({});
  const currentBudget = limits?.budget;
  const [budgetAmount, setBudgetAmount] = useState(
    currentBudget ? String(currentBudget.amount) : "",
  );
  const [budgetPeriod, setBudgetPeriod] = useState<BudgetPeriod>(currentBudget?.period ?? "month");
  const [limitKeyValue, setLimitKeyValue] = useState("");
  const [removingLimitKey, setRemovingLimitKey] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const filledCount = env.filter((name) => values[name]?.trim()).length;
  const replacing = env.length > 0 && filledCount === env.length;
  const partial = filledCount > 0 && !replacing;
  const labelChanged = label.trim() !== (credential.label ?? "");
  const parsedPriority = /^-?\d+$/.test(priority.trim()) ? Number(priority) : undefined;
  const parsedWeight = /^\d+$/.test(weight.trim()) ? Number(weight) : undefined;
  const placementInvalid = parsedPriority === undefined || parsedWeight === undefined;
  const placementChanged =
    parsedPriority !== credential.priority || parsedWeight !== credential.weight;
  const credentialChanged = labelChanged || replacing || placementChanged;

  // Empty amount = no budget; otherwise a positive USD amount with at most two decimals.
  const amountText = budgetAmount.trim();
  const parsedBudget =
    amountText === ""
      ? null
      : /^\d+(\.\d{1,2})?$/.test(amountText) && Number(amountText) > 0
        ? Number(amountText)
        : undefined;
  const budgetInvalid = parsedBudget === undefined;
  const budgetChanged =
    limits !== undefined &&
    (parsedBudget === null
      ? currentBudget !== undefined
      : parsedBudget !== undefined &&
        (parsedBudget !== currentBudget?.amount || budgetPeriod !== currentBudget?.period));
  const limitKeyChanged = limitKeyValue.trim() !== "";

  const canSave =
    !submitting &&
    !removingLimitKey &&
    !partial &&
    !placementInvalid &&
    !budgetInvalid &&
    (credentialChanged || budgetChanged || limitKeyChanged);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!canSave) return;

    setSubmitting(true);
    try {
      if (credentialChanged) {
        await updateCredential({
          workspace: workspaceId,
          credential: credentialId,
          label: labelChanged ? label.trim() : undefined,
          priority: placementChanged ? parsedPriority : undefined,
          weight: placementChanged ? parsedWeight : undefined,
          credentials: replacing ? values : undefined,
        });
      }
      if (budgetChanged) {
        await setBudget({
          workspace: workspaceId,
          credential: credentialId,
          budget: parsedBudget ? { amount: parsedBudget, period: budgetPeriod } : null,
        });
      }
      if (limitKeyChanged) {
        await setLimitKey({
          workspace: workspaceId,
          credential: credentialId,
          key: limitKeyValue.trim(),
        });
      }
      toast.success("Saved changes.");
      onDone();
    } catch (error) {
      toast.error(errorMessage(error, "Failed to save changes."));
      setSubmitting(false);
    }
  }

  async function removeLimitKey() {
    if (!limits?.limitKey) return;
    setRemovingLimitKey(true);
    try {
      await setLimitKey({ workspace: workspaceId, credential: credentialId, key: null });
      toast.success(`Removed the ${limits.limitKey.label.toLowerCase()}.`);
    } catch (error) {
      toast.error(errorMessage(error, "Failed to remove the key."));
    } finally {
      setRemovingLimitKey(false);
    }
  }

  return (
    <RowBlock>
      <form onSubmit={save} className="flex flex-col gap-4">
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor={`${fieldId}-label`}>Label</FieldLabel>
            <Input
              id={`${fieldId}-label`}
              autoComplete="off"
              autoFocus
              placeholder="Optional"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field>
              <FieldLabel htmlFor={`${fieldId}-priority`}>Priority</FieldLabel>
              <Input
                id={`${fieldId}-priority`}
                inputMode="numeric"
                aria-invalid={parsedPriority === undefined}
                className="tabular-nums"
                value={priority}
                onChange={(event) => setPriority(event.target.value)}
              />
              <FieldDescription>Higher is used first within the provider.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor={`${fieldId}-weight`}>Weight</FieldLabel>
              <Input
                id={`${fieldId}-weight`}
                inputMode="numeric"
                aria-invalid={parsedWeight === undefined}
                className="tabular-nums"
                value={weight}
                onChange={(event) => setWeight(event.target.value)}
              />
              <FieldDescription>Share under weighted round-robin; 0 skips it.</FieldDescription>
            </Field>
          </div>
          {env.map((name) => (
            <Field key={name}>
              <FieldLabel htmlFor={`${fieldId}-${name}`} className="font-mono text-[13px]">
                {name}
              </FieldLabel>
              <Input
                id={`${fieldId}-${name}`}
                type="password"
                autoComplete="off"
                placeholder="Keep current value"
                value={values[name] ?? ""}
                onChange={(event) => setValues((prev) => ({ ...prev, [name]: event.target.value }))}
              />
              {credential.preview[name] ? (
                <FieldDescription>
                  Current: <span className="font-mono text-[13px]">{credential.preview[name]}</span>
                </FieldDescription>
              ) : null}
            </Field>
          ))}
          {limits !== undefined ? (
            <Field data-invalid={budgetInvalid}>
              <FieldLabel htmlFor={`${fieldId}-budget`}>Budget</FieldLabel>
              <div className="flex flex-wrap items-center gap-2">
                <InputGroup className="w-36">
                  <InputGroupAddon>
                    <InputGroupText>$</InputGroupText>
                  </InputGroupAddon>
                  <InputGroupInput
                    id={`${fieldId}-budget`}
                    inputMode="decimal"
                    autoComplete="off"
                    placeholder="None"
                    aria-invalid={budgetInvalid}
                    className="tabular-nums"
                    value={budgetAmount}
                    onChange={(event) => setBudgetAmount(event.target.value)}
                  />
                  {budgetAmount ? (
                    <InputGroupAddon align="inline-end">
                      <InputGroupButton
                        aria-label="Clear budget"
                        onClick={() => setBudgetAmount("")}
                      >
                        Clear
                      </InputGroupButton>
                    </InputGroupAddon>
                  ) : null}
                </InputGroup>
                <span className="text-sm text-muted-foreground">per</span>
                <ToggleGroup
                  type="single"
                  variant="outline"
                  size="sm"
                  spacing={0}
                  aria-label="Budget period"
                  disabled={amountText === ""}
                  value={budgetPeriod}
                  onValueChange={(value) => {
                    const period = budgetPeriods.find((entry) => entry.value === value);
                    if (period) setBudgetPeriod(period.value);
                  }}
                >
                  {budgetPeriods.map((period) => (
                    <ToggleGroupItem key={period.value} value={period.value}>
                      {period.label}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </div>
              <FieldDescription>
                {budgetInvalid
                  ? "Enter a dollar amount above 0, or clear it for no budget."
                  : "Tracks spend from Radium usage only, per UTC period. Leave empty for no budget."}
              </FieldDescription>
            </Field>
          ) : null}
          {limits?.limitKey ? (
            <Field>
              <FieldLabel htmlFor={`${fieldId}-limit-key`}>{limits.limitKey.label}</FieldLabel>
              <InputGroup>
                <InputGroupInput
                  id={`${fieldId}-limit-key`}
                  type="password"
                  autoComplete="off"
                  placeholder={limits.limitKey.preview ? "Keep current key" : "Optional"}
                  value={limitKeyValue}
                  onChange={(event) => setLimitKeyValue(event.target.value)}
                />
                {limits.limitKey.preview ? (
                  <InputGroupAddon align="inline-end">
                    <InputGroupButton
                      disabled={removingLimitKey || submitting}
                      aria-label={`Remove the ${limits.limitKey.label}`}
                      onClick={() => void removeLimitKey()}
                    >
                      {removingLimitKey && <Spinner data-icon="inline-start" />}
                      Remove
                    </InputGroupButton>
                  </InputGroupAddon>
                ) : null}
              </InputGroup>
              <FieldDescription>
                {limits.limitKey.description}
                {limits.limitKey.preview ? (
                  <>
                    {" "}
                    Current:{" "}
                    <span className="font-mono text-[13px]">{limits.limitKey.preview}</span>
                  </>
                ) : null}
              </FieldDescription>
            </Field>
          ) : null}
        </FieldGroup>
        {partial ? (
          <p className="text-sm text-muted-foreground">
            Fill every value to replace them, or clear them to keep the current ones.
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onDone}>
            Cancel
          </Button>
          <Button type="submit" disabled={!canSave}>
            {submitting && <Spinner data-icon="inline-start" />}
            Save
          </Button>
        </div>
      </form>
    </RowBlock>
  );
}
