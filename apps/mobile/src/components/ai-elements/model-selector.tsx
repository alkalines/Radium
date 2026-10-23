import * as React from "react";
import { Close as PopoverClose } from "@rn-primitives/popover";
import { Check, ChevronDown } from "lucide-react-native";
import { ScrollView, View } from "react-native";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Text } from "@/components/ui/text";

/** Caller-provided option; IDs can identify multiple configured accounts/endpoints for one provider. */
export type ModelOption = { value: string; label: string; provider?: string };
/** Current model/effort menu pattern, using touch-accessible Reusables popovers. No provider is hard-coded. */
export function ModelSelector({
  models,
  model,
  setModel,
  effort,
  setEffort,
  efforts = ["low", "medium", "high"],
  disabled = false,
}: {
  models: ModelOption[];
  model: string;
  setModel: (value: string) => void;
  effort?: string;
  setEffort?: (value: string) => void;
  efforts?: string[];
  disabled?: boolean;
}) {
  return (
    <View className="flex-row flex-wrap gap-1">
      <OptionMenu
        label="Model"
        value={model}
        options={models}
        onValueChange={setModel}
        disabled={disabled}
      />
      {setEffort && (
        <OptionMenu
          label="Effort"
          value={effort ?? ""}
          options={efforts.map((value) => ({ value, label: value }))}
          onValueChange={setEffort}
          disabled={disabled}
        />
      )}
    </View>
  );
}

function OptionMenu({
  label,
  value,
  options,
  onValueChange,
  disabled,
}: {
  label: string;
  value: string;
  options: ModelOption[];
  onValueChange: (value: string) => void;
  disabled: boolean;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled}
          accessibilityLabel={`${label}: ${options.find((option) => option.value === value)?.label ?? value}`}
        >
          <Text>{options.find((option) => option.value === value)?.label ?? label}</Text>
          <Icon as={ChevronDown} className="size-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start">
        <ScrollView
          className="max-h-80"
          contentContainerClassName="gap-1"
          accessibilityLabel={label}
        >
          {options.map((option, index) => (
            <React.Fragment key={option.value}>
              {option.provider && option.provider !== options[index - 1]?.provider && (
                <Text className="px-2 py-1 text-xs font-medium text-muted-foreground">
                  {option.provider}
                </Text>
              )}
              <PopoverClose asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="justify-start"
                  role="radio"
                  accessibilityState={{ checked: option.value === value }}
                  onPress={() => onValueChange(option.value)}
                >
                  <Text className="flex-1">{option.label}</Text>
                  {option.value === value && <Icon as={Check} className="size-4" />}
                </Button>
              </PopoverClose>
            </React.Fragment>
          ))}
        </ScrollView>
      </PopoverContent>
    </Popover>
  );
}
