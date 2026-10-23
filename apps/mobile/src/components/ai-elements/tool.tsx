import { Terminal } from "lucide-react-native";
import { CodeBlock, CodeBlockContent } from "@/components/ui/code-block";
import { Icon } from "@/components/ui/icon";
import { TraceIcon, TraceLine, TraceTitle } from "@/components/ui/trace";
import { Activity } from "./activity";
import { Confirmation } from "./confirmation";

/** Structural tool-part contract accepts AI SDK tool data without a runtime SDK dependency. */
export type ToolPart = {
  state:
    | "input-streaming"
    | "input-available"
    | "approval-requested"
    | "approval-responded"
    | "output-available"
    | "output-error"
    | "output-denied";
  input?: unknown;
  toolName?: string;
  output?: unknown;
  errorText?: string;
  approval?: { id: string; approved?: boolean };
};

/** Maps tool states to activity or an explicit approval prompt; never retries or executes tools. */
export function ToolLine({
  part,
  streaming,
  title: customTitle,
  onApproval,
  onError,
}: {
  part: ToolPart;
  streaming: boolean;
  title?: string;
  onApproval?: (response: { id: string; approved: boolean }) => void | Promise<void>;
  onError?: (error: unknown) => void;
}) {
  let title = customTitle ?? part.toolName ?? "tool";
  if (
    !customTitle &&
    part.input &&
    typeof part.input === "object" &&
    "command" in part.input &&
    typeof part.input.command === "string"
  )
    title = part.input.command;
  if (part.state === "approval-requested") {
    return (
      <Confirmation
        title={`Run ${title}?`}
        description="Review this action before approving it."
        disabled={!onApproval || !part.approval}
        approve={() => {
          if (part.approval) return onApproval?.({ id: part.approval.id, approved: true });
        }}
        deny={() => {
          if (part.approval) return onApproval?.({ id: part.approval.id, approved: false });
        }}
        onError={onError}
      />
    );
  }
  const denied =
    part.state === "output-denied" ||
    (part.state === "approval-responded" && part.approval?.approved === false);
  if (part.state === "output-available" || part.state === "output-error") {
    const failed = part.state === "output-error";
    let output = part.errorText;
    if (!failed)
      output = typeof part.output === "string" ? part.output : JSON.stringify(part.output, null, 2);
    return (
      <Activity
        title={`${failed ? "Failed to run" : "Ran"} ${title}`}
        icon={Terminal}
        status={failed ? "error" : undefined}
      >
        <CodeBlock size="sm" variant={failed ? "destructive" : "default"}>
          <CodeBlockContent wrap className="max-h-64">
            {output ?? ""}
          </CodeBlockContent>
        </CodeBlock>
      </Activity>
    );
  }
  const running = !denied && streaming;
  let label = "Failed to run";
  let status: "running" | "error" | undefined = "error";
  if (denied) {
    label = "Denied";
    status = undefined;
  } else if (running) {
    label = "Running";
    status = "running";
  }
  return (
    <TraceLine status={status}>
      <TraceIcon>
        <Icon as={Terminal} className="size-4" />
      </TraceIcon>
      <TraceTitle>
        {label} {title}
      </TraceTitle>
    </TraceLine>
  );
}
