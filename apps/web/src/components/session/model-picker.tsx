import type { ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  BrainIcon,
  ChevronDownIcon,
  CpuIcon,
  GaugeIcon,
  LeafIcon,
  ListChecksIcon,
  RocketIcon,
  SettingsIcon,
  SparklesIcon,
  ZapIcon,
} from "lucide-react";

import { ProviderLogo } from "@/components/gateway/provider-logo";
import { ModelList } from "@/components/models/model-list";
import { useModelPreferences } from "@/components/models/model-preferences";
import {
  effortLabel,
  inferenceModeTier,
  reasoningEffortsFor,
  reasoningModesFor,
  type ModelProviderOption,
  type ModelOption,
  type ReasoningCapableModel,
} from "@/components/models/model-options";
import { CommandItem } from "@/components/ui/command";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { InputGroupButton } from "@/components/ui/input-group";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";

type PickerModel = ModelOption & ReasoningCapableModel;
type ReasoningOption = { value: string; name: string; description?: string };

/**
 * Picks the reasoning level to keep for a model: the current one when the model offers it,
 * otherwise `medium`, otherwise the model's first level. `undefined` when the model cannot reason.
 */
export function validReasoningEffort(model: PickerModel | undefined, effort: string) {
  const efforts = reasoningEffortsFor(model);
  if (efforts.length === 0) return undefined;
  if (efforts.includes(effort)) return effort;
  if (efforts.includes("medium")) return "medium";
  return efforts[0];
}

/**
 * The Composer's Model control (`docs/Interface_Design.md` §2): one trigger shows the model name
 * and its reasoning level; the popover searches the workspace's models and its footer picks the
 * inference provider and the reasoning amount (plus a token budget when the model accepts one).
 * Fully controlled, including whether the popover is open (so other Session controls can open
 * it); selecting a model keeps the provider and effort valid for it and closes it. The user's
 * pinned models list first and hidden ones drop out (`useModelPreferences`); rows pin inline and
 * `Manage models`, the last option in the list, opens Settings → Models. Agent models pin under
 * `pinScope` (their IDs are not Gateway slugs) and have no hidden list or `Manage models`.
 */
