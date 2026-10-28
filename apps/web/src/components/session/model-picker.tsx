import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  BrainIcon,
  ChevronDownIcon,
  CpuIcon,
  GaugeIcon,
  LeafIcon,
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
  type AvailableModel,
  type ModelProviderOption,
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

/**
 * Picks the reasoning level to keep for a model: the current one when the model offers it,
 * otherwise `medium`, otherwise the model's first level. `undefined` when the model cannot reason.
 */
export function validReasoningEffort(model: AvailableModel | undefined, effort: string) {
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
 * Fully controlled; selecting a model keeps the provider and effort valid for it. The user's
 * pinned models list first and hidden ones drop out (`useModelPreferences`); rows pin inline and
 * `Manage models`, the last option in the list, opens Settings → Models.
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
}: {
  models: AvailableModel[] | undefined;
  isLoading: boolean;
  selectedModel: string | undefined;
  selectedProvider: string | undefined;
  /** Effective level for the selected model; `undefined` when it cannot reason. */
  reasoningEffort: string | undefined;
  serviceTier: string | undefined;
  inferenceMode: string | undefined;
  reasoningBudget: number | undefined;
  onModelChange: (slug: string) => void;
  onProviderChange: (providerId: string) => void;
  onServiceTierChange: (tier: string | undefined) => void;
  onInferenceModeChange: (mode: string | undefined) => void;
  onReasoningEffortChange: (effort: string) => void;
  onReasoningBudgetChange: (budget: number | undefined) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const navigate = useNavigate();
  const { pinnedModels, hiddenModels, setModelPinned } = useModelPreferences();
  const model = models?.find((candidate) => candidate.slug === selectedModel);
  const modeTier = inferenceModeTier(
    model?.providers
      .find((provider) => provider.id === selectedProvider)
      ?.inference_modes?.find((item) => item.id === inferenceMode),
  );
  const hasModels = Boolean(models?.length);

  // Keep the provider and effort valid for the new model instead of silently sending stale ones.
  function selectModel(next: AvailableModel) {
    onModelChange(next.slug);
    if (next.slug !== selectedModel) {
      onServiceTierChange(undefined);
      onInferenceModeChange(undefined);
    }
    const firstProvider = next.providers[0]?.id;
    if (firstProvider && !next.providers.some((provider) => provider.id === selectedProvider)) {
      onProviderChange(firstProvider);
    }
    const nextEffort = validReasoningEffort(next, reasoningEffort ?? "medium");
    if (nextEffort && nextEffort !== reasoningEffort) {
      onReasoningEffortChange(nextEffort);
    }
    setIsOpen(false);
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
    modelName = "No models available";
  }

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <InputGroupButton
          size="xs"
          disabled={!hasModels}
          aria-label={`Model: ${modelName}`}
          className="max-w-60 min-w-0 shrink gap-1.5 text-muted-foreground hover:text-foreground"
        >
          <span className="truncate">{modelName}</span>
          {reasoningEffort ? (
            <span className="shrink-0 text-subtle-foreground">{effortLabel(reasoningEffort)}</span>
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
          pinnedSlugs={pinnedModels}
          hiddenSlugs={hiddenModels}
          onTogglePin={(target, pinned) => void setModelPinned(target.slug, pinned)}
          extraItems={
            <CommandItem
              value="manage-models"
              keywords={["Manage models", "settings", "pin", "hide"]}
              className="text-muted-foreground"
              onSelect={() => {
                setIsOpen(false);
                void navigate({ to: "/settings/models" });
              }}
            >
              <SettingsIcon />
              Manage models
            </CommandItem>
          }
          footer={
            <div className="flex flex-wrap items-center gap-2 border-t p-2">
              <ProviderDropdown
                providers={model?.providers ?? []}
                providerId={selectedProvider}
                onProviderChange={(provider) => {
                  if (provider !== selectedProvider) {
                    onServiceTierChange(undefined);
                    onInferenceModeChange(undefined);
                  }
                  onProviderChange(provider);
                }}
              />
              <ServiceTierDropdown
                tiers={
                  model?.providers.find((provider) => provider.id === selectedProvider)
                    ?.service_tiers ?? []
                }
                tier={serviceTier ?? modeTier}
                onChange={(tier) => {
                  onServiceTierChange(tier);
                  const currentMode = model?.providers
                    .find((provider) => provider.id === selectedProvider)
                    ?.inference_modes?.find((item) => item.id === inferenceMode);
                  if (inferenceModeTier(currentMode)) onInferenceModeChange(undefined);
                }}
              />
              <InferenceModeDropdown
                modes={reasoningModesFor(
                  model?.providers.find((provider) => provider.id === selectedProvider)
                    ?.inference_modes,
                )}
                mode={inferenceMode}
                onChange={(mode) => {
                  onInferenceModeChange(mode);
                  const nextMode = model?.providers
                    .find((provider) => provider.id === selectedProvider)
                    ?.inference_modes?.find((item) => item.id === mode);
                  if (inferenceModeTier(nextMode)) onServiceTierChange(undefined);
                }}
              />
              <ReasoningDropdown
                model={model}
                effort={reasoningEffort}
                budget={reasoningBudget}
                onEffortChange={onReasoningEffortChange}
                onBudgetChange={onReasoningBudgetChange}
              />
            </div>
          }
        />
      </PopoverContent>
    </Popover>
  );
}

const footerTriggerClassName =
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
  effort,
  budget,
  onEffortChange,
  onBudgetChange,
}: {
  model: AvailableModel | undefined;
  effort: string | undefined;
  budget: number | undefined;
  onEffortChange: (effort: string) => void;
  onBudgetChange: (budget: number | undefined) => void;
}) {
  const efforts = reasoningEffortsFor(model);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" aria-label="Reasoning amount" className={footerTriggerClassName}>
          <BrainIcon className="size-3.5 shrink-0" />
          {effort ? effortLabel(effort) : "Off"}
          <ChevronDownIcon className="size-3 shrink-0" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>Reasoning amount</DropdownMenuLabel>
        {efforts.length > 0 ? (
          <DropdownMenuRadioGroup value={effort} onValueChange={onEffortChange}>
            {efforts.map((level) => (
              <DropdownMenuRadioItem key={level} value={level}>
                <BrainIcon aria-hidden="true" />
                {effortLabel(level)}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        ) : (
          <DropdownMenuItem disabled>This model does not support reasoning.</DropdownMenuItem>
        )}

        {model?.features?.reasoning_budget ? (
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
