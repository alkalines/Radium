import * as CollapsiblePrimitive from "@rn-primitives/collapsible";
import { ChevronRight } from "lucide-react-native";
import * as React from "react";
import { View } from "react-native";

import { Icon } from "@/components/ui/icon";
import { ActivityText } from "@/components/ui/activity-text";
import { Text, TextClassContext } from "@/components/ui/text";
import { cn } from "@/lib/utils";

/** Agent activity state; completed work deliberately has no status. */
export type TraceStatus = "running" | "error" | "pending";
const StatusContext = React.createContext<TraceStatus | undefined>(undefined);
const OpenContext = React.createContext(false);

/** Groups agent activity without adding an interactive or live-region role. */
export function Trace({ className, ...props }: React.ComponentProps<typeof View>) {
  return <View className={cn("w-full min-w-0 gap-2", className)} {...props} />;
}

/** A non-interactive activity row. Wrap in a trigger or link to make it actionable. */
export function TraceLine({
  className,
  status,
  ...props
}: React.ComponentProps<typeof View> & {
  status?: TraceStatus;
}) {
  return (
    <StatusContext.Provider value={status}>
      <TextClassContext.Provider
        value={status === "error" ? "text-destructive" : "text-muted-foreground"}
      >
        <View
          className={cn(
            "min-w-0 max-w-full flex-row items-center gap-2",
            status === "pending" && "opacity-60",
            className,
          )}
          {...props}
        />
      </TextClassContext.Provider>
    </StatusContext.Provider>
  );
}

/** Decorative icon slot; use the Reusables Icon component for inherited colors. */
export function TraceIcon({ className, ...props }: React.ComponentProps<typeof View>) {
  return (
    <View
      className={cn("size-4 shrink-0 items-center justify-center", className)}
      {...props}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    />
  );
}

/** Truncated activity sentence. Status must also be conveyed in its wording. */
export function TraceTitle({ className, ...props }: React.ComponentProps<typeof Text>) {
  const status = React.useContext(StatusContext);
  return (
    <ActivityText
      active={status === "running"}
      numberOfLines={1}
      className={cn("shrink text-sm", status === "running" && "font-medium", className)}
      {...props}
    />
  );
}

/** Non-truncating secondary count, duration, or summary. */
export function TraceDescription({ className, ...props }: React.ComponentProps<typeof Text>) {
  return <Text className={cn("shrink-0 text-sm text-muted-foreground", className)} {...props} />;
}

/** Controlled or uncontrolled disclosure backed by React Native Reusables primitives. */
export function TraceCollapsible({
  className,
  open,
  defaultOpen = false,
  onOpenChange,
  ...props
}: React.ComponentProps<typeof CollapsiblePrimitive.Root>) {
  const [internalOpen, setInternalOpen] = React.useState(defaultOpen);
  const expanded = open ?? internalOpen;
  return (
    <OpenContext.Provider value={expanded}>
      <CollapsiblePrimitive.Root
        className={cn("w-full min-w-0", className)}
        open={expanded}
        onOpenChange={(next) => {
          if (open === undefined) setInternalOpen(next);
          onOpenChange?.(next);
        }}
        {...props}
      />
    </OpenContext.Provider>
  );
}

/** Full-row disclosure button with native expanded semantics and a decorative chevron. */
export function TraceCollapsibleTrigger({
  className,
  children,
  ...props
}: React.ComponentProps<typeof CollapsiblePrimitive.Trigger>) {
  const open = React.useContext(OpenContext);
  return (
    <CollapsiblePrimitive.Trigger
      className={cn(
        "min-h-11 max-w-full flex-row items-center gap-1 rounded-lg active:bg-accent",
        className,
      )}
      {...props}
    >
      {(state) => (
        <>
          {typeof children === "function" ? children(state) : children}
          <TraceIcon>
            <Icon
              as={ChevronRight}
              className={cn("size-4 text-muted-foreground", open && "rotate-90")}
            />
          </TraceIcon>
        </>
      )}
    </CollapsiblePrimitive.Trigger>
  );
}

/** Keeps nested disclosure state when keepMounted is true, hiding closed content from assistive tech. */
export function TraceCollapsibleContent({
  className,
  children,
  keepMounted = false,
  ...props
}: React.ComponentProps<typeof CollapsiblePrimitive.Content> & { keepMounted?: boolean }) {
  const open = React.useContext(OpenContext);
  return (
    <CollapsiblePrimitive.Content
      forceMount={keepMounted || undefined}
      {...props}
      style={[props.style, !open && { display: "none" }]}
      aria-hidden={!open}
      accessibilityElementsHidden={!open}
      importantForAccessibility={open ? "auto" : "no-hide-descendants"}
    >
      <View
        className={cn("mb-1 ml-2 mt-2 min-w-0 gap-2 border-l border-border pl-4 pr-1", className)}
      >
        {React.Children.map(children, (child) =>
          typeof child === "string" || typeof child === "number" ? (
            <Text className="text-sm leading-6 text-muted-foreground">{child}</Text>
          ) : (
            child
          ),
        )}
      </View>
    </CollapsiblePrimitive.Content>
  );
}
