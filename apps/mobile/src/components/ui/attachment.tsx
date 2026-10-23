import * as React from "react";
import { ScrollView, View } from "react-native";
import { Button, type ButtonProps } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { ActivityText } from "@/components/ui/activity-text";
import { cn } from "@/lib/utils";

const AttachmentBusyContext = React.createContext(false);

/** Local attachment presentation. It does not upload or authorize access to files. */
export function Attachment({
  state = "done",
  size = "default",
  orientation = "horizontal",
  className,
  ...props
}: React.ComponentProps<typeof View> & {
  state?: "idle" | "uploading" | "processing" | "error" | "done";
  size?: "default" | "sm" | "xs";
  orientation?: "horizontal" | "vertical";
}) {
  const busy = state === "uploading" || state === "processing";
  return (
    <AttachmentBusyContext.Provider value={busy}>
      <View
        accessibilityState={{ busy: state === "uploading" || state === "processing" }}
        className={cn(
          "relative max-w-full gap-2 rounded-lg border border-border bg-muted",
          orientation === "horizontal" ? "flex-row items-center" : "flex-col",
          size === "default" ? "p-3" : "p-2",
          state === "error" && "border-destructive",
          className,
        )}
        {...props}
      />
    </AttachmentBusyContext.Provider>
  );
}
/** File icon or thumbnail slot. */
export function AttachmentMedia({
  variant = "icon",
  className,
  ...props
}: React.ComponentProps<typeof View> & { variant?: "icon" | "image" }) {
  return (
    <View
      className={cn(
        "size-10 items-center justify-center overflow-hidden rounded-md",
        variant === "icon" && "bg-background",
        className,
      )}
      {...props}
    />
  );
}
/** Filename and metadata stack. */
export function AttachmentContent({ className, ...props }: React.ComponentProps<typeof View>) {
  return <View className={cn("min-w-0 shrink gap-1", className)} {...props} />;
}
/** Truncated filename. */
export function AttachmentTitle({ className, ...props }: React.ComponentProps<typeof Text>) {
  const busy = React.useContext(AttachmentBusyContext);
  return (
    <ActivityText
      active={busy}
      numberOfLines={1}
      className={cn("text-sm font-medium", className)}
      {...props}
    />
  );
}
/** File metadata or upload state. */
export function AttachmentDescription({ className, ...props }: React.ComponentProps<typeof Text>) {
  return <Text className={cn("text-xs text-muted-foreground", className)} {...props} />;
}
/** Independent controls, outside AttachmentTrigger. */
export function AttachmentActions({ className, ...props }: React.ComponentProps<typeof View>) {
  return <View className={cn("ml-auto flex-row items-center", className)} {...props} />;
}
/** Attachment action with native press semantics. */
export function AttachmentAction(props: ButtonProps) {
  return <Button variant="ghost" size="icon" {...props} />;
}
/** Full-surface activation; render before actions so those remain independently pressable. */
export function AttachmentTrigger({ className, ...props }: ButtonProps) {
  return (
    <Button variant="ghost" className={cn("absolute inset-0 size-full", className)} {...props} />
  );
}
/** Horizontal attachment strip; no browser drag-and-drop dependency. */
export function AttachmentGroup({
  contentContainerClassName,
  ...props
}: React.ComponentProps<typeof ScrollView>) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerClassName={cn("gap-2", contentContainerClassName)}
      {...props}
    />
  );
}
