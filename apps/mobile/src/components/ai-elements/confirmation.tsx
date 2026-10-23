import * as React from "react";
import { Terminal } from "lucide-react-native";
import { View } from "react-native";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";

/** Approval prompt, separate from Trace activity. Callback success is not execution authorization. */
export function Confirmation({
  title,
  description,
  approve,
  deny,
  onError,
  disabled = false,
  className,
  ...props
}: React.ComponentProps<typeof View> & {
  title: string;
  description?: string;
  approve: () => void | Promise<void>;
  deny: () => void | Promise<void>;
  onError?: (error: unknown) => void;
  disabled?: boolean;
}) {
  const pendingRef = React.useRef(false);
  const [pending, setPending] = React.useState(false);
  const [errorMessage, setErrorMessage] = React.useState<string>();
  async function respond(callback: () => void | Promise<void>) {
    if (pendingRef.current || disabled) return;
    pendingRef.current = true;
    setPending(true);
    setErrorMessage(undefined);
    try {
      await callback();
    } catch (error) {
      setErrorMessage("Could not send your response. Try again.");
      onError?.(error);
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }
  return (
    <View className={cn("gap-3 rounded-xl border border-border p-4", className)} {...props}>
      <View className="flex-row items-start gap-3">
        <Icon as={Terminal} className="size-5 text-muted-foreground" />
        <View className="flex-1 gap-1">
          <Text className="text-sm font-medium">{title}</Text>
          {description && <Text className="text-sm text-muted-foreground">{description}</Text>}
        </View>
      </View>
      <View className="flex-row justify-end gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={disabled || pending}
          onPress={() => void respond(deny)}
        >
          <Text>Deny</Text>
        </Button>
        <Button size="sm" disabled={disabled || pending} onPress={() => void respond(approve)}>
          <Text>Approve</Text>
        </Button>
      </View>
      {errorMessage && (
        <Text role="alert" className="text-sm text-destructive">
          {errorMessage}
        </Text>
      )}
    </View>
  );
}
