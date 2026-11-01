import { useEffect, useRef, useState, type FormEvent } from "react";
import type { ToolUIPart } from "ai";
import type { QuestionOutput } from "backend/src/chatroom/session-tools";
import { MessageCircleQuestionIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import {
  Questionnaire,
  QuestionnaireActions,
  QuestionnaireChoice,
  QuestionnaireChoiceDescription,
  QuestionnaireChoices,
  QuestionnaireDescription,
  QuestionnaireError,
  QuestionnaireInput,
  QuestionnaireItem,
  QuestionnaireNext,
  QuestionnairePrevious,
  QuestionnaireSkip,
  QuestionnaireSubmit,
  QuestionnaireTitle,
} from "@/components/ui/questionnaire";
import { ExpiryCountdown } from "./approval-gate";
import { getQuestionPrompts, getToolInput } from "./tool-parts";

/** The `output-error` text a dismissed question returns to the model. */
export const QUESTION_DISMISSED_MESSAGE = "The user dismissed these questions without answering.";

// Esc belongs to the prompt, not to an open menu or dialog, or to text typed as a custom answer.
const escapeIgnoredSelector =
  "input[type=text], textarea, [role=dialog], [role=menu], [role=listbox], [data-radix-popper-content-wrapper]";

/**
 * Answers one `question` call. Like the Approval prompt it takes the Composer's place and shape
 * while the turn waits, and uses the `awaiting` border. The shadcn Questionnaire shows one question
 * at a time with number-key shortcuts, a free-form answer under the choices, and Skip for a
 * question the user leaves open (it reaches the model as `Unanswered`). Dismiss (Esc) answers the
 * call with an error so the model stops waiting; the user's next message continues the Session.
 */
export function QuestionPrompt({
  part,
  shortcutsEnabled,
  expiresAt,
  onAnswer,
  onDismiss,
}: {
  part: ToolUIPart & { state: "input-available" };
  shortcutsEnabled: boolean;
  /** Code Mode questions: when the server dismisses them if still unanswered. */
  expiresAt?: number;
  onAnswer: (output: QuestionOutput) => void;
  onDismiss: () => void;
}) {
  // A waiting call's input is complete and the caller keys this prompt by call id, so the
  // questions are read once; the Questionnaire must not see a new `items` collection per render.
  const [{ questions, items }] = useState(() => {
    const prompts = getQuestionPrompts(getToolInput(part));
    return {
      questions: prompts,
      items: prompts.map((question, index) => ({
        name: `q${index}`,
        choices: question.options.map((option) => ({ value: option.label })),
      })),
    };
  });
  const formRef = useRef<HTMLFormElement>(null);

  // Focus the active question so number shortcuts work without a click first.
  useEffect(() => {
    if (!shortcutsEnabled) return;
    formRef.current
      ?.querySelector<HTMLElement>("[data-slot=questionnaire-item]:not([hidden])")
      ?.focus();
  }, [shortcutsEnabled]);

  useEffect(() => {
    if (!shortcutsEnabled) return;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented || event.repeat) return;
      if (event.target instanceof Element && event.target.closest(escapeIgnoredSelector)) return;

      event.preventDefault();
      onDismiss();
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onDismiss, shortcutsEnabled]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const answers = questions.map((_, index) =>
      data
        .getAll(`q${index}`)
        .map((value) => String(value).trim())
        .filter(Boolean),
    );
    onAnswer({ answers });
  }

  return (
    <Questionnaire
      ref={formRef}
      items={items}
      shortcuts={shortcutsEnabled ? "numbers" : undefined}
      onSubmit={submit}
      data-state="awaiting"
      aria-label="Questions from the agent"
      className="gap-0 overflow-hidden rounded-2xl border border-signal-awaiting/40 bg-card group-data-[tray=attached]/prompt-slot:rounded-t-none"
    >
      <div className="flex max-h-[min(28rem,60svh)] flex-col gap-3 overflow-y-auto p-3">
        {questions.map((question, index) => (
          <QuestionnaireItem
            key={index}
            name={`q${index}`}
            multiple={question.multiple}
            className="gap-3"
          >
            <div className="flex items-start gap-2.5 px-1">
              <MessageCircleQuestionIcon className="mt-0.5 size-4 shrink-0 text-signal-awaiting" />
              <div className="flex min-w-0 flex-1 flex-col">
                {question.header ? (
                  <span className="truncate text-xs text-muted-foreground">{question.header}</span>
                ) : null}
                {/* The styled Title adds a bottom margin when no Description follows it. */}
                <QuestionnaireTitle className="text-sm font-medium [&:not(:has(~[data-slot=questionnaire-description]))]:mb-0">
                  {question.question}
                </QuestionnaireTitle>
                {question.multiple ? (
                  <QuestionnaireDescription className="text-[13px]">
                    Select all that apply.
                  </QuestionnaireDescription>
                ) : null}
              </div>
              {expiresAt !== undefined ? (
                <ExpiryCountdown expiresAt={expiresAt} outcome="Dismisses" />
              ) : null}
              {questions.length > 1 ? (
                <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                  {index + 1} of {questions.length}
                </span>
              ) : null}
            </div>
            <QuestionnaireChoices className="gap-1.5">
              {question.options.map((option) => (
                <QuestionnaireChoice
                  key={option.label}
                  value={option.label}
                  className="min-h-9 rounded-xl py-2"
                >
                  <span>{option.label}</span>
                  {option.description ? (
                    <QuestionnaireChoiceDescription className="text-[13px]">
                      {option.description}
                    </QuestionnaireChoiceDescription>
                  ) : null}
                </QuestionnaireChoice>
              ))}
              <QuestionnaireInput
                aria-label="Type your own answer"
                placeholder="Type your own answer…"
                className="h-9 rounded-xl px-4"
              />
            </QuestionnaireChoices>
            <QuestionnaireError className="mt-0 px-1 text-[13px]" />
          </QuestionnaireItem>
        ))}
      </div>

      <div className="flex items-center gap-2 border-t border-border px-2 py-2">
        <Button type="button" variant="ghost" size="sm" onClick={onDismiss}>
          Dismiss {shortcutsEnabled ? <Kbd>Esc</Kbd> : null}
        </Button>
        <QuestionnaireActions className="min-h-0 flex-1 sm:min-h-0">
          <QuestionnairePrevious size="sm" variant="ghost" className="min-h-0 justify-self-end">
            Back
          </QuestionnairePrevious>
          <QuestionnaireSkip size="sm" className="min-h-0" />
          <QuestionnaireNext size="sm" className="min-h-0" />
          <QuestionnaireSubmit size="sm" className="min-h-0" />
        </QuestionnaireActions>
      </div>
    </Questionnaire>
  );
}
