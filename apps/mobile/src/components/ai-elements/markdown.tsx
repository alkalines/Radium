import * as React from "react";
import { View } from "react-native";
import { StreamdownText } from "react-native-streamdown";
import { useResolveClassNames } from "uniwind";
import { useReducedMotion } from "react-native-reanimated";
import { cn } from "@/lib/utils";
import { Text } from "@/components/ui/text";
import { openSourceUrl } from "./links";

/** Streaming Markdown rendered natively. Requires a development build and Worklets Bundle Mode. */
export function Markdown({
  children,
  className,
  ...props
}: Omit<React.ComponentProps<typeof StreamdownText>, "markdown"> & {
  children: string;
  className?: string;
}) {
  const colors = useResolveClassNames("text-foreground bg-muted");
  const color = typeof colors.color === "string" ? colors.color : undefined;
  const backgroundColor =
    typeof colors.backgroundColor === "string" ? colors.backgroundColor : undefined;
  const reduceMotion = useReducedMotion();
  const [linkError, setLinkError] = React.useState(false);
  return (
    <View className={cn("w-full min-w-0", className)}>
      <StreamdownText
        markdown={children}
        flavor="github"
        streamingAnimation={!reduceMotion}
        onLinkPress={async ({ url }) => {
          setLinkError(false);
          try {
            await openSourceUrl(url);
          } catch {
            setLinkError(true);
          }
        }}
        markdownStyle={{
          paragraph: {
            color,
            fontSize: 14,
          },
          h1: { color },
          h2: { color },
          h3: { color },
          h4: { color },
          h5: { color },
          h6: { color },
          list: { color, bulletColor: color },
          blockquote: { color },
          codeBlock: { color, backgroundColor },
          code: { color, backgroundColor },
          link: { color, underline: true },
          math: { color, backgroundColor },
          inlineMath: { color },
          table: {
            color,
            headerTextColor: color,
            headerBackgroundColor: backgroundColor,
            rowEvenBackgroundColor: backgroundColor,
            rowOddBackgroundColor: backgroundColor,
          },
        }}
        {...props}
      />
      {linkError && (
        <Text role="alert" className="text-sm text-destructive">
          Could not open this source link.
        </Text>
      )}
    </View>
  );
}
