import * as Clipboard from "expo-clipboard";
import { Check, Copy } from "lucide-react-native";
import * as React from "react";
import { ScrollView, View } from "react-native";
import { Button, type ButtonProps } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Text, TextClassContext } from "@/components/ui/text";
import { cn } from "@/lib/utils";

const SizeContext = React.createContext<"default" | "sm">("default");

/** Selectable tool output surface. No code is evaluated or executed. */
export function CodeBlock({
  variant = "default",
  size = "default",
  className,
  ...props
}: React.ComponentProps<typeof View> & {
  variant?: "default" | "destructive";
  size?: "default" | "sm";
}) {
  return (
    <SizeContext.Provider value={size}>
      <TextClassContext.Provider
        value={variant === "destructive" ? "text-destructive" : "text-foreground"}
      >
        <View
          className={cn(
            "w-full overflow-hidden rounded-lg border border-border bg-muted",
            variant === "destructive" && "border-destructive/30",
            className,
          )}
          {...props}
        />
      </TextClassContext.Provider>
    </SizeContext.Provider>
  );
}
/** Filename and actions above the output. */
export function CodeBlockHeader({ className, ...props }: React.ComponentProps<typeof View>) {
  return (
    <View
      className={cn("flex-row items-center gap-2 border-b border-border px-3 py-2", className)}
      {...props}
    />
  );
}
/** Truncating filename or label. */
export function CodeBlockTitle({ className, ...props }: React.ComponentProps<typeof Text>) {
  return (
    <Text numberOfLines={1} className={cn("flex-1 text-xs font-medium", className)} {...props} />
  );
}
/** Header actions; use alongside, never inside, a disclosure trigger. */
export function CodeBlockActions({ className, ...props }: React.ComponentProps<typeof View>) {
  return <View className={cn("flex-row items-center gap-1", className)} {...props} />;
}
/** Copies only on explicit press; clipboard rejection is surfaced via onError. */
export function CodeBlockCopyButton({
  value,
  onError,
  onPress,
  ...props
}: ButtonProps & { value: string; onError?: (error: unknown) => void }) {
  const [copied, setCopied] = React.useState(false);
  React.useEffect(() => {
    setCopied(false);
  }, [value]);
  return (
    <Button
      variant="ghost"
      size="icon"
      accessibilityLabel={copied ? "Copied" : "Copy code"}
      {...props}
      onPress={async (event) => {
        onPress?.(event);
        if (event.isDefaultPrevented()) return;
        try {
          const success = await Clipboard.setStringAsync(value);
          if (!success) throw new Error("Clipboard access was denied.");
          setCopied(true);
        } catch (error) {
          onError?.(error);
        }
      }}
    >
      <Icon as={copied ? Check : Copy} className="size-4" />
    </Button>
  );
}
/** Scrolls long output horizontally unless wrap is set; strings support line numbers. */
export function CodeBlockContent({
  wrap = false,
  lineNumbers = false,
  startLine = 1,
  className,
  children,
  ...props
}: React.ComponentProps<typeof ScrollView> & {
  wrap?: boolean;
  lineNumbers?: boolean;
  startLine?: number;
}) {
  const size = React.useContext(SizeContext);
  const content =
    typeof children === "string"
      ? children
          .replace(/\n$/, "")
          .split("\n")
          .map((line, index) => (
            <View key={index} className="flex-row gap-4">
              {lineNumbers && (
                <Text
                  className="w-8 text-right font-mono text-xs text-muted-foreground"
                  selectable={false}
                >
                  {startLine + index}
                </Text>
              )}
              <CodeBlockLine className={wrap ? "flex-1" : undefined}>{line || " "}</CodeBlockLine>
            </View>
          ))
      : children;
  return (
    <ScrollView
      horizontal={!wrap}
      nestedScrollEnabled
      className={cn(size === "sm" ? "p-3" : "p-4", className)}
      {...props}
    >
      <View className={cn("gap-0.5", wrap && "w-full")}>{content}</View>
    </ScrollView>
  );
}
/** One selectable diff or output line. Syntax highlighting can be supplied as Text children. */
export function CodeBlockLine({
  variant = "default",
  className,
  ...props
}: Omit<React.ComponentProps<typeof Text>, "variant"> & {
  variant?: "default" | "added" | "removed" | "highlighted";
}) {
  const size = React.useContext(SizeContext);
  return (
    <Text
      selectable
      className={cn(
        "font-mono leading-5",
        size === "sm" ? "text-xs" : "text-sm",
        variant === "added" && "bg-primary/10",
        variant === "removed" && "bg-destructive/10 text-destructive",
        variant === "highlighted" && "bg-accent",
        className,
      )}
      {...props}
    />
  );
}
/** Controls below the output. */
export function CodeBlockFooter({ className, ...props }: React.ComponentProps<typeof View>) {
  return (
    <View
      className={cn("flex-row items-center gap-2 border-t border-border px-3 py-2", className)}
      {...props}
    />
  );
}
