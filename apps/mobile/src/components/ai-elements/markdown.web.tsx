import * as React from "react";
import { View } from "react-native";
import { Streamdown } from "streamdown";
import { cn } from "@/lib/utils";

/** Web counterpart; platform resolution keeps native Markdown modules out of web bundles. */
export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <View className={cn("w-full min-w-0", className)}>
      <Streamdown>{children}</Streamdown>
    </View>
  );
}
