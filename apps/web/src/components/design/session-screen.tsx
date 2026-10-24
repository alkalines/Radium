import { useEffect, useState } from "react";
import { AnimatePresence } from "motion/react";
import * as m from "motion/react-m";
import {
  ArrowUpIcon,
  BrainIcon,
  ChevronDownIcon,
  FileCodeIcon,
  GitBranchIcon,
  MonitorIcon,
  PlusIcon,
  ShieldAlertIcon,
  SquareIcon,
  TerminalIcon,
  XIcon,
} from "lucide-react";

import { AgentStatus, type RunState } from "@/components/agentic/agent-status";
import { SessionAmbient } from "@/components/agentic/session-ambient";
import { StreamingText } from "@/components/agentic/streaming-text";
import { TerminalLog } from "@/components/agentic/terminal-log";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Button } from "@/components/ui/button";
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockContent,
  CodeBlockCopyButton,
  CodeBlockHeader,
  CodeBlockLine,
  CodeBlockTitle,
} from "@/components/ui/code-block";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group";
import { Kbd } from "@/components/ui/kbd";
import { Marker, MarkerContent } from "@/components/ui/marker";
import { Message, MessageContent } from "@/components/ui/message";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "@/components/ui/trace";
import { useHighlightedCode } from "@/hooks/use-highlighted-code";
import { transitions, variants } from "@/lib/motion";
import { demoEfforts, demoModels, workspaceName } from "./demo-data";
import { ProjectTile } from "./project-tile";
import {
  hasReached,
  runStateFor,
  type RunPhase,
  useRunSimulation,
  workerCommand,
} from "./use-run-simulation";

/**
 * One Session Tab. Empty sessions show the greeting, Composer, and ambient layer; once a prompt is
 * sent the Composer docks to the bottom through a shared `layoutId` and the simulated Run plays.
 */
export function SessionScreen({
  tabId,
  isActive,
  restoredPrompt,
  onRunStateChange,
  onTitleChange,
}: {
  tabId: string;
  isActive: boolean;
  /** Set for sessions reopened from Home; they render their finished run without animation. */
  restoredPrompt?: string;
  onRunStateChange: (state: RunState) => void;
  onTitleChange: (title: string) => void;
}) {
  const run = useRunSimulation({
    initialPhase: restoredPrompt ? "done" : "empty",
    initialPrompt: restoredPrompt,
  });
  const runState = runStateFor(run.phase);
  const isEmpty = run.phase === "empty";
  const { approve, deny, phase } = run;

  useEffect(() => {
    onRunStateChange(runState);
  }, [runState, onRunStateChange]);

  // Approval shortcuts only apply to the Tab the user is looking at.
  useEffect(() => {
    if (!isActive || phase !== "awaiting") return;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) approve();
      if (event.key === "Escape") deny();
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isActive, phase, approve, deny]);

  function submit(prompt: string) {
    onTitleChange(prompt);
    run.start(prompt);
  }

  const composer = (
    <Composer
      layoutId={`composer-${tabId}`}
      isRunning={!isEmpty && !hasReached(run.phase, "done") && run.phase !== "denied"}
      autoFocus={isEmpty && isActive}
      onSubmit={submit}
      onStop={deny}
    />
  );

  if (isEmpty) {
    return (
      <div className="relative flex h-full flex-col items-center justify-center px-4">
        <SessionAmbient />
        <div className="relative flex w-full max-w-160 flex-col items-center gap-6">
          <h1 className="text-center text-3xl font-medium tracking-tight">
            What should we work on?
          </h1>
          {composer}
          <ContextBar />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-190 flex-col gap-6 px-4 py-8">
          <Message align="end">
            <MessageContent>
              <Bubble variant="secondary" align="end">
                <BubbleContent>{run.prompt}</BubbleContent>
              </Bubble>
            </MessageContent>
          </Message>

          <Message>
            <MessageContent className="gap-4">
              <RunTrace phase={run.phase} terminalLines={run.terminalLines} />

              <AnimatePresence mode="popLayout" initial={false}>
                {run.phase === "awaiting" ? (
                  // popLayout measures its direct child, so the motion element sits here.
                  <m.div
                    key="gate"
                    variants={variants.swap}
                    initial="hidden"
                    animate="visible"
                    exit="exit"
                  >
                    <ApprovalGate onApprove={approve} onDeny={deny} />
                  </m.div>
                ) : null}
                {run.phase === "denied" ? (
                  <m.div key="denied" variants={variants.swap} initial="hidden" animate="visible">
                    <Marker className="text-xs">
                      <XIcon />
                      <MarkerContent>Denied. No command was executed.</MarkerContent>
                    </Marker>
                  </m.div>
                ) : null}
              </AnimatePresence>

              {run.answer ? (
                <StreamingText
                  text={run.answer}
                  streaming={run.phase === "answering"}
                  className="text-sm"
                />
              ) : null}

              <AnimatePresence initial={false}>
                {run.phase === "done" ? (
                  <m.div key="diff" variants={variants.reveal} initial="hidden" animate="visible">
                    <DiffBlock />
                  </m.div>
                ) : null}
              </AnimatePresence>
            </MessageContent>
          </Message>
        </div>
      </div>

      <div className="mx-auto flex w-full max-w-190 flex-col gap-2 px-4 pb-4">
        {composer}
        <ContextBar />
      </div>
    </div>
  );
}

