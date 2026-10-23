import { View } from "react-native";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Text } from "@/components/ui/text";
import { SourceLink } from "./links";

/** Inline source preview. Press replaces hover; the source itself opens only on a second explicit press. */
export function InlineCitation({
  hostname,
  title,
  url,
  onError,
}: {
  hostname: string;
  title: string;
  url: string;
  onError?: (error: unknown) => void;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="secondary" size="sm">
          <Text>{hostname}</Text>
        </Button>
      </PopoverTrigger>
      <PopoverContent>
        <View className="gap-1">
          <Text className="text-sm font-medium">{title}</Text>
          <SourceLink href={url} onError={onError} accessibilityHint="Opens in your browser">
            <Text className="text-sm text-primary underline">{hostname}</Text>
          </SourceLink>
        </View>
      </PopoverContent>
    </Popover>
  );
}
