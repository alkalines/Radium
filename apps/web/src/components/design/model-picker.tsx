import { useState } from "react";
import { BrainIcon, ChevronDownIcon } from "lucide-react";

import { ProviderLogo } from "@/components/gateway/provider-logo";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
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
import { demoModels, type DemoModel, type DemoModelProvider } from "./demo-data";

/**
 * Composer model control, carried over from the Chatroom prompt input: one trigger shows the model
 * and its reasoning level; the picker searches models (lab logo, name, serving providers) and its
 * footer picks the inference provider and reasoning amount for the selected model.
 */
export function ModelPicker() {
  const [isOpen, setIsOpen] = useState(false);
  const [modelId, setModelId] = useState(demoModels[0].id);
  const [providerId, setProviderId] = useState(demoModels[0].providers[0].id);
  const [effort, setEffort] = useState("medium");
  const [budget, setBudget] = useState<number | undefined>(undefined);
  const model = demoModels.find((candidate) => candidate.id === modelId) ?? demoModels[0];
  const supportsReasoning = model.efforts.length > 0;

  // Keep the provider and effort valid for the new model instead of silently sending stale ones.
  function selectModel(next: DemoModel) {
    setModelId(next.id);
    if (!next.providers.some((provider) => provider.id === providerId)) {
      setProviderId(next.providers[0].id);
    }
    if (next.efforts.length > 0 && !next.efforts.includes(effort)) {
      setEffort(next.efforts.includes("medium") ? "medium" : next.efforts[0]);
    }
    setIsOpen(false);
  }

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <InputGroupButton
          size="xs"
          aria-label={`Model: ${model.name}`}
          className="max-w-60 min-w-0 gap-1.5 text-muted-foreground hover:text-foreground"
        >
          <span className="truncate">{model.name}</span>
          {supportsReasoning ? (
            <span className="shrink-0 text-subtle-foreground">{effortLabel(effort)}</span>
          ) : null}
          <ChevronDownIcon data-icon="inline-end" />
        </InputGroupButton>
      </PopoverTrigger>
      <PopoverContent
        data-design="harness"
        align="end"
        className="w-[min(calc(100vw-2rem),26rem)] gap-0 overflow-hidden rounded-2xl p-0"
      >
        <Command className="rounded-none bg-transparent">
          <CommandInput placeholder="Search models…" />
          <CommandList>
            <CommandEmpty>No models found.</CommandEmpty>
            <CommandGroup heading="Models">
              {demoModels.map((candidate) => (
                <CommandItem
                  key={candidate.id}
                  value={candidate.id}
                  keywords={[
                    candidate.name,
                    candidate.author.name,
                    ...candidate.providers.map((provider) => provider.name),
                  ]}
                  data-checked={candidate.id === modelId}
                  onSelect={() => selectModel(candidate)}
                >
                  <ProviderLogo variant="labs" slug={candidate.author.slug} className="size-5" />
                  <span className="min-w-0 flex-1 truncate">
                    <span className="text-muted-foreground">{candidate.author.name}: </span>
                    {candidate.name}
                  </span>
                  <ProviderLogos providers={candidate.providers} />
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>

        <div className="flex items-center justify-between gap-2 border-t p-2">
          <ProviderDropdown
            providers={model.providers}
            providerId={providerId}
            onProviderChange={setProviderId}
          />
          <ReasoningDropdown
            model={model}
            effort={effort}
            budget={budget}
            onEffortChange={setEffort}
            onBudgetChange={setBudget}
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}

function effortLabel(effort: string) {
  if (effort === "none") return "Off";
  return effort.charAt(0).toUpperCase() + effort.slice(1);
}

/** Overlapping logos of every upstream that can serve the model. */
function ProviderLogos({ providers }: { providers: DemoModelProvider[] }) {
  const logos = [...new Set(providers.map((provider) => provider.logo))];

  return (
    <span
      className="flex shrink-0 -space-x-1"
      title={providers.map((provider) => provider.name).join(", ")}
    >
      {logos.map((logo) => (
        <ProviderLogo key={logo} slug={logo} className="size-4" />
      ))}
    </span>
  );
}

const footerTriggerClassName =
  "flex h-8 min-w-0 items-center gap-1.5 rounded-xl border bg-background px-2 text-xs text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/30";

function ProviderDropdown({
  providers,
  providerId,
  onProviderChange,
}: {
  providers: DemoModelProvider[];
  providerId: string;
  onProviderChange: (providerId: string) => void;
}) {
  const selected = providers.find((provider) => provider.id === providerId) ?? providers[0];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" aria-label="Inference provider" className={footerTriggerClassName}>
          <ProviderLogo slug={selected.logo} className="size-4" />
          <span className="max-w-40 truncate">{selected.name}</span>
          <ChevronDownIcon className="size-3 shrink-0" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent data-design="harness" align="start" className="w-60">
        <DropdownMenuLabel>Inference provider</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={selected.id} onValueChange={onProviderChange}>
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
  model: DemoModel;
  effort: string;
  budget: number | undefined;
  onEffortChange: (effort: string) => void;
  onBudgetChange: (budget: number | undefined) => void;
}) {
  const supportsReasoning = model.efforts.length > 0;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" aria-label="Reasoning amount" className={footerTriggerClassName}>
          <BrainIcon className="size-3.5 shrink-0" />
          {supportsReasoning ? effortLabel(effort) : "Off"}
          <ChevronDownIcon className="size-3 shrink-0" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent data-design="harness" align="end" className="w-56">
        <DropdownMenuLabel>Reasoning amount</DropdownMenuLabel>
        {supportsReasoning ? (
          <DropdownMenuRadioGroup value={effort} onValueChange={onEffortChange}>
            {model.efforts.map((level) => (
              <DropdownMenuRadioItem key={level} value={level}>
                {effortLabel(level)}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        ) : (
          <DropdownMenuItem disabled>This model does not support reasoning.</DropdownMenuItem>
        )}

        {model.reasoningBudget ? (
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
