import * as React from "react";
import { View } from "react-native";
import { Text } from "@/components/ui/text";
import { Trace, TraceLine, TraceTitle } from "@/components/ui/trace";
import { ChainOfThought } from "./chain-of-thought";
import { Chat, MessageScrollerItem } from "./chat";
import { Checkpoint } from "./checkpoint";
import { Confirmation } from "./confirmation";
import { Context } from "./context";
import { FileTreeNode } from "./file-tree";
import { InlineCitation } from "./inline-citation";
import { MessageTurn } from "./message";
import { ModelSelector } from "./model-selector";
import { Plan } from "./plan";
import { PromptInput, type PromptFile } from "./prompt-input";
import { Queue } from "./queue";
import { ReasoningLine } from "./reasoning";
import { Sources } from "./sources";
import { StackTrace } from "./stack-trace";
import { Subagent } from "./subagent";
import { Suggestions } from "./suggestion";
import { Task } from "./task";
import { Terminal } from "./terminal";
import { TestResults } from "./test-results";
import { ToolLine } from "./tool";

/** Offline fixture gallery covering every current pattern. No models, Workers or backend mutations are called. */
export function AiElementsGallery() {
  const [text, setText] = React.useState("");
  const [files, setFiles] = React.useState<PromptFile[]>([]);
  const [model, setModel] = React.useState("local-default");
  const [effort, setEffort] = React.useState("medium");
  const [feedback, setFeedback] = React.useState("All examples use local fixtures.");
  const [running, setRunning] = React.useState(false);
  const [approved, setApproved] = React.useState<boolean>();

  return (
    <View className="gap-8 bg-background p-4">
      <View className="gap-2">
        <Text variant="h2">AI Elements</Text>
        <Text className="text-sm text-muted-foreground">
          Native patterns · Uniwind · React Native Reusables
        </Text>
        <Text accessibilityLiveRegion="polite" className="text-sm">
          {feedback}
        </Text>
      </View>
      <Section title="Chat & Message">
        <View className="h-80 overflow-hidden rounded-xl border border-border">
          <Chat>
            <MessageScrollerItem messageId="user" scrollAnchor>
              <MessageTurn role="user" text="Why is the deploy slow?" />
            </MessageScrollerItem>
            <MessageScrollerItem messageId="assistant">
              <MessageTurn
                role="assistant"
                text="**Image optimization** reruns on every deploy. Cache it by image content instead of commit ID."
              />
            </MessageScrollerItem>
          </Chat>
        </View>
      </Section>
      <Section title="Reasoning">
        <Trace>
          <ReasoningLine
            text="The install and compile phases are normal. I will check image processing next."
            running={running}
            duration={5}
          />
        </Trace>
        <Suggestions
          suggestions={[running ? "Finish thinking" : "Start thinking"]}
          send={() => setRunning(!running)}
        />
      </Section>
      <Section title="Chain of Thought">
        <ChainOfThought title="Researched in 3 steps" defaultOpen>
          <Trace>
            <TraceLine>
              <TraceTitle>Read the build log</TraceTitle>
            </TraceLine>
            <TraceLine>
              <TraceTitle>Checked the image cache key</TraceTitle>
            </TraceLine>
            <TraceLine>
              <TraceTitle>Compared previous deploys</TraceTitle>
            </TraceLine>
          </Trace>
        </ChainOfThought>
      </Section>
      <Section title="Checkpoint">
        <Checkpoint
          label="Before cache changes"
          restore={() => setFeedback("Checkpoint selected (fixture only). No data was restored.")}
        />
      </Section>
      <Section title="Confirmation">
        <Confirmation
          title="Run the test suite?"
          description={
            approved == null
              ? "This example only records your selection."
              : approved
                ? "Approved locally."
                : "Denied locally."
          }
          disabled={approved != null}
          approve={() => setApproved(true)}
          deny={() => setApproved(false)}
        />
      </Section>
      <Section title="Context">
        <Context used={16000} limit={128000} />
      </Section>
      <Section title="File Tree">
        <FileTreeNode
          node={{
            type: "folder",
            name: "src",
            path: "src",
            children: [{ type: "file", name: "cache.ts", path: "src/cache.ts" }],
          }}
          onSelect={(path) => setFeedback(`Selected ${path}`)}
        />
      </Section>
      <Section title="Inline Citation">
        <InlineCitation
          hostname="ui.shadcn.com"
          title="AI Elements patterns"
          url="https://ui.shadcn.com/docs/ai-elements"
          onError={() => setFeedback("Could not open the source.")}
        />
      </Section>
      <Section title="Model Selector">
        <ModelSelector
          models={[
            { value: "local-default", label: "Local model", provider: "Connected machine" },
            {
              value: "configured-account",
              label: "Configured model",
              provider: "Workspace account",
            },
          ]}
          model={model}
          setModel={setModel}
          effort={effort}
          setEffort={setEffort}
        />
      </Section>
      <Section title="Plan">
        <Plan
          title="Plan: fix the cache key"
          steps={[
            { title: "Read the build script", status: "done" },
            { title: "Update the cache key", status: "running" },
            { title: "Run the tests", status: "pending" },
          ]}
        />
      </Section>
      <Section title="Prompt Input">
        <PromptInput
          text={text}
          setText={setText}
          files={files}
          setFiles={setFiles}
          onSubmit={(message) => {
            setFeedback(`Draft received locally with ${message.files.length} files.`);
            setText("");
            setFiles([]);
          }}
        >
          <ModelSelector
            models={[{ value: "local-default", label: "Local model" }]}
            model={model}
            setModel={setModel}
          />
        </PromptInput>
      </Section>
      <Section title="Queue">
        <Queue
          todos={[
            { title: "Read the build log", done: true },
            {
              title: "Fix the cache key",
              done: false,
              description: "Use the image directory and lockfile.",
            },
          ]}
        />
      </Section>
      <Section title="Sources">
        <Sources
          sources={[{ title: "AI Elements", url: "https://ui.shadcn.com/docs/ai-elements" }]}
          onError={() => setFeedback("Could not open the source.")}
        />
      </Section>
      <Section title="Stack Trace">
        <StackTrace
          stack={
            "TypeError: Cache key is undefined\n    at buildCache (src/cache.ts:42:3)\n    at run (node_modules/build/index.js:12:1)"
          }
          onFilePathClick={(path, line) => setFeedback(`Open ${path}:${line} (fixture only)`)}
        />
      </Section>
      <Section title="Subagent">
        <Subagent
          title="Ran the research agent"
          model="local-default"
          result="The cache is keyed by commit ID."
          defaultOpen
        >
          <Trace>
            <TraceLine>
              <TraceTitle>Read the optimization script</TraceTitle>
            </TraceLine>
          </Trace>
        </Subagent>
      </Section>
      <Section title="Suggestion">
        <Suggestions
          suggestions={["Explain the fix", "Add a regression test", "Show the diff"]}
          send={setText}
        />
      </Section>
      <Section title="Task">
        <Task title="Found the project files" defaultOpen>
          <Trace>
            <TraceLine>
              <TraceTitle>Read src/cache.ts</TraceTitle>
            </TraceLine>
          </Trace>
        </Task>
      </Section>
      <Section title="Terminal">
        <Terminal
          command="bun test"
          output={"cache.test.ts\n2 tests passed"}
          exitCode={0}
          defaultOpen
        />
      </Section>
      <Section title="Test Results">
        <TestResults
          suites={[
            {
              name: "cache.test.ts",
              tests: [
                { name: "reuses unchanged images", status: "passed" },
                {
                  name: "invalidates edited images",
                  status: "failed",
                  error: "Expected a new key, received the old key.",
                },
                { name: "remote cache", status: "skipped" },
              ],
            },
          ]}
        />
      </Section>
      <Section title="Tool">
        <Trace>
          <ToolLine
            title="readFile src/cache.ts"
            part={{ state: "output-available", output: { cacheKey: "commitId" } }}
            streaming={false}
          />
        </Trace>
      </Section>
    </View>
  );
}

function Section({ title, children }: React.PropsWithChildren<{ title: string }>) {
  return (
    <View className="gap-3">
      <Text variant="h3">{title}</Text>
      {children}
    </View>
  );
}