export function ModelPicker({
  models,
  isLoading,
  selectedModel,
  selectedProvider,
  reasoningEffort,
  serviceTier,
  inferenceMode,
  reasoningBudget,
  onModelChange,
  onProviderChange,
  onServiceTierChange,
  onInferenceModeChange,
  onReasoningEffortChange,
  onReasoningBudgetChange,
  isOpen,
  onOpenChange,
  variant = "gateway",
  reasoningOptions,
  agentMode,
  agentOptions,
  pinScope,
  disabled = false,
}: {
  models: PickerModel[] | undefined;
  isLoading: boolean;
  selectedModel: string | undefined;
  selectedProvider?: string;
  /** Effective level for the selected model; `undefined` when it cannot reason. */
  reasoningEffort: string | undefined;
  serviceTier?: string;
  inferenceMode?: string;
  reasoningBudget?: number;
  onModelChange: (slug: string) => void;
  onProviderChange?: (providerId: string) => void;
  onServiceTierChange?: (tier: string | undefined) => void;
  onInferenceModeChange?: (mode: string | undefined) => void;
  onReasoningEffortChange: (effort: string) => void;
  onReasoningBudgetChange?: (budget: number | undefined) => void;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  /** Agent choices share the picker without Gateway presets, hidden models or `Manage models`. */
  variant?: "gateway" | "agent";
  reasoningOptions?: readonly ReasoningOption[];
  agentMode?: {
    value: string;
    choices: readonly ReasoningOption[];
    onChange: (value: string) => void;
  };
  agentOptions?: ReactNode;
  /** Prefix that keeps agent model pins apart from Gateway slugs; agents without it cannot pin. */
  pinScope?: string;
  disabled?: boolean;
}) {
  const navigate = useNavigate();
  const { pinnedModels, hiddenModels, setModelPinned } = useModelPreferences();
  const model = models?.find((candidate) => candidate.slug === selectedModel);
  const modeTier = inferenceModeTier(
    model?.providers
      ?.find((provider) => provider.id === selectedProvider)
      ?.inference_modes?.find((item) => item.id === inferenceMode),
  );
  const hasModels = Boolean(models?.length);
  // Gateway pins are bare slugs; agent pins live under their scope and are read back without it.
  const pinPrefix = variant === "gateway" ? "" : pinScope;
  const pinnedSlugs =
    pinPrefix === undefined
      ? undefined
      : pinnedModels.flatMap((pinned) =>
          pinned.startsWith(pinPrefix) ? [pinned.slice(pinPrefix.length)] : [],
        );

  // Keep the provider and effort valid for the new model instead of silently sending stale ones.
  function selectModel(next: PickerModel) {
    onModelChange(next.slug);
    if (next.slug !== selectedModel) {
      onServiceTierChange?.(undefined);
      onInferenceModeChange?.(undefined);
    }
    // Agents resolve the provider together with the model, in one config change.
    const firstProvider = next.providers?.[0]?.id;
    if (
      variant === "gateway" &&
      firstProvider &&
      !next.providers?.some((provider) => provider.id === selectedProvider)
    ) {
      onProviderChange?.(firstProvider);
    }
    const nextEffort =
      variant === "gateway" ? validReasoningEffort(next, reasoningEffort ?? "medium") : undefined;
    if (nextEffort && nextEffort !== reasoningEffort) {
      onReasoningEffortChange(nextEffort);
    }
    onOpenChange(false);
  }

  if (isLoading) {
    return (
      <InputGroupButton size="xs" disabled aria-label="Loading models">
        <Skeleton className="h-3.5 w-28 sm:w-40" />
      </InputGroupButton>
    );
  }

  let modelName = "Select model";
  if (model) {
    modelName = model.name;
  } else if (!hasModels) {
    modelName = variant === "agent" ? "Agent default" : "No models available";
  }

  return (
    <Popover open={isOpen && !disabled} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <InputGroupButton
          size="xs"
          disabled={
            disabled ||
            (!hasModels && !reasoningOptions?.length && !agentMode?.choices.length && !agentOptions)
          }
          aria-label={`Model: ${modelName}`}
          className="max-w-60 min-w-0 shrink gap-1.5 text-muted-foreground hover:text-foreground"
        >
          <span className="truncate">{modelName}</span>
          {reasoningEffort ? (
            <span className="shrink-0 text-subtle-foreground">
              {reasoningOptions?.find((option) => option.value === reasoningEffort)?.name ??
                effortLabel(reasoningEffort)}
            </span>
          ) : null}
          {agentMode ? (
            <span className="shrink-0 text-subtle-foreground">
              {agentMode.choices.find((option) => option.value === agentMode.value)?.name ??
                agentMode.value}
            </span>
          ) : null}
          <ChevronDownIcon data-icon="inline-end" />
        </InputGroupButton>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-[min(calc(100vw-2rem),26rem)] gap-0 overflow-hidden rounded-2xl p-0"
      >
        <ModelList
          models={models ?? []}
          selectedSlug={selectedModel}
          onSelect={selectModel}
          pinnedSlugs={pinnedSlugs}
          noModelsMessage={variant === "agent" ? "This agent chooses its own model." : undefined}
          hiddenSlugs={variant === "gateway" ? hiddenModels : undefined}
          onTogglePin={
            pinPrefix === undefined
              ? undefined
              : (target, pinned) => void setModelPinned(`${pinPrefix}${target.slug}`, pinned)
          }
          extraItems={
            variant === "gateway" ? (
              <CommandItem
                value="manage-models"
                keywords={["Manage models", "settings", "pin", "hide"]}
                className="text-muted-foreground"
                onSelect={() => {
                  onOpenChange(false);
                  void navigate({ to: "/settings/models" });
                }}
              >
                <SettingsIcon />
                Manage models
              </CommandItem>
            ) : undefined
          }
          footer={
            <div className="flex flex-wrap items-center gap-2 border-t p-2">
              {variant === "gateway" ? (
                <>
                  <ProviderDropdown
                    providers={model?.providers ?? []}
                    providerId={selectedProvider}
                    onProviderChange={(provider) => {
                      if (provider !== selectedProvider) {
                        onServiceTierChange?.(undefined);
                        onInferenceModeChange?.(undefined);
                      }
                      onProviderChange?.(provider);
                    }}
                  />
                  <ServiceTierDropdown
                    tiers={
                      model?.providers?.find((provider) => provider.id === selectedProvider)
                        ?.service_tiers ?? []
                    }
                    tier={serviceTier ?? modeTier}
                    onChange={(tier) => {
                      onServiceTierChange?.(tier);
                      const currentMode = model?.providers
                        ?.find((provider) => provider.id === selectedProvider)
                        ?.inference_modes?.find((item) => item.id === inferenceMode);
                      if (inferenceModeTier(currentMode)) onInferenceModeChange?.(undefined);
                    }}
                  />
                  <InferenceModeDropdown
                    modes={reasoningModesFor(
                      model?.providers?.find((provider) => provider.id === selectedProvider)
                        ?.inference_modes,
                    )}
                    mode={inferenceMode}
                    onChange={(mode) => {
                      onInferenceModeChange?.(mode);
                      const nextMode = model?.providers
                        ?.find((provider) => provider.id === selectedProvider)
                        ?.inference_modes?.find((item) => item.id === mode);
                      if (inferenceModeTier(nextMode)) onServiceTierChange?.(undefined);
                    }}
                  />
                </>
              ) : model?.providers?.length && onProviderChange ? (
                <ProviderDropdown
                  providers={model.providers}
                  providerId={selectedProvider}
                  onProviderChange={onProviderChange}
                />
              ) : null}
              {variant === "agent" && agentMode?.choices.length ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button type="button" aria-label="Mode" className={footerTriggerClassName}>
                      <ListChecksIcon data-icon="inline-start" />
                      {agentMode.choices.find((option) => option.value === agentMode.value)?.name ??
                        agentMode.value}
                      <ChevronDownIcon className="size-3 shrink-0" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    <DropdownMenuLabel>Mode</DropdownMenuLabel>
                    <DropdownMenuRadioGroup
                      value={agentMode.value}
                      onValueChange={agentMode.onChange}
                    >
                      {agentMode.choices.map((option) => (
                        <DropdownMenuRadioItem key={option.value} value={option.value}>
                          <span title={option.description}>{option.name}</span>
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
              <ReasoningDropdown
                model={model}
                options={reasoningOptions}
                isAgent={variant === "agent"}
                effort={reasoningEffort}
                budget={reasoningBudget}
                onEffortChange={onReasoningEffortChange}
                onBudgetChange={variant === "gateway" ? onReasoningBudgetChange : undefined}
              />
              {variant === "agent" ? agentOptions : null}
            </div>
          }
        />
      </PopoverContent>
    </Popover>
  );
}

export const footerTriggerClassName =
  "flex h-8 min-w-0 items-center gap-1.5 rounded-xl border bg-background px-2 text-xs text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/30 disabled:pointer-events-none disabled:opacity-50 [&>svg[data-icon]]:size-3.5 [&>svg[data-icon]]:shrink-0";

function serviceTierIcon(tier: string | undefined) {
  if (tier === "flex") return LeafIcon;
  if (tier === "priority" || tier === "fast") return ZapIcon;
  if (tier === "ultrafast") return RocketIcon;
  return GaugeIcon;
}

function ServiceTierDropdown({
  tiers,
  tier,
  onChange,
}: {
  tiers: NonNullable<ModelProviderOption["service_tiers"]>;
  tier: string | undefined;
  onChange: (tier: string | undefined) => void;
}) {
  const TierIcon = serviceTierIcon(tier);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" aria-label="Service tier" className={footerTriggerClassName}>
          <TierIcon aria-hidden="true" data-icon="inline-start" />
          <span>{tier ? effortLabel(tier) : "Default"}</span>
          <ChevronDownIcon className="size-3 shrink-0" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuLabel>Service tier</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={tier ?? "default"}
          onValueChange={(value) => onChange(value)}
        >
          <DropdownMenuRadioItem value="default">
            <GaugeIcon aria-hidden="true" />
            Default
          </DropdownMenuRadioItem>
          {tiers
            .filter((item) => item.id !== "auto" && item.id !== "default")
            .map((item) => {
              const Icon = serviceTierIcon(item.id);
              return (
                <DropdownMenuRadioItem key={item.id} value={item.id}>
                  <Icon aria-hidden="true" />
                  {effortLabel(item.id)}
                </DropdownMenuRadioItem>
              );
            })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function InferenceModeDropdown({
  modes,
  mode,
  onChange,
}: {
  modes: NonNullable<ModelProviderOption["inference_modes"]>;
  mode: string | undefined;
  onChange: (mode: string | undefined) => void;
}) {
  if (modes.length === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" aria-label="Inference mode" className={footerTriggerClassName}>
          {mode ? (
            <SparklesIcon aria-hidden="true" data-icon="inline-start" />
          ) : (
            <CpuIcon aria-hidden="true" data-icon="inline-start" />
          )}
          <span>{mode ? "Pro mode" : "Standard mode"}</span>
          <ChevronDownIcon className="size-3 shrink-0" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-44">
        <DropdownMenuLabel>Inference mode</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={mode ?? ""}
          onValueChange={(value) => onChange(value || undefined)}
        >
          <DropdownMenuRadioItem value="">
            <CpuIcon aria-hidden="true" />
            Standard mode
          </DropdownMenuRadioItem>
          {modes.map((item) => (
            <DropdownMenuRadioItem key={item.id} value={item.id}>
              <SparklesIcon aria-hidden="true" />
              Pro mode
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ProviderDropdown({
  providers,
  providerId,
  onProviderChange,
}: {
  providers: ModelProviderOption[];
  providerId: string | undefined;
  onProviderChange: (providerId: string) => void;
}) {
  const selected = providers.find((provider) => provider.id === providerId) ?? providers[0];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Inference provider"
          disabled={providers.length === 0}
          className={footerTriggerClassName}
        >
          {selected ? <ProviderLogo slug={selected.logo} className="size-4" /> : null}
          <span className="max-w-40 truncate">{selected?.name ?? "No provider"}</span>
          <ChevronDownIcon className="size-3 shrink-0" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-60">
        <DropdownMenuLabel>Inference provider</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={selected?.id} onValueChange={onProviderChange}>
          {providers.map((provider) => (
            <DropdownMenuRadioItem key={provider.id} value={provider.id}>
              <ProviderLogo slug={provider.logo} className="size-4" />
              {provider.name}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ReasoningDropdown({
  model,
  options,
  isAgent,
  effort,
  budget,
  onEffortChange,
  onBudgetChange,
}: {
  model: PickerModel | undefined;
  options?: readonly ReasoningOption[];
  isAgent: boolean;
  effort: string | undefined;
  budget: number | undefined;
  onEffortChange: (effort: string) => void;
  onBudgetChange?: (budget: number | undefined) => void;
}) {
  const efforts =
    options ??
    reasoningEffortsFor(model).map((value) => ({
      value,
      name: effortLabel(value),
      description: undefined,
    }));

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" aria-label="Reasoning amount" className={footerTriggerClassName}>
          <BrainIcon className="size-3.5 shrink-0" />
          {efforts.find((option) => option.value === effort)?.name ??
            (effort ? effortLabel(effort) : "Off")}
          <ChevronDownIcon className="size-3 shrink-0" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>Reasoning amount</DropdownMenuLabel>
        {efforts.length > 0 ? (
          <DropdownMenuRadioGroup value={effort} onValueChange={onEffortChange}>
            {efforts.map((option) => (
              <DropdownMenuRadioItem key={option.value} value={option.value}>
                <BrainIcon aria-hidden="true" />
                <span title={option.description}>{option.name}</span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        ) : (
          <DropdownMenuItem disabled>
            {isAgent
              ? "This agent does not offer reasoning levels."
              : "This model does not support reasoning."}
          </DropdownMenuItem>
        )}

        {model?.features?.reasoning_budget && onBudgetChange ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Budget</DropdownMenuLabel>
            <div className="px-1 pb-1">
              <Input
                type="number"
                min={1}
                aria-label="Reasoning budget"
                placeholder="Token budget"
                className="h-8 rounded-xl text-xs tabular-nums"
                value={budget ?? ""}
                // Typing in a menu would otherwise trigger the menu's typeahead.
                onKeyDown={(event) => event.stopPropagation()}
                onChange={(event) => {
                  const value = event.currentTarget.valueAsNumber;
                  onBudgetChange(Number.isFinite(value) ? value : undefined);
                }}
              />
            </div>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
