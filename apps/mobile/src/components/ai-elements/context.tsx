import * as Progress from "@rn-primitives/progress";
import { View } from "react-native";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Text } from "@/components/ui/text";

/** Context-window usage. On touch screens the upstream hover card becomes a press popover. */
export function Context({ used, limit }: { used: number; limit: number }) {
  const valid = Number.isFinite(used) && Number.isFinite(limit) && used >= 0 && limit > 0;
  const percent = valid ? Math.round((used / limit) * 100) : 0;
  const progress = Math.min(100, Math.max(0, percent));
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm">
          <Text>{valid ? `${percent}% context` : "Context unavailable"}</Text>
        </Button>
      </PopoverTrigger>
      <PopoverContent>
        <View className="gap-3">
          <View className="flex-row items-center justify-between gap-3">
            <Text className="text-sm font-medium">Context</Text>
            <Text className="text-xs text-muted-foreground">
              {valid ? `${used} / ${limit}` : "No usage reported"}
            </Text>
          </View>
          <Progress.Root
            value={progress}
            max={100}
            accessibilityLabel="Context used"
            className="h-2 overflow-hidden rounded-full bg-muted"
          >
            <Progress.Indicator
              className="h-full rounded-full bg-primary"
              style={{ width: `${progress}%` }}
            />
          </Progress.Root>
        </View>
      </PopoverContent>
    </Popover>
  );
}
