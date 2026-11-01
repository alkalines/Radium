import { useMemo, useState } from "react";
import type { AcpConfig, AcpConfigOption, AcpDraftConfig } from "backend/src/acp/contract";
import { ChevronDownIcon, SlidersHorizontalIcon } from "lucide-react";

import { footerTriggerClassName, ModelPicker } from "../model-picker";
import { inferModelAuthor } from "./model-author";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { modelDisplayName, type ModelOption } from "@/components/models/model-options";
import { providerDisplayName } from "@/components/models/provider-names";

const byDisplayName = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

type SelectOption = Extract<AcpConfigOption, { type: "select" }>;

/** Overlay choices made before session/new without mutating the agent's defaults. */
export function applyAcpDraft(
  config: AcpConfig | undefined,
  draft: AcpDraftConfig | undefined,
): AcpConfig | undefined {
  if (!config || !draft) return config;
  return {
    ...config,
    options: config.options.map((option) => {
      const value = draft.config.find((entry) => entry.configId === option.id)?.value;
      if (option.type === "boolean" && typeof value === "boolean")
        return { ...option, currentValue: value };
      if (
        option.type === "select" &&
        typeof value === "string" &&
        option.choices.some((choice) => choice.value === value)
      )
        return { ...option, currentValue: value };
      return option;
    }),
    modes:
      config.modes &&
      draft.modeId &&
      config.modes.available.some((mode) => mode.id === draft.modeId)
        ? { ...config.modes, currentModeId: draft.modeId }
        : config.modes,
  };
}

/** One agent choice of a unified model: the provider it routes through and the value to send. */
type ModelVariant = { providerId: string | undefined; value: string };

/**
 * The same model offered by several providers shares one row: the last ID segment, lowercased,
 * without a `~` alias marker or `-YYYYMMDD` date, with `.` read as `-` (`claude-sonnet-4.6` and
 * `claude-sonnet-4-6` match).
 */
function modelKey(value: string) {
  const id = value.split("/").pop() ?? value;
  return id
    .toLowerCase()
    .replace(/^~/, "")
    .replace(/[-_]\d{8}$/, "")
    .replaceAll(".", "-");
}

/** The name most providers use, preferring the more descriptive one on a tie. */
function commonName(names: string[]) {
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)[0]![0];
}

/**
 * Project the agent's vocabulary onto the shared Composer picker without Gateway presets. Model
 * choices routed through different providers (`provider/model` values, as OpenCode sends them)
 * become one model with those providers, like Gateway models; `valueFor` maps a model and
 * provider back to the agent's choice.
 */
export function acpModelConfig(config: AcpConfig | undefined) {
  const model = config?.options.find(
    (option): option is SelectOption => option.category === "model" && option.type === "select",
  );
  const reasoning = config?.options.find(
    (option): option is SelectOption =>
      option.category === "thought_level" && option.type === "select",
  );
  const mode = config?.options.find(
    (option): option is SelectOption => option.category === "mode" && option.type === "select",
  );
  const primary = new Set([model?.id, reasoning?.id, mode?.id]);

  const groups = new Map<
    string,
    { variants: ModelVariant[]; names: string[]; choices: SelectOption["choices"] }
  >();
  const keyByValue = new Map<string, string>();
  for (const choice of model?.choices ?? []) {
    const slash = choice.value.indexOf("/");
    const providerId = slash > 0 ? choice.value.slice(0, slash) : choice.group;
    const prefix = slash > 0 ? `${choice.value.slice(0, slash)}/` : "";
    const name =
      prefix && choice.name.startsWith(prefix) ? choice.name.slice(prefix.length) : choice.name;
    let key = modelKey(choice.value);
    // Two choices of one provider never merge: each keeps its own row under its raw value.
    if (groups.get(key)?.variants.some((variant) => variant.providerId === providerId))
      key = choice.value;
    const group = groups.get(key) ?? { variants: [], names: [], choices: [] };
    group.variants.push({ providerId, value: choice.value });
    group.names.push(name);
    group.choices.push(choice);
    groups.set(key, group);
    keyByValue.set(choice.value, key);
  }

  const models = [...groups]
    .map(([key, group]): ModelOption => {
      const providers = group.variants.flatMap(({ providerId }, index) =>
        providerId
          ? [
              {
                id: providerId,
                name: group.choices[index]!.group ?? providerDisplayName(providerId),
                logo: providerId,
              },
            ]
          : [],
      );
      return {
        slug: key,
        name: commonName(group.names),
        author:
          group.choices
            .map((choice) => inferModelAuthor(choice.value, choice.name))
            .find((author) => author !== null) ?? null,
        providers: providers.length ? providers : undefined,
      };
    })
    // Alphabetical as shown (`Lab: Model`), with version numbers in numeric order.
    .sort((a, b) => byDisplayName.compare(modelDisplayName(a), modelDisplayName(b)));

  const selectedModel = model ? keyByValue.get(model.currentValue) : undefined;
  const selectedProvider = selectedModel
    ? groups.get(selectedModel)?.variants.find((variant) => variant.value === model?.currentValue)
        ?.providerId
    : undefined;

  /** The agent value for a model, through `providerId` when it offers that provider. */
  function valueFor(key: string, providerId: string | undefined) {
    const variants = groups.get(key)?.variants ?? [];
    return (variants.find((variant) => variant.providerId === providerId) ?? variants[0])?.value;
  }

  return {
    model,
    reasoning,
    mode,
    models,
    selectedModel,
    selectedProvider,
    valueFor,
    extra: config?.options.filter((option) => !primary.has(option.id)) ?? [],
  };
}

