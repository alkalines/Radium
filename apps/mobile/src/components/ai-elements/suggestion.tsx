import { ScrollView } from "react-native";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";

/** Horizontally scrollable suggested prompts. Sends only after an explicit press. */
export function Suggestions({
  suggestions,
  send,
  disabled = false,
}: {
  suggestions: string[];
  send: (suggestion: string) => void;
  disabled?: boolean;
}) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerClassName="gap-2">
      <>
        {suggestions.map((suggestion, index) => (
          <Button
            key={`${index}-${suggestion}`}
            variant="outline"
            size="sm"
            disabled={disabled}
            onPress={() => send(suggestion)}
          >
            <Text>{suggestion}</Text>
          </Button>
        ))}
      </>
    </ScrollView>
  );
}
