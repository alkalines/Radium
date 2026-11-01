import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  acpAnswerError,
  type AcpInteractionAnswer,
  type AcpInteractionRequest,
} from "backend/src/acp/contract";
import { ExternalLinkIcon, MessageCircleQuestionIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Marker, MarkerContent } from "@/components/ui/marker";
import {
  Questionnaire,
  QuestionnaireActions,
  QuestionnaireChoice,
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
import { ApprovalPromptShell, approvalOverlaySelector } from "../approval-gate";
import {
  choicesFor,
  initialValues,
  formContent,
  formatError,
  type FormRequest,
  type FormValues,
} from "./elicitation-values";

type Request = Extract<AcpInteractionRequest, { kind: "elicitation" }>;
type Answer = Extract<AcpInteractionAnswer, { kind: "elicitation" }>;

/** ACP questions name their requesting agent and preserve the schema's primitive value types. */
export function AcpElicitationPrompt(props: {
  request: Request;
  agentName: string;
  shortcutsEnabled: boolean;
  onAnswer: (answer: Answer) => void;
}) {
  useEffect(() => {
    if (!props.shortcutsEnabled) return;
    function keydown(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented || event.repeat) return;
      if (event.target instanceof Element && event.target.closest(approvalOverlaySelector)) return;
      event.preventDefault();
      props.onAnswer({ kind: "elicitation", action: "cancel" });
    }
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [props.onAnswer, props.shortcutsEnabled]);
  return props.request.mode === "url" ? (
    <UrlPrompt {...props} request={props.request} />
  ) : (
    <FormPrompt {...props} request={props.request} />
  );
}

function FormPrompt({
  request,
  agentName,
  shortcutsEnabled,
  onAnswer,
}: {
  request: FormRequest;
  agentName: string;
  shortcutsEnabled: boolean;
  onAnswer: (answer: Answer) => void;
}) {
  const [values, setValues] = useState<FormValues>(() => initialValues(request));
  const [activeItem, setActiveItem] = useState("f0");
  // Review is not a Questionnaire item: the primitive treats an item without answers as
  // unanswered and refuses to submit until it is skipped.
  const [reviewing, setReviewing] = useState(request.fields.length === 0);
  const [error, setError] = useState<string | null>(null);
  const [items] = useState(() =>
    request.fields.map((field, index) => ({
      name: `f${index}`,
      required: request.required.includes(field.name),
      choices: choicesFor(field).map((choice) => ({ value: choice.value })),
    })),
  );
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (shortcutsEnabled && !reviewing)
      formRef.current
        ?.querySelector<HTMLElement>("[data-slot=questionnaire-item]:not([hidden])")
        ?.focus();
  }, [activeItem, reviewing, shortcutsEnabled]);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const content = formContent(request, values);
    const answer: Answer = { kind: "elicitation", action: "accept", content };
    const message = acpAnswerError(request, answer) ?? formatError(request, content);
    setError(message);
    if (message) return;
    if (!reviewing) {
      setReviewing(true);
      return;
    }
    onAnswer(answer);
  }
  function setValue(name: string, value: string | string[] | undefined) {
    setError(null);
    setValues((previous) => ({ ...previous, [name]: value }));
  }
  const reviewValues = new Map(formContent(request, values).map((entry) => [entry.name, entry]));
  return (
    <Questionnaire
      ref={formRef}
      items={items}
      item={activeItem}
      onItemChange={setActiveItem}
      shortcuts={shortcutsEnabled ? "numbers" : undefined}
      onSubmit={submit}
      data-state="awaiting"
      aria-label={`Questions from ${agentName}`}
      className="gap-0 overflow-hidden rounded-2xl border border-signal-awaiting/40 bg-card group-data-[tray=attached]/prompt-slot:rounded-t-none"
    >
      <div className="flex max-h-[min(28rem,60svh)] flex-col gap-3 overflow-y-auto p-3">
        <Marker className="px-1 text-xs">
          <MessageCircleQuestionIcon />
          <MarkerContent>{agentName} is asking</MarkerContent>
        </Marker>
        {request.title ? <p className="px-1 text-sm font-medium">{request.title}</p> : null}
        {request.description ? (
          <p className="px-1 text-[13px] text-muted-foreground">{request.description}</p>
        ) : null}
        <div hidden={reviewing}>
          {request.fields.map((field, index) => {
            const name = `f${index}`;
            const required = request.required.includes(field.name);
            const choices = choicesFor(field);
            const value = values[name];
            const selected = Array.isArray(value) ? value : value === undefined ? [] : [value];
            const freeText =
              field.type !== "boolean" && field.type !== "array" && choices.length === 0;
            return (
              <QuestionnaireItem
                key={name}
                name={name}
                required={required}
                multiple={field.type === "array"}
                className="gap-3"
              >
                <div className="flex items-start justify-between gap-2 px-1">
                  <QuestionnaireTitle className="text-sm font-medium [&:not(:has(~[data-slot=questionnaire-description]))]:mb-0">
                    {field.title ?? field.name}
                    {required ? <span className="text-muted-foreground"> (required)</span> : null}
                  </QuestionnaireTitle>
                  <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                    {index + 1} of {request.fields.length}
                  </span>
                </div>
                {field.description || index === 0 ? (
                  <QuestionnaireDescription className="px-1 text-[13px]">
                    {field.description ?? request.message}
                  </QuestionnaireDescription>
                ) : null}
                <QuestionnaireChoices className="gap-1.5">
                  {choices.map((choice) => (
                    <QuestionnaireChoice
                      key={choice.value}
                      value={choice.value}
                      checked={selected.includes(choice.value)}
                      onChange={(event) => {
                        setValue(
                          name,
                          field.type === "array"
                            ? event.target.checked
                              ? [...selected, choice.value]
                              : selected.filter((entry) => entry !== choice.value)
                            : choice.value,
                        );
                      }}
                      className="min-h-9 rounded-xl py-2"
                    >
                      <span>{choice.title ?? choice.value}</span>
                    </QuestionnaireChoice>
                  ))}
                  {freeText ? (
                    <QuestionnaireInput
                      aria-label={field.title ?? field.name}
                      placeholder="Type your own answer…"
                      value={typeof value === "string" ? value : ""}
                      onChange={(event) => setValue(name, event.target.value)}
                      type={
                        field.type === "number" || field.type === "integer"
                          ? "number"
                          : field.type === "string" && field.format === "email"
                            ? "email"
                            : field.type === "string" && field.format === "uri"
                              ? "url"
                              : field.type === "string" && field.format === "date"
                                ? "date"
                                : "text"
                      }
                      minLength={field.type === "string" ? field.minLength : undefined}
                      maxLength={field.type === "string" ? field.maxLength : undefined}
                      min={
                        field.type === "number" || field.type === "integer"
                          ? field.minimum
                          : undefined
                      }
                      max={
                        field.type === "number" || field.type === "integer"
                          ? field.maximum
                          : undefined
                      }
                      step={field.type === "integer" ? 1 : "any"}
                      className="h-9 rounded-xl px-4"
                    />
                  ) : null}
                </QuestionnaireChoices>
                <QuestionnaireError className="mt-0 px-1 text-[13px]" />
              </QuestionnaireItem>
            );
          })}
        </div>
        <div hidden={!reviewing} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1 px-1">
            <p className="text-sm font-medium">
              {request.fields.length ? "Review your answers" : request.message}
            </p>
            {request.fields.length ? (
              <p className="text-[13px] text-muted-foreground">
                Check these answers before sending them to the agent.
              </p>
            ) : null}
          </div>
          <dl className="flex flex-col gap-2 px-1">
            {request.fields.map((field, index) => {
              const entry = reviewValues.get(field.name);
              const display =
                entry === undefined
                  ? "Skipped"
                  : Array.isArray(entry.value)
                    ? entry.value
                        .map(
                          (value) =>
                            choicesFor(field).find((choice) => choice.value === value)?.title ??
                            value,
                        )
                        .join(", ") || "No choices"
                    : typeof entry.value === "boolean"
                      ? entry.value
                        ? "Yes"
                        : "No"
                      : (choicesFor(field).find((choice) => choice.value === String(entry.value))
                          ?.title ?? String(entry.value));
              return (
                <div key={field.name} className="flex items-start gap-3">
                  <div className="flex min-w-0 flex-1 flex-col text-[13px]">
                    <dt className="text-muted-foreground">{field.title ?? field.name}</dt>
                    <dd className="break-words whitespace-pre-wrap">{display}</dd>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    onClick={() => {
                      setReviewing(false);
                      setActiveItem(`f${index}`);
                    }}
                  >
                    Edit
                  </Button>
                </div>
              );
            })}
          </dl>
        </div>
        {error ? (
          <p role="alert" className="px-1 text-[13px] text-destructive">
            {error}
          </p>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-border px-2 py-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => onAnswer({ kind: "elicitation", action: "cancel" })}
        >
          Dismiss {shortcutsEnabled ? <Kbd>Esc</Kbd> : null}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => onAnswer({ kind: "elicitation", action: "decline" })}
        >
          Decline
        </Button>
        {reviewing ? (
          <div className="flex flex-1 items-center justify-end gap-2">
            {request.fields.length ? (
              <Button type="button" variant="ghost" size="sm" onClick={() => setReviewing(false)}>
                Back
              </Button>
            ) : null}
            <Button type="submit" size="sm">
              Submit
            </Button>
          </div>
        ) : (
          <QuestionnaireActions className="min-h-0 flex-1 sm:min-h-0">
            <QuestionnairePrevious size="sm" variant="ghost">
              Back
            </QuestionnairePrevious>
            <QuestionnaireSkip size="sm" onClick={() => setValue(activeItem, undefined)} />
            <QuestionnaireNext size="sm" />
            <QuestionnaireSubmit size="sm">Review</QuestionnaireSubmit>
          </QuestionnaireActions>
        )}
      </div>
    </Questionnaire>
  );
}

