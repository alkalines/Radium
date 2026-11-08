import { useAuth } from "@better-auth-ui/react";
import { Eye, EyeOff } from "lucide-react";
import { type ChangeEvent, useState } from "react";

import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";

/**
 * Uncontrolled password input with a show/hide toggle. OPAQUE forms read the value from the form
 * on submit, so passwords never enter React state; `onChange` receives the event for callers
 * that derive something non-secret (the strength score) while typing.
 */
export function PasswordInput({
  id,
  name,
  autoComplete,
  disabled,
  invalid,
  onChange,
}: {
  id: string;
  name: string;
  autoComplete: "current-password" | "new-password";
  disabled?: boolean;
  invalid?: boolean;
  onChange?: (event: ChangeEvent<HTMLInputElement>) => void;
}) {
  const { localization } = useAuth();
  const [isVisible, setIsVisible] = useState(false);
  const toggleLabel = isVisible ? localization.auth.hidePassword : localization.auth.showPassword;

  return (
    <InputGroup>
      <InputGroupInput
        id={id}
        name={name}
        type={isVisible ? "text" : "password"}
        autoComplete={autoComplete}
        required
        disabled={disabled}
        onChange={onChange}
        aria-invalid={invalid}
      />

      <InputGroupAddon align="inline-end">
        <InputGroupButton
          size="icon-xs"
          aria-label={toggleLabel}
          title={toggleLabel}
          onClick={() => setIsVisible((visible) => !visible)}
        >
          {isVisible ? <EyeOff /> : <Eye />}
        </InputGroupButton>
      </InputGroupAddon>
    </InputGroup>
  );
}
