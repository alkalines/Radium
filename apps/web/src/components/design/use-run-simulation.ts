import { useEffect, useMemo, useState } from "react";

import type { RunState } from "@/components/agentic/agent-status";
import type { TerminalLine } from "@/components/agentic/terminal-log";

export type RunPhase =
  | "empty"
  | "queued"
  | "thinking"
  | "reading"
  | "awaiting"
  | "running"
  | "answering"
  | "done"
  | "denied";

const phaseOrder: RunPhase[] = [
  "empty",
  "queued",
  "thinking",
  "reading",
  "awaiting",
  "running",
  "answering",
  "done",
];

/** Simulation pacing (ms). These pace the fake backend, not animations, so they are not tokens. */
const phaseDelay: Partial<Record<RunPhase, number>> = {
  queued: 500,
  thinking: 1600,
  reading: 1100,
};
const terminalLineDelay = 220;
const streamTickDelay = 24;
const streamCharsPerTick = 3;

export const workerCommand = "bun run --cwd packages/worker test:unit edit-engine";

const workerOutput: Omit<TerminalLine, "id">[] = [
  { stream: "stdin", text: workerCommand },
  { stream: "stdout", text: " RUN  v4.1.0 /srv/radium/packages/worker" },
  { stream: "stdout", text: " ✓ src/edit/apply.test.ts (14 tests) 38ms" },
  { stream: "stdout", text: " ✓ src/edit/fuzzy-match.test.ts (9 tests) 21ms" },
  { stream: "stderr", text: "warn: snapshot obsolete › edit-engine › crlf input" },
  { stream: "stdout", text: " Test Files  2 passed (2)" },
  { stream: "stdout", text: "      Tests  23 passed (23)" },
  { stream: "system", text: "exit 0 · 1.42s" },
];

const answerText =
  "The edit-engine suite passes (23/23). One obsolete snapshot is left over from the CRLF fixture rename.\n\nI moved the reveal transition onto the shared spring.settle token so streamed rows and cards settle with the same feel.";

export function hasReached(phase: RunPhase, target: RunPhase) {
  return phaseOrder.indexOf(phase) >= phaseOrder.indexOf(target);
}

export function runStateFor(phase: RunPhase): RunState {
  switch (phase) {
    case "empty":
      return "idle";
    case "queued":
      return "queued";
    case "thinking":
      return "thinking";
    case "reading":
    case "running":
      return "executing";
    case "awaiting":
      return "awaiting";
    case "answering":
      return "streaming";
    case "done":
      return "succeeded";
    case "denied":
      return "cancelled";
  }
}

/**
 * Drives a fake Run through every RunState for the reference Session. `initialPhase: "done"`
 * renders a finished run immediately, which is how reopened sessions appear.
 */
export function useRunSimulation({
  initialPhase = "empty",
  initialPrompt = "",
}: {
  initialPhase?: "empty" | "done";
  initialPrompt?: string;
}) {
  const isRestored = initialPhase === "done";
  const [phase, setPhase] = useState<RunPhase>(initialPhase);
  const [prompt, setPrompt] = useState(initialPrompt);
  const [terminalCount, setTerminalCount] = useState(isRestored ? workerOutput.length : 0);
  const [answerLength, setAnswerLength] = useState(isRestored ? answerText.length : 0);

  // Timed phases advance on their own; `awaiting` waits for the user.
  useEffect(() => {
    const delay = phaseDelay[phase];
    if (delay === undefined) return;

    const nextPhase = phaseOrder[phaseOrder.indexOf(phase) + 1];
    const timeout = setTimeout(() => setPhase(nextPhase), delay);
    return () => clearTimeout(timeout);
  }, [phase]);

  useEffect(() => {
    if (phase !== "running") return;

    if (terminalCount >= workerOutput.length) {
      setPhase("answering");
      return;
    }

    const timeout = setTimeout(() => setTerminalCount((count) => count + 1), terminalLineDelay);
    return () => clearTimeout(timeout);
  }, [phase, terminalCount]);

  useEffect(() => {
    if (phase !== "answering") return;

    if (answerLength >= answerText.length) {
      setPhase("done");
      return;
    }

    const timeout = setTimeout(
      () => setAnswerLength((length) => length + streamCharsPerTick),
      streamTickDelay,
    );
    return () => clearTimeout(timeout);
  }, [phase, answerLength]);

  const terminalLines = useMemo(
    () =>
      workerOutput.slice(0, terminalCount).map((line, index) => ({ ...line, id: `line-${index}` })),
    [terminalCount],
  );

  function start(nextPrompt: string) {
    setPrompt(nextPrompt);
    setTerminalCount(0);
    setAnswerLength(0);
    setPhase("queued");
  }

  return {
    phase,
    prompt,
    terminalLines,
    answer: answerText.slice(0, answerLength),
    start,
    approve: () => setPhase("running"),
    deny: () => setPhase("denied"),
  };
}
