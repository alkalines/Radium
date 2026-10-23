import * as React from "react";
import { Terminal as TerminalIcon } from "lucide-react-native";
import { CodeBlock, CodeBlockContent, CodeBlockFooter } from "@/components/ui/code-block";
import { Text } from "@/components/ui/text";
import { Activity, type ActivityProps } from "./activity";

/** Command and streamed output. This component never runs a command. */
export function Terminal({
  command,
  output,
  running = false,
  exitCode,
  defaultOpen,
  ...props
}: Omit<ActivityProps, "title" | "status"> & {
  command: string;
  output: string;
  running?: boolean;
  exitCode?: number;
}) {
  const [readerOpen, setReaderOpen] = React.useState(defaultOpen);
  const failed = exitCode != null && exitCode !== 0;
  let label = "Ran";
  if (running) label = "Running";
  else if (failed) label = "Failed to run";
  return (
    <Activity
      title={`${label} ${command}`}
      status={running ? "running" : failed ? "error" : undefined}
      icon={TerminalIcon}
      open={readerOpen ?? running}
      onOpenChange={setReaderOpen}
      {...props}
    >
      <CodeBlock size="sm" variant={failed ? "destructive" : "default"}>
        <CodeBlockContent wrap className="max-h-64">{`$ ${command}\n${output}`}</CodeBlockContent>
        {exitCode != null && (
          <CodeBlockFooter>
            <Text className="text-xs text-muted-foreground">Exit code {exitCode}</Text>
          </CodeBlockFooter>
        )}
      </CodeBlock>
    </Activity>
  );
}
