import { useState } from "react";
import type { AcpConfig, AcpConfigOption, AcpDraftConfig } from "backend/src/acp/contract";
import { ChevronDownIcon, MoreHorizontalIcon } from "lucide-react";

import { ModelPicker } from "../model-picker";
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
import { InputGroupButton } from "@/components/ui/input-group";
import type { ModelOption } from "@/components/models/model-options";

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
/** Project the agent's vocabulary onto the shared Composer picker without Gateway presets. */
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
  return {
    model,
    reasoning,
    mode,
    models:
      model?.choices.map((choice): ModelOption => ({
        slug: choice.value,
        name: choice.name,
        author: null,
      })) ?? [],
    extra: config?.options.filter((option) => !primary.has(option.id)) ?? [],
  };
}

/** Agent-advertised Model, Reasoning, Mode and extra controls; never uses Gateway presets. */
export function AcpConfigControls({
  config,
  disabled,
  isOpen,
  onOpenChange,
  onConfigChange,
  onModeChange,
}: {
  config: AcpConfig | undefined;
  disabled?: boolean;
  isOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  onConfigChange: (configId: string, value: string | boolean) => void;
  onModeChange: (modeId: string) => void;
}) {
  const [localOpen, setLocalOpen] = useState(false);
  const { model, reasoning, mode, models, extra } = acpModelConfig(config);
  return (
    <>
      <ModelPicker
        variant="agent"
        models={models}
        isLoading={false}
        selectedModel={model?.currentValue}
        reasoningEffort={reasoning?.currentValue}
        reasoningOptions={reasoning?.choices}
        disabled={disabled}
        isOpen={isOpen ?? localOpen}
        onOpenChange={onOpenChange ?? setLocalOpen}
        onModelChange={(value) => {
          if (model) onConfigChange(model.id, value);
        }}
        onReasoningEffortChange={(value) => {
          if (reasoning) onConfigChange(reasoning.id, value);
        }}
      />
      {config?.modes ? (
        <ConfigSelect
          option={{
            type: "select",
            id: "mode",
            name: "Mode",
            currentValue: config.modes.currentModeId,
            choices: config.modes.available.map((entry) => ({ ...entry, value: entry.id })),
          }}
          disabled={disabled}
          onChange={onModeChange}
        />
      ) : mode?.type === "select" ? (
        <ConfigSelect
          option={mode}
          disabled={disabled}
          onChange={(value) => onConfigChange(mode.id, value)}
        />
      ) : null}
      {extra.length ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <InputGroupButton size="icon-xs" disabled={disabled} aria-label="Agent options">
              <MoreHorizontalIcon />
            </InputGroupButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="max-h-96 w-72">
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
      ) : null}
    </>
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

function ConfigSelect({
  option,
  disabled,
  onChange,
}: {
  option: SelectOption;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const selected = option.choices.find((choice) => choice.value === option.currentValue);
  return (
    <DropdownMenu open={isOpen} onOpenChange={setIsOpen}>
      <DropdownMenuTrigger asChild>
        <InputGroupButton
          size="xs"
          disabled={disabled || !option.choices.length}
          aria-label={`${option.name}: ${selected?.name ?? option.currentValue}`}
          className="max-w-60 min-w-0 shrink gap-1.5 text-muted-foreground hover:text-foreground"
        >
          <span className="truncate">{selected?.name ?? option.currentValue}</span>
          <ChevronDownIcon data-icon="inline-end" />
        </InputGroupButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-96 w-72">
        <DropdownMenuLabel>
          <OptionLabel name={option.name} description={option.description} />
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={option.currentValue}
          onValueChange={(value) => {
            onChange(value);
            setIsOpen(false);
          }}
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
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
