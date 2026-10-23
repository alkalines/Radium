import * as React from "react";
import type { LucideIcon } from "lucide-react-native";
import { Icon } from "@/components/ui/icon";
import {
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
  type TraceStatus,
} from "@/components/ui/trace";

/** Shared disclosure policy for agent activity patterns, not an execution or authorization contract. */
export type ActivityProps = React.ComponentProps<typeof TraceCollapsible> & {
  title: React.ReactNode;
  icon?: LucideIcon;
  description?: React.ReactNode;
  status?: TraceStatus;
  keepMounted?: boolean;
};

/** One expandable activity. Actions belong outside the trigger to avoid nested buttons. */
export function Activity({
  title,
  icon,
  description,
  status,
  keepMounted,
  children,
  ...props
}: ActivityProps) {
  return (
    <TraceCollapsible {...props}>
      <TraceCollapsibleTrigger>
        <TraceLine status={status}>
          {icon && (
            <TraceIcon>
              <Icon as={icon} className="size-4" />
            </TraceIcon>
          )}
          <TraceTitle>{title}</TraceTitle>
          {description != null && <TraceDescription>{description}</TraceDescription>}
        </TraceLine>
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent keepMounted={keepMounted}>{children}</TraceCollapsibleContent>
    </TraceCollapsible>
  );
}
