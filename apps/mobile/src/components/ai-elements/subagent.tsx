import { Bot } from "lucide-react-native";
import { View } from "react-native";
import { Text } from "@/components/ui/text";
import { Activity, type ActivityProps } from "./activity";

/** A nested agent run. The caller supplies its activity and result, not private hidden reasoning. */
export function Subagent({
  model,
  prompt,
  result,
  children,
  ...props
}: ActivityProps & { model?: string; prompt?: string; result?: string }) {
  return (
    <Activity icon={Bot} keepMounted {...props}>
      <View className="gap-3">
        {model && (
          <Text className="self-start rounded-md bg-secondary px-2 py-1 text-xs text-secondary-foreground">
            {model}
          </Text>
        )}
        {prompt && <Text className="text-sm text-muted-foreground">{prompt}</Text>}
        {children}
        {result && <Text className="text-sm">{result}</Text>}
      </View>
    </Activity>
  );
}