function Composer({
  layoutId,
  isRunning,
  autoFocus,
  onSubmit,
  onStop,
}: {
  layoutId: string;
  isRunning: boolean;
  autoFocus: boolean;
  onSubmit: (prompt: string) => void;
  onStop: () => void;
}) {
  const [value, setValue] = useState("");
  const [modelId, setModelId] = useState<string>(demoModels[0].id);
  const [effort, setEffort] = useState<string>("Medium");
  const model = demoModels.find((candidate) => candidate.id === modelId) ?? demoModels[0];
  const canSend = value.trim().length > 0 && !isRunning;

  function send() {
    if (!canSend) return;
    onSubmit(value.trim());
    setValue("");
  }

  return (
    <m.div layoutId={layoutId} transition={transitions.layout} className="w-full">
      <InputGroup className="rounded-2xl border-border bg-card">
        <InputGroupTextarea
          value={value}
          autoFocus={autoFocus}
          placeholder="Ask anything, / for commands, @ for context…"
          className="min-h-14 px-4 pt-3.5"
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              send();
            }
          }}
        />
        <InputGroupAddon align="block-end" className="gap-1 px-2 pb-2">
          <InputGroupButton size="icon-sm" aria-label="Attach context">
            <PlusIcon />
          </InputGroupButton>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <InputGroupButton size="xs" className="text-muted-foreground">
                {model.label}
                <ChevronDownIcon data-icon="inline-end" />
              </InputGroupButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuLabel>Model</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={modelId} onValueChange={setModelId}>
                {demoModels.map((candidate) => (
                  <DropdownMenuRadioItem key={candidate.id} value={candidate.id}>
                    {candidate.label}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <InputGroupButton size="xs" className="text-muted-foreground">
                {effort}
                <ChevronDownIcon data-icon="inline-end" />
              </InputGroupButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuLabel>Reasoning effort</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={effort} onValueChange={setEffort}>
                {demoEfforts.map((level) => (
                  <DropdownMenuRadioItem key={level} value={level}>
                    {level}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>

          {isRunning ? (
            <InputGroupButton
              variant="secondary"
              size="icon-sm"
              className="ml-auto"
              aria-label="Stop run"
              onClick={onStop}
            >
              <SquareIcon />
            </InputGroupButton>
          ) : (
            <InputGroupButton
              variant="default"
              size="icon-sm"
              className="ml-auto"
              aria-label="Send"
              disabled={!canSend}
              onClick={send}
            >
              <ArrowUpIcon />
            </InputGroupButton>
          )}
        </InputGroupAddon>
      </InputGroup>
    </m.div>
  );
}

/** Workspace, Worker, and branch for the Session, shown under the Composer. */
function ContextBar() {
  return (
    <div className="flex flex-wrap items-center justify-center gap-1 text-[13px] text-muted-foreground">
      <Button variant="ghost" size="xs" className="text-muted-foreground">
        <ProjectTile initial="A" />
        {workspaceName}
        <ChevronDownIcon data-icon="inline-end" />
      </Button>
      <span className="text-subtle-foreground">/</span>
      <Button variant="ghost" size="xs" className="text-muted-foreground">
        <MonitorIcon data-icon="inline-start" />
        radium-dev-01
        <AgentStatus state="succeeded" label="Worker online" hideLabel />
        <ChevronDownIcon data-icon="inline-end" />
      </Button>
      <span className="inline-flex h-6 items-center gap-1.5 rounded-md bg-accent px-2 font-mono text-xs">
        <GitBranchIcon className="size-3" />
        feat/agentic-design-system
      </span>
    </div>
  );
}

/** `Trace` has its own status vocabulary; map RunState onto it in one place. */
function traceStatusFor(state: RunState) {
  if (state === "thinking" || state === "executing" || state === "streaming") return "running";
  if (state === "awaiting" || state === "queued") return "pending";
  if (state === "failed") return "error";
  return undefined;
}

/** Steps mount as the run reaches them; already-finished steps never re-animate. */
function RunTrace({
  phase,
  terminalLines,
}: {
  phase: RunPhase;
  terminalLines: ReturnType<typeof useRunSimulation>["terminalLines"];
}) {
  const [isOutputOpen, setIsOutputOpen] = useState(true);
  const isDenied = phase === "denied";

  const reasoningState: RunState = phase === "thinking" ? "thinking" : "succeeded";
  const readState: RunState = phase === "reading" ? "executing" : "succeeded";

  let bashState: RunState = "succeeded";
  if (phase === "awaiting") bashState = "awaiting";
  if (phase === "running") bashState = "executing";
  if (isDenied) bashState = "cancelled";

  if (phase === "queued") {
    return <AgentStatus state="queued" label="Queued" />;
  }

  return (
    <Trace>
      <AnimatePresence initial={false}>
        {hasReached(phase, "thinking") || isDenied ? (
          <m.div key="reasoning" variants={variants.reveal} initial="hidden" animate="visible">
            <TraceCollapsible>
              <TraceCollapsibleTrigger>
                <TraceLine status={traceStatusFor(reasoningState)}>
                  <TraceIcon>
                    <BrainIcon />
                  </TraceIcon>
                  <TraceTitle>
                    {reasoningState === "thinking" ? "Thinking" : "Thought for 1.6s"}
                  </TraceTitle>
                </TraceLine>
              </TraceCollapsibleTrigger>
              <TraceCollapsibleContent>
                Tests run on the Worker, so this needs an execution approval. Read the motion tokens
                first so the edit reuses an existing spring.
              </TraceCollapsibleContent>
            </TraceCollapsible>
          </m.div>
        ) : null}

        {hasReached(phase, "reading") || isDenied ? (
          <m.div key="read" variants={variants.reveal} initial="hidden" animate="visible">
            <TraceLine status={traceStatusFor(readState)}>
              <TraceIcon>
                <FileCodeIcon />
              </TraceIcon>
              <TraceTitle>
                Read <span className="font-mono text-xs">apps/web/src/lib/motion.tsx</span>
              </TraceTitle>
              {readState === "succeeded" ? <TraceDescription>97 lines</TraceDescription> : null}
            </TraceLine>
          </m.div>
        ) : null}

        {hasReached(phase, "awaiting") || isDenied ? (
          <m.div key="bash" variants={variants.reveal} initial="hidden" animate="visible">
            <TraceCollapsible
              open={isOutputOpen && terminalLines.length > 0}
              onOpenChange={setIsOutputOpen}
            >
              <TraceCollapsibleTrigger>
                <TraceLine status={traceStatusFor(bashState)}>
                  <TraceIcon>
                    <TerminalIcon />
                  </TraceIcon>
                  <TraceTitle>
                    Run <span className="font-mono text-xs">{workerCommand}</span>
                  </TraceTitle>
                  <AgentStatus state={bashState} hideLabel />
                </TraceLine>
              </TraceCollapsibleTrigger>
              <TraceCollapsibleContent>
                <div className="rounded-lg bg-muted p-3">
                  <TerminalLog lines={terminalLines} />
                </div>
              </TraceCollapsibleContent>
            </TraceCollapsible>
          </m.div>
        ) : null}
      </AnimatePresence>
    </Trace>
  );
}

function ApprovalGate({ onApprove, onDeny }: { onApprove: () => void; onDeny: () => void }) {
  return (
    <div
      data-state="awaiting"
      className="flex flex-col gap-3 rounded-lg border border-signal-awaiting/30 bg-card p-3"
    >
      <div className="flex items-start gap-2.5">
        <ShieldAlertIcon className="mt-0.5 size-4 shrink-0 text-signal-awaiting" />
        <div className="flex min-w-0 flex-col">
          <p className="text-sm font-medium">Allow this command on radium-dev-01?</p>
          <p className="text-[13px] text-muted-foreground">Bash cwd is not a sandbox.</p>
        </div>
      </div>
      <CodeBlock size="sm">
        <CodeBlockContent>{`$ ${workerCommand}`}</CodeBlockContent>
      </CodeBlock>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onDeny}>
          Deny <Kbd>Esc</Kbd>
        </Button>
        <Button size="sm" onClick={onApprove}>
          Allow once <Kbd>⌘↵</Kbd>
        </Button>
      </div>
    </div>
  );
}

const diffLines: { variant: "default" | "added" | "removed"; text: string }[] = [
  { variant: "default", text: "export const variants = {" },
  { variant: "default", text: "  reveal: {" },
  { variant: "default", text: '    hidden: { opacity: 0, y: 6, filter: "blur(4px)" },' },
  { variant: "removed", text: "    visible: { opacity: 1, y: 0, transition: { duration: 0.3 } }," },
  {
    variant: "added",
    text: '    visible: { opacity: 1, y: 0, filter: "blur(0px)", transition: spring.settle },',
  },
  { variant: "default", text: "  }," },
  { variant: "default", text: "};" },
];
const diffCode = diffLines.map((line) => line.text).join("\n");

function DiffBlock() {
  const highlighted = useHighlightedCode(diffCode, "ts");

  return (
    <CodeBlock size="sm">
      <CodeBlockHeader>
        <CodeBlockTitle className="font-mono">apps/web/src/lib/motion.tsx</CodeBlockTitle>
        <span className="font-mono text-xs">
          <span className="text-signal-success">+1</span>{" "}
          <span className="text-destructive">−1</span>
        </span>
        <CodeBlockActions>
          <CodeBlockCopyButton value={diffCode} />
        </CodeBlockActions>
      </CodeBlockHeader>
      <CodeBlockContent lineNumbers startLine={58}>
        {highlighted.map((line, index) => (
          <CodeBlockLine key={index} variant={diffLines[index]?.variant}>
            {line}
          </CodeBlockLine>
        ))}
      </CodeBlockContent>
    </CodeBlock>
  );
}
