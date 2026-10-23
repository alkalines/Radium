import { Button } from "@/components/ui/button";
import { Marker, MarkerContent } from "@/components/ui/marker";
import { Text } from "@/components/ui/text";

/** Explicit restoration affordance. The caller owns confirmation, persistence and authorization. */
export function Checkpoint({
  label,
  restore,
  disabled = false,
}: {
  label: string;
  restore: () => void;
  disabled?: boolean;
}) {
  return (
    <Marker variant="separator">
      <MarkerContent>
        <Text className="text-xs text-muted-foreground">{label}</Text>
        <Button size="sm" variant="outline" disabled={disabled} onPress={restore}>
          <Text>Restore</Text>
        </Button>
      </MarkerContent>
    </Marker>
  );
}
