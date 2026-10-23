import * as React from "react";
import { TextInput, View } from "react-native";
import { Button, type ButtonProps } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Input surface composed with a native input and block/inline addons. */
export function InputGroup({ className, children, ...props }: React.ComponentProps<typeof View>) {
  const addons = new Map<string, React.ReactNode[]>();
  const controls: React.ReactNode[] = [];
  for (const child of React.Children.toArray(children)) {
    if (
      React.isValidElement<React.ComponentProps<typeof InputGroupAddon>>(child) &&
      child.type === InputGroupAddon
    ) {
      const align = child.props.align ?? "inline-start";
      addons.set(align, [...(addons.get(align) ?? []), child]);
    } else controls.push(child);
  }
  return (
    <View
      className={cn("w-full rounded-xl border border-input bg-background", className)}
      {...props}
    >
      {addons.get("block-start")}
      <View className="w-full flex-row items-center">
        {addons.get("inline-start")}
        {controls}
        {addons.get("inline-end")}
      </View>
      {addons.get("block-end")}
    </View>
  );
}
/** Places controls beside or above/below the input; React Native has no CSS order. */
export function InputGroupAddon({
  align = "inline-start",
  className,
  ...props
}: React.ComponentProps<typeof View> & {
  align?: "inline-start" | "inline-end" | "block-start" | "block-end";
}) {
  return (
    <View
      className={cn(
        "flex-row items-center gap-2 px-3 py-2",
        (align === "block-start" || align === "block-end") && "w-full",
        className,
      )}
      {...props}
    />
  );
}
/** Native text input. Use onChangeText instead of a browser change event. */
export function InputGroupInput({ className, ...props }: React.ComponentProps<typeof TextInput>) {
  return (
    <TextInput
      placeholderTextColorClassName="accent-muted-foreground"
      className={cn("min-h-11 min-w-0 flex-1 px-3 text-base text-foreground", className)}
      {...props}
    />
  );
}
/** Multiline input with a mobile keyboard; Return inserts a newline by default. */
export function InputGroupTextarea({
  className,
  ...props
}: React.ComponentProps<typeof TextInput>) {
  return (
    <InputGroupInput
      multiline
      textAlignVertical="top"
      className={cn("min-h-24 w-full flex-none py-3", className)}
      {...props}
    />
  );
}
/** Current shadcn compact sizes mapped to touch-friendly Reusables buttons. */
export function InputGroupButton({
  size = "xs",
  variant = "ghost",
  className,
  ...props
}: Omit<ButtonProps, "size"> & { size?: "xs" | "icon-xs" | "sm" | "icon-sm" }) {
  return (
    <Button
      variant={variant}
      size={size.startsWith("icon") ? "icon" : "sm"}
      className={cn("min-h-11", className)}
      {...props}
    />
  );
}