function UrlPrompt({
  request,
  agentName,
  shortcutsEnabled,
  onAnswer,
}: {
  request: Extract<Request, { mode: "url" }>;
  agentName: string;
  shortcutsEnabled: boolean;
  onAnswer: (answer: Answer) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  let url: URL | undefined;
  try {
    url = new URL(request.url);
  } catch {
    /* An invalid agent URL remains visible but cannot be opened. */
  }
  const canOpen = url?.protocol === "https:" || url?.protocol === "http:";
  const punycode = url?.hostname.split(".").some((label) => label.startsWith("xn--"));
  const parts = /^([^:]+:\/\/(?:[^/@]*@)?)([^/?#]+)([\s\S]*)$/.exec(request.url);
  function open() {
    const answer: Answer = { kind: "elicitation", action: "accept", content: [] };
    const message = acpAnswerError(request, answer);
    if (message) {
      setError(message);
      return;
    }
    if (!canOpen) {
      setError("Only valid HTTP or HTTPS URLs can be opened.");
      return;
    }
    window.open(request.url, "_blank", "noopener,noreferrer");
    onAnswer(answer);
  }
  return (
    <ApprovalPromptShell title={`Request from ${agentName}`}>
      <div className="flex max-h-[min(24rem,50svh)] flex-col gap-3 overflow-y-auto p-4">
        <Marker className="text-xs">
          <ExternalLinkIcon />
          <MarkerContent>{agentName} is asking you to open a link</MarkerContent>
        </Marker>
        <p className="text-sm whitespace-pre-wrap">{request.message}</p>
        <p className="break-all rounded-xl bg-muted p-3 font-mono text-xs">
          {parts ? (
            <>
              {parts[1]}
              <strong className="font-semibold">{parts[2]}</strong>
              {parts[3]}
            </>
          ) : (
            request.url
          )}
        </p>
        {punycode ? (
          <p className="text-[13px] text-signal-awaiting">
            This host uses Punycode ({url?.hostname}). Check its identity carefully before opening.
          </p>
        ) : null}
        {!canOpen ? (
          <p className="text-[13px] text-destructive">
            Only valid HTTP or HTTPS URLs can be opened.
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-[13px] text-destructive">
            {error}
          </p>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border px-2 py-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onAnswer({ kind: "elicitation", action: "cancel" })}
        >
          Cancel {shortcutsEnabled ? <Kbd>Esc</Kbd> : null}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => onAnswer({ kind: "elicitation", action: "decline" })}
        >
          Decline
        </Button>
        <Button size="sm" disabled={!canOpen} onClick={open}>
          <ExternalLinkIcon data-icon="inline-start" />
          Open
        </Button>
      </div>
    </ApprovalPromptShell>
  );
}
