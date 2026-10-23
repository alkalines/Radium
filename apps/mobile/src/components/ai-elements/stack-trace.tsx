import { CircleX } from "lucide-react-native";
import { Pressable, View } from "react-native";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";
import { Activity, type ActivityProps } from "./activity";

/** An error with its literal stack frames. File navigation is an explicit host-owned callback. */
export function StackTrace({
  stack,
  onFilePathClick,
  ...props
}: Omit<ActivityProps, "title" | "status"> & {
  stack: string;
  onFilePathClick?: (file: string, line: number, column: number) => void;
}) {
  const [error, ...frames] = stack.split("\n").map((line) => line.trim());
  return (
    <Activity title={`Failed: ${error}`} status="error" icon={CircleX} {...props}>
      <View className="gap-2 rounded-md bg-muted p-3">
        <Text selectable className="font-mono text-xs text-destructive">
          {error}
        </Text>
        {frames.map((frame, index) => {
          const match = frame.match(/(?:\(|@|\s)([^()]+):(\d+):(\d+)\)?$/);
          const label = (
            <Text
              selectable
              className={cn(
                "font-mono text-xs leading-5",
                frame.includes("node_modules") && "text-muted-foreground",
              )}
            >
              {frame}
            </Text>
          );
          return match && onFilePathClick ? (
            <Pressable
              key={index}
              role="link"
              className="min-h-11 justify-center"
              accessibilityLabel={`Open ${match[1]} at line ${match[2]}`}
              onPress={() => onFilePathClick(match[1], Number(match[2]), Number(match[3]))}
            >
              {label}
            </Pressable>
          ) : (
            <View key={index}>{label}</View>
          );
        })}
      </View>
    </Activity>
  );
}
