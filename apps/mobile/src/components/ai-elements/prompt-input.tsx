import * as DocumentPicker from "expo-document-picker";
import { ArrowUp, File, Plus, Square, X } from "lucide-react-native";
import * as React from "react";
import { View } from "react-native";
import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle,
} from "@/components/ui/attachment";
import { Icon } from "@/components/ui/icon";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group";
import { Text } from "@/components/ui/text";

/** Local selected documents; the caller uploads them before sending through its transport. */
export type PromptFile = DocumentPicker.DocumentPickerAsset;
/** Controlled composer. Native Return inserts a newline; Send is an explicit action. Files never upload automatically. */
export function PromptInput({
  text,
  setText,
  files = [],
  setFiles,
  onSubmit,
  onStop,
  busy = false,
  disabled = false,
  accept = "*/*",
  maxFiles = 10,
  maxFileSize = 20 * 1024 * 1024,
  placeholder = "Ask the agent to change your code...",
  children,
}: {
  text: string;
  setText: (text: string) => void;
  files?: PromptFile[];
  setFiles?: (files: PromptFile[]) => void;
  onSubmit: (message: { text: string; files: PromptFile[] }) => void | Promise<void>;
  onStop?: () => void;
  busy?: boolean;
  disabled?: boolean;
  accept?: string | string[];
  maxFiles?: number;
  maxFileSize?: number;
  placeholder?: string;
  children?: React.ReactNode;
}) {
  const pending = React.useRef(false);
  const pickingRef = React.useRef(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [picking, setPicking] = React.useState(false);
  const [error, setError] = React.useState<string>();
  const canSend =
    !disabled && !busy && !submitting && !picking && (text.trim().length > 0 || files.length > 0);

  async function submit() {
    if (!canSend || pending.current || pickingRef.current) return;
    pending.current = true;
    setSubmitting(true);
    setError(undefined);
    try {
      await onSubmit({ text, files });
    } catch {
      setError("Could not send your message. Your draft is still here.");
    } finally {
      pending.current = false;
      setSubmitting(false);
    }
  }

  async function pick() {
    if (!setFiles || pickingRef.current || disabled || busy || pending.current) return;
    pickingRef.current = true;
    setPicking(true);
    setError(undefined);
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: accept,
        multiple: true,
        copyToCacheDirectory: true,
      });
      if (result.canceled) return;
      const selected = [...files, ...result.assets];
      if (selected.length > maxFiles) {
        setError(`Choose at most ${maxFiles} files.`);
        return;
      }
      if (result.assets.some((file) => file.size == null || file.size > maxFileSize)) {
        setError("A file is too large or its size could not be determined.");
        return;
      }
      setFiles(selected);
    } catch {
      setError("Could not open the file picker. Try again.");
    } finally {
      pickingRef.current = false;
      setPicking(false);
    }
  }

  return (
    <View className="gap-2">
      {files.length > 0 && (
        <AttachmentGroup>
          {files.map((file, index) => (
            <Attachment key={`${index}-${file.uri}`} size="sm">
              <AttachmentMedia>
                <Icon as={File} className="size-4" />
              </AttachmentMedia>
              <AttachmentContent>
                <AttachmentTitle>{file.name}</AttachmentTitle>
              </AttachmentContent>
              {setFiles && (
                <AttachmentActions>
                  <AttachmentAction
                    accessibilityLabel={`Remove ${file.name}`}
                    disabled={disabled || busy || submitting || picking}
                    onPress={() => setFiles(files.filter((_, fileIndex) => fileIndex !== index))}
                  >
                    <Icon as={X} className="size-4" />
                  </AttachmentAction>
                </AttachmentActions>
              )}
            </Attachment>
          ))}
        </AttachmentGroup>
      )}
      <InputGroup>
        <InputGroupTextarea
          value={text}
          onChangeText={setText}
          editable={!disabled && !submitting}
          accessibilityLabel="Message"
          placeholder={placeholder}
        />
        <InputGroupAddon align="block-end">
          {setFiles && (
            <InputGroupButton
              size="icon-sm"
              accessibilityLabel="Attach files"
              disabled={disabled || busy || submitting || picking}
              onPress={() => void pick()}
            >
              <Icon as={Plus} className="size-4" />
            </InputGroupButton>
          )}
          {children}
          <InputGroupButton
            size="icon-sm"
            variant="default"
            className="ml-auto rounded-full"
            accessibilityLabel={busy ? "Stop generating" : "Send message"}
            disabled={busy ? disabled || !onStop : !canSend}
            onPress={busy ? onStop : () => void submit()}
          >
            <Icon as={busy ? Square : ArrowUp} className="size-4 text-primary-foreground" />
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
      {error && (
        <Text role="alert" className="text-sm text-destructive">
          {error}
        </Text>
      )}
    </View>
  );
}
