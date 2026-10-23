import * as React from "react";
import { Brain } from "lucide-react-native";
import { Icon } from "@/components/ui/icon";
import { TraceIcon, TraceLine, TraceTitle } from "@/components/ui/trace";
import { Activity } from "./activity";
import { Markdown } from "./markdown";

/** Current ReasoningLine pattern: follows streaming until the reader explicitly chooses an open state. */
export function ReasoningLine({
  text,
  running,
  defaultOpen,
  duration,
}: {
  text: string;
  running: boolean;
  defaultOpen?: boolean;
  duration?: number;
}) {
  const [open, setOpen] = React.useState(defaultOpen);
  let title = duration == null ? "Thought" : `Thought for ${duration}s`;
  if (running) title = "Thinking";
  if (!text)
    return (
      <TraceLine status={running ? "running" : undefined}>
        <TraceIcon>
          <Icon as={Brain} className="size-4" />
        </TraceIcon>
        <TraceTitle>{title}</TraceTitle>
      </TraceLine>
    );
  return (
    <Activity
      title={title}
      icon={Brain}
      status={running ? "running" : undefined}
      open={open ?? running}
      onOpenChange={setOpen}
    >
      <Markdown>{text}</Markdown>
    </Activity>
  );
}
