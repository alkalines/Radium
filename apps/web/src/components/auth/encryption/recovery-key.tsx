import { downloadTextFile } from "@better-auth-ui/core";
import { useCopyToClipboard } from "@better-auth-ui/react";
import { Check, Copy, Download } from "lucide-react";
import { type SyntheticEvent, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";

/** Number of words the user re-enters to prove the recovery key was saved. */
const CONFIRM_WORD_COUNT = 4;

/** Picks distinct random word positions (not secret: only which words to ask for). */
function pickPositions(wordCount: number): number[] {
  const positions = new Set<number>();
  const random = new Uint32Array(1);
  while (positions.size < Math.min(CONFIRM_WORD_COUNT, wordCount)) {
    crypto.getRandomValues(random);
    positions.add(random[0] % wordCount);
  }
  return [...positions].sort((a, b) => a - b);
}

function recoveryKeyText(words: string[]): string {
  return [
    "Radium recovery key",
    `Site: ${window.location.origin}`,
    "",
    words.map((word, index) => `${index + 1}. ${word}`).join("\n"),
    "",
    "Anyone with these words and access to your account can read your encrypted data.",
  ].join("\n");
}

/** Numbered word grid of a phrase. */
export function PhraseWords({ words }: { words: string[] }) {
  return (
    <ol className="grid grid-cols-2 gap-x-4 gap-y-1.5 rounded-xl border border-border bg-muted p-4 font-mono text-[13px] sm:grid-cols-3">
      {words.map((word, index) => (
        // Position is the identity: a phrase can repeat a word, and positions never reorder.
        <li key={index} className="flex gap-2">
          <span className="w-5 text-right text-subtle-foreground tabular-nums">{index + 1}</span>
          <span>{word}</span>
        </li>
      ))}
    </ol>
  );
}

/**
 * Shows a newly generated 24-word recovery key, then asks for four randomly chosen words before
 * calling `onConfirmed` (Authentication.md "Sign-up": skipping is not offered). The words come
 * from the caller, which keeps them outside React state and drops them afterwards.
 */
export function RecoveryKeySetup({
  words,
  confirmLabel,
  pending,
  error,
  onConfirmed,
}: {
  words: string[];
  /** Label of the final button, e.g. "Create account". */
  confirmLabel: string;
  pending?: boolean;
  /** Error of the step that runs after confirmation. */
  error?: string | null;
  onConfirmed: () => void;
}) {
  const [step, setStep] = useState<"show" | "confirm">("show");
  const [positions] = useState(() => pickPositions(words.length));
  const [mismatch, setMismatch] = useState(false);
  const { copied, copy } = useCopyToClipboard({
    onError: () => toast.error("Could not copy the recovery key."),
  });

  if (step === "show") {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-muted-foreground text-sm">
          This recovery key is the only way back to your encrypted chats if you forget your
          password. Store it somewhere safe, such as a password manager. It is shown once.
        </p>

        <PhraseWords words={words} />

        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="outline" onClick={() => copy(words.join(" "))}>
            {copied ? <Check data-icon="inline-start" /> : <Copy data-icon="inline-start" />}
            Copy
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => downloadTextFile(recoveryKeyText(words), "radium-recovery-key.txt")}
          >
            <Download data-icon="inline-start" />
            Download
          </Button>
        </div>

        <Button type="button" onClick={() => setStep("confirm")}>
          I saved my recovery key
        </Button>
      </div>
    );
  }

  const handleSubmit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const matches = positions.every((position) => {
      const typed = String(formData.get(`word-${position}`) ?? "");
      return typed.trim().toLowerCase() === words[position];
    });
    setMismatch(!matches);
    if (matches) onConfirmed();
  };

  return (
    <form onSubmit={handleSubmit}>
      <FieldGroup>
        <p className="text-muted-foreground text-sm">
          Enter these words from your recovery key to confirm you saved it.
        </p>

        <div className="grid grid-cols-2 gap-3">
          {positions.map((position) => (
            <Field key={position} data-invalid={mismatch}>
              <FieldLabel htmlFor={`word-${position}`}>Word {position + 1}</FieldLabel>
              <Input
                id={`word-${position}`}
                name={`word-${position}`}
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                required
                disabled={pending}
                aria-invalid={mismatch}
              />
            </Field>
          ))}
        </div>

        <FieldError>{mismatch ? "These words do not match your recovery key." : error}</FieldError>

        <div className="flex flex-col gap-3">
          <Button type="submit" disabled={pending}>
            {pending && <Spinner />}
            {confirmLabel}
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={pending}
            onClick={() => {
              setMismatch(false);
              setStep("show");
            }}
          >
            Show the recovery key again
          </Button>
        </div>
      </FieldGroup>
    </form>
  );
}

/**
 * Text area for typing a 24-word recovery key or a 12-word device recovery code. Uncontrolled:
 * read it from the form on submit and pass it to `phraseToEntropy`, which normalizes spacing and
 * case and checks the checksum.
 */
export function PhraseField({
  name,
  label,
  wordCount,
  disabled,
  error,
}: {
  name: string;
  label: string;
  wordCount: 12 | 24;
  disabled?: boolean;
  error?: string | null;
}) {
  return (
    <Field data-invalid={!!error}>
      <FieldLabel htmlFor={name}>{label}</FieldLabel>
      <Textarea
        id={name}
        name={name}
        rows={wordCount === 24 ? 4 : 2}
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        required
        disabled={disabled}
        aria-invalid={!!error}
        className="font-mono text-[13px]"
      />
      <FieldDescription>{wordCount} words, separated by spaces.</FieldDescription>
      <FieldError>{error}</FieldError>
    </Field>
  );
}