/**
 * Agent-advertised Model, Reasoning, Mode and extra controls; never uses Gateway presets. Pins are
 * the user's model preferences scoped to `agentId`, since agent model IDs are not Gateway slugs.
 */
export function AcpConfigControls({
  agentId,
  config,
  disabled,
  isOpen,
  onOpenChange,
  onConfigChange,
  onModeChange,
}: {
  agentId: string | undefined;
  config: AcpConfig | undefined;
  disabled?: boolean;
  isOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  onConfigChange: (configId: string, value: string | boolean) => void;
  onModeChange: (modeId: string) => void;
}) {
  const [localOpen, setLocalOpen] = useState(false);
  const { model, reasoning, mode, models, selectedModel, selectedProvider, valueFor, extra } =
    useMemo(() => acpModelConfig(config), [config]);
  function selectValue(value: string | undefined) {
    if (model && value && value !== model.currentValue) onConfigChange(model.id, value);
  }
  return (
    <ModelPicker
      variant="agent"
      pinScope={agentId ? `acp:${agentId}:` : undefined}
      models={models}
      isLoading={false}
      selectedModel={selectedModel}
      selectedProvider={selectedProvider}
      reasoningEffort={reasoning?.currentValue}
      reasoningOptions={reasoning?.choices ?? []}
      disabled={disabled}
      agentMode={
        config?.modes
          ? {
              value: config.modes.currentModeId,
              choices: config.modes.available.map((entry) => ({ ...entry, value: entry.id })),
              onChange: onModeChange,
            }
          : mode
            ? {
                value: mode.currentValue,
                choices: mode.choices,
                onChange: (value) => onConfigChange(mode.id, value),
              }
            : undefined
      }
      agentOptions={
        extra.length ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" aria-label="Options" className={footerTriggerClassName}>
                <SlidersHorizontalIcon data-icon="inline-start" />
                Options
                <ChevronDownIcon className="size-3" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-h-96 w-72 overflow-y-auto">
              {extra.map((option, index) => (
                <DropdownMenuGroup key={option.id}>
                  {index ? <DropdownMenuSeparator /> : null}
                  {option.type === "boolean" ? (
                    <DropdownMenuCheckboxItem
                      checked={option.currentValue}
                      onCheckedChange={(value) => onConfigChange(option.id, value)}
                    >
                      <OptionLabel name={option.name} description={option.description} />
                    </DropdownMenuCheckboxItem>
                  ) : (
                    <>
                      <DropdownMenuLabel>
                        <OptionLabel name={option.name} description={option.description} />
                      </DropdownMenuLabel>
                      <DropdownMenuRadioGroup
                        value={option.currentValue}
                        onValueChange={(value) => onConfigChange(option.id, value)}
                      >
                        {choiceGroups(option).map(([group, choices]) => (
                          <DropdownMenuGroup key={group}>
                            {group ? <DropdownMenuLabel>{group}</DropdownMenuLabel> : null}
                            {choices.map((choice) => (
                              <DropdownMenuRadioItem key={choice.value} value={choice.value}>
                                <OptionLabel name={choice.name} description={choice.description} />
                              </DropdownMenuRadioItem>
                            ))}
                          </DropdownMenuGroup>
                        ))}
                      </DropdownMenuRadioGroup>
                    </>
                  )}
                </DropdownMenuGroup>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : undefined
      }
      isOpen={isOpen ?? localOpen}
      onOpenChange={onOpenChange ?? setLocalOpen}
      onModelChange={(key) => selectValue(valueFor(key, selectedProvider))}
      onProviderChange={(providerId) => {
        if (selectedModel) selectValue(valueFor(selectedModel, providerId));
      }}
      onReasoningEffortChange={(value) => {
        if (reasoning) onConfigChange(reasoning.id, value);
      }}
    />
  );
}

function choiceGroups(option: SelectOption) {
  const groups = new Map<string, SelectOption["choices"]>();
  for (const choice of option.choices) {
    const group = choice.group ?? "";
    const entries = groups.get(group);
    if (entries) entries.push(choice);
    else groups.set(group, [choice]);
  }
  return [...groups];
}

function OptionLabel({ name, description }: { name: string; description?: string }) {
  return (
    <span className="flex min-w-0 flex-col">
      <span>{name}</span>
      {description ? <span className="text-xs text-muted-foreground">{description}</span> : null}
    </span>
  );
}
