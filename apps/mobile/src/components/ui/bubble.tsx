import * as React from "react";
import { View } from "react-native";
import { Text, TextClassContext } from "@/components/ui/text";
import { cn } from "@/lib/utils";

const variants = {
  default: "bg-primary",
  secondary: "bg-secondary",
  muted: "bg-muted",
  tinted: "bg-primary/10",
  outline: "border border-border",
  ghost: "bg-transparent",
  destructive: "bg-destructive",
};
/** Message surface; keeps the current shadcn align and variant values. */
export function Bubble({
  align = "start",
  variant = "default",
  className,
  ...props
}: React.ComponentProps<typeof View> & {
  align?: "start" | "end";
  variant?: keyof typeof variants;
}) {
  return (
    <TextClassContext.Provider
      value={
        variant === "default" || variant === "destructive"
          ? "text-primary-foreground"
          : "text-foreground"
      }
    >
      <View
        className={cn(
          "max-w-full rounded-2xl px-4 py-3",
          align === "end" ? "self-end" : "self-start",
          variants[variant],
          className,
        )}
        {...props}
      />
    </TextClassContext.Provider>
  );
}
/** Bubble text. Rich content can compose Text children or a Markdown sibling. */
export function BubbleContent({ className, ...props }: React.ComponentProps<typeof Text>) {
  return <Text className={cn("text-sm leading-6", className)} {...props} />;
}
/** Consecutive message surfaces. */
export function BubbleGroup({ className, ...props }: React.ComponentProps<typeof View>) {
  return <View className={cn("gap-1", className)} {...props} />;
}
/** Reaction row positioned above or below a bubble. */
export function BubbleReactions({
  side = "bottom",
  align = "end",
  className,
  ...props
}: React.ComponentProps<typeof View> & { side?: "top" | "bottom"; align?: "start" | "end" }) {
  return (
    <View
      className={cn(
        "flex-row gap-1",
        side === "top" ? "-mb-2" : "-mt-2",
        align === "end" ? "self-end" : "self-start",
        className,
      )}
      {...props}
    />
  );
}
