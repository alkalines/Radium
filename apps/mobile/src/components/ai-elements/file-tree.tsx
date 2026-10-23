import * as Collapsible from "@rn-primitives/collapsible";
import * as React from "react";
import { ChevronRight, File, Folder } from "lucide-react-native";
import { View } from "react-native";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";

/** File/folder data from the current recursive FileTreeNode pattern. Paths are opaque display identifiers. */
export type FileNode =
  | { type: "file"; name: string; path: string }
  | { type: "folder"; name: string; path: string; children: FileNode[] };

/** Native disclosure tree. Selecting a file delegates navigation to the owning screen. */
export function FileTreeNode({
  node,
  onSelect,
}: {
  node: FileNode;
  onSelect: (path: string) => void;
}) {
  const [open, setOpen] = React.useState(true);
  if (node.type === "folder")
    return (
      <Collapsible.Root open={open} onOpenChange={setOpen}>
        <Collapsible.Trigger asChild>
          <Button variant="ghost" size="sm" className="justify-start">
            <Icon as={ChevronRight} className={cn("size-4", open && "rotate-90")} />
            <Icon as={Folder} className="size-4" />
            <Text className="shrink" numberOfLines={1}>
              {node.name}
            </Text>
          </Button>
        </Collapsible.Trigger>
        <Collapsible.Content>
          <View className="ml-4">
            {node.children.map((child) => (
              <FileTreeNode key={child.path} node={child} onSelect={onSelect} />
            ))}
          </View>
        </Collapsible.Content>
      </Collapsible.Root>
    );
  return (
    <Button variant="ghost" size="sm" className="justify-start" onPress={() => onSelect(node.path)}>
      <Icon as={File} className="size-4" />
      <Text className="shrink" numberOfLines={1}>
        {node.name}
      </Text>
    </Button>
  );
}
