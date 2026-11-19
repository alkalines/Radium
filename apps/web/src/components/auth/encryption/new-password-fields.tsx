import type { PasswordStrength } from "@better-auth-ui/core";
import { useState } from "react";

import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import {
  MIN_PASSWORD_LENGTH,
  newPasswordProblem,
  passwordStrength,
} from "@/lib/auth/opaque-account";
import { PasswordStrengthBar } from "../password-strength-meter";
import { PasswordInput } from "./password-input";

const EMPTY_STRENGTH: PasswordStrength = { score: 0, level: "empty" };

/**
 * New password plus confirmation for OPAQUE sign-up, change and reset. Uncontrolled: read the
 * result with {@link readNewPassword}. Only the strength score is kept in state.
 */
export function NewPasswordFields({
  label = "Password",
  disabled,
  error,
}: {
  label?: string;
  disabled?: boolean;
  /** Message from the last {@link readNewPassword} failure. */
  error?: string | null;
}) {
  const [strength, setStrength] = useState(EMPTY_STRENGTH);

  return (
    <>
      <Field data-invalid={!!error}>
        <FieldLabel htmlFor="newPassword">{label}</FieldLabel>
        <PasswordInput
          id="newPassword"
          name="newPassword"
          autoComplete="new-password"
          disabled={disabled}
          invalid={!!error}
          onChange={(event) => setStrength(passwordStrength(event.target.value))}
        />
        <PasswordStrengthBar strength={strength} />
        <FieldDescription>
          At least {MIN_PASSWORD_LENGTH} characters. It encrypts your chats and cannot be recovered
          by the server.
        </FieldDescription>
        <FieldError>{error}</FieldError>
      </Field>

      <Field>
        <FieldLabel htmlFor="confirmNewPassword">Confirm password</FieldLabel>
        <PasswordInput
          id="confirmNewPassword"
          name="confirmNewPassword"
          autoComplete="new-password"
          disabled={disabled}
        />
      </Field>
    </>
  );
}

/**
 * Reads and checks the {@link NewPasswordFields} of `form`: the password, or a message for the
 * policy or a mismatch.
 */
export function readNewPassword(
  form: HTMLFormElement,
): { password: string; problem: null } | { password: null; problem: string } {
  const formData = new FormData(form);
  const password = String(formData.get("newPassword") ?? "");
  const confirmation = String(formData.get("confirmNewPassword") ?? "");

  const problem = newPasswordProblem(password);
  if (problem) return { password: null, problem };
  if (password !== confirmation) return { password: null, problem: "The passwords do not match." };
  return { password, problem: null };
}
