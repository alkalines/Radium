import { useState } from "react";
import { BrainIcon, ChevronDownIcon } from "lucide-react";

import { ProviderLogo } from "@/components/gateway/provider-logo";
import { ModelList } from "@/components/models/model-list";
import {
  effortLabel,
  reasoningEffortsFor,
  type AvailableModel,
  type ModelProviderOption,
} from "@/components/models/model-options";
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
 * Fully controlled; selecting a model keeps the provider and effort valid for it.
 */
export function ModelPicker({
  models,
  isLoading,
  selectedModel,
  selectedProvider,
  reasoningEffort,
  reasoningBudget,
  onModelChange,
  onProviderChange,
  onReasoningEffortChange,
  onReasoningBudgetChange,
}: {
  models: AvailableModel[] | undefined;
  isLoading: boolean;
  selectedModel: string | undefined;
  selectedProvider: string | undefined;
  /** Effective level for the selected model; `undefined` when it cannot reason. */
  reasoningEffort: string | undefined;
  reasoningBudget: number | undefined;
  onModelChange: (slug: string) => void;
  onProviderChange: (providerId: string) => void;
  onReasoningEffortChange: (effort: string) => void;
  onReasoningBudgetChange: (budget: number | undefined) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const model = models?.find((candidate) => candidate.slug === selectedModel);
  const hasModels = Boolean(models?.length);

  // Keep the provider and effort valid for the new model instead of silently sending stale ones.
  function selectModel(next: AvailableModel) {
    onModelChange(next.slug);
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
          footer={
            <div className="flex items-center justify-between gap-2 border-t p-2">
              <ProviderDropdown
                providers={model?.providers ?? []}
                providerId={selectedProvider}
                onProviderChange={onProviderChange}
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
  "flex h-8 min-w-0 items-center gap-1.5 rounded-xl border bg-background px-2 text-xs text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/30 disabled:pointer-events-none disabled:opacity-50";

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
