import * as React from "react";
import { View } from "react-native";
import { cn } from "@/lib/utils";

/** Conversation annotation or checkpoint divider, not agent activity. */
export function Marker({
  variant = "default",
  className,
  children,
  ...props
}: React.ComponentProps<typeof View> & { variant?: "default" | "border" | "separator" }) {
  return (
    <View
      className={cn(
        "w-full flex-row items-center justify-center gap-3 py-2",
        variant === "border" && "rounded-lg border border-border p-3",
        className,
      )}
      {...props}
    >
      {variant === "separator" && <View className="h-px flex-1 bg-border" />}
      {children}
      {variant === "separator" && <View className="h-px flex-1 bg-border" />}
    </View>
  );
}
/** Decorative checkpoint icon. */
export function MarkerIcon({ className, ...props }: React.ComponentProps<typeof View>) {
  return (
    <View
      className={cn("size-4", className)}
      {...props}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    />
  );
}
/** Annotation content; wrap text in the Reusables Text component. */
export function MarkerContent({ className, ...props }: React.ComponentProps<typeof View>) {
  return <View className={cn("shrink flex-row items-center gap-2", className)} {...props} />;
}
