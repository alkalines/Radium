import * as React from "react";
import { View } from "react-native";
import { cn } from "@/lib/utils";

const AlignmentContext = React.createContext<"start" | "end">("start");

/** One turn, aligned by sender rather than by a hard-coded role. */
export function Message({
  align = "start",
  className,
  ...props
}: React.ComponentProps<typeof View> & { align?: "start" | "end" }) {
  return (
    <AlignmentContext.Provider value={align}>
      <View
        className={cn(
          "w-full flex-row items-end gap-2",
          align === "end" && "flex-row-reverse",
          className,
        )}
        {...props}
      />
    </AlignmentContext.Provider>
  );
}
/** Consecutive turns from the same sender. */
export function MessageGroup({ className, ...props }: React.ComponentProps<typeof View>) {
  return <View className={cn("gap-2", className)} {...props} />;
}
/** Sender avatar slot; supply Avatar with an accessible fallback. */
export function MessageAvatar({ className, ...props }: React.ComponentProps<typeof View>) {
  return <View className={cn("shrink-0", className)} {...props} />;
}
/** Header, body and footer stack constrained to the available message width. */
export function MessageContent({ className, ...props }: React.ComponentProps<typeof View>) {
  const align = React.useContext(AlignmentContext);
  return (
    <View
      className={cn(
        "min-w-0 max-w-full shrink gap-2",
        align === "end" ? "items-end" : "items-start",
        className,
      )}
      {...props}
    />
  );
}
/** Sender metadata above the message surface. */
export function MessageHeader({ className, ...props }: React.ComponentProps<typeof View>) {
  return <View className={cn("flex-row items-center gap-2 self-start", className)} {...props} />;
}
/** Actions or delivery metadata below the message surface. */
export function MessageFooter({ className, ...props }: React.ComponentProps<typeof View>) {
  return <View className={cn("flex-row items-center gap-1", className)} {...props} />;
}
