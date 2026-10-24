import { useState } from "react";

import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group";

/**
 * Inline editor that replaces a user Bubble while it is edited. ⌘/Ctrl+Enter sends the trimmed
 * text, Esc cancels; both consume the key so the Approval gate shortcuts do not also fire.
 */
export function MessageEditor({
  defaultValue,
  onCancel,
  onSubmit,
}: {
  defaultValue: string;
  onCancel: () => void;
  onSubmit: (text: string) => void;
}) {
  const [value, setValue] = useState(defaultValue);
  const trimmedValue = value.trim();

  return (
    <InputGroup className="w-full max-w-xl">
      <InputGroupTextarea
        autoFocus
        aria-label="Edit message"
        className="min-h-20"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            if (trimmedValue) {
              onSubmit(trimmedValue);
            }
          }
          if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          }
        }}
      />
      <InputGroupAddon align="block-end" className="justify-end gap-1">
        <InputGroupButton size="sm" onClick={onCancel}>
          Cancel
        </InputGroupButton>
        <InputGroupButton
          size="sm"
          variant="default"
          disabled={!trimmedValue}
          onClick={() => onSubmit(trimmedValue)}
        >
          Send
        </InputGroupButton>
      </InputGroupAddon>
    </InputGroup>
  );
}
