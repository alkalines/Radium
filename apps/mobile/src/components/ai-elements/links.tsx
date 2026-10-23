import * as React from "react";
import { Linking, Pressable } from "react-native";
import { cn } from "@/lib/utils";

/** Opens a user-selected HTTP(S) source. Rejects app/file/executable schemes; callers handle browser failures. */
export async function openSourceUrl(href: string) {
  const url = new URL(href);
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new Error("Only HTTP(S) source links can be opened.");
  await Linking.openURL(url.href);
}

/** Opens only web sources. App/file navigation must be supplied explicitly via onPress. */
export function SourceLink({
  href,
  onError,
  onPress,
  className,
  ...props
}: React.ComponentProps<typeof Pressable> & { href: string; onError?: (error: unknown) => void }) {
  return (
    <Pressable
      role="link"
      className={cn("min-h-11 justify-center rounded-md active:bg-accent", className)}
      {...props}
      onPress={async (event) => {
        onPress?.(event);
        if (event.isDefaultPrevented()) return;
        try {
          await openSourceUrl(href);
        } catch (error) {
          onError?.(error);
        }
      }}
    />
  );
}
