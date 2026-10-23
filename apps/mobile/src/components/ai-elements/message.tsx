import { Copy } from "lucide-react-native";
import { Button } from "@/components/ui/button";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Icon } from "@/components/ui/icon";
import { Message, MessageContent, MessageFooter } from "@/components/ui/message";
import { Markdown } from "./markdown";
import type { ReactNode } from "react";

export {
  Message,
  MessageAvatar,
  MessageContent,
  MessageFooter,
  MessageGroup,
  MessageHeader,
} from "@/components/ui/message";

/** User bubble or assistant reply with caller-owned activity and actions. No transport or credentials are embedded. */
export function MessageTurn({
  role,
  text,
  children,
  actions,
  copy,
}: {
  role: "user" | "assistant" | "system";
  text: string;
  children?: ReactNode;
  actions?: ReactNode;
  copy?: () => void;
}) {
  if (role === "user")
    return (
      <Message align="end">
        <MessageContent>
          <Bubble align="end" variant="muted">
            <BubbleContent>{text}</BubbleContent>
          </Bubble>
        </MessageContent>
      </Message>
    );
  return (
    <Message>
      <MessageContent className="w-full gap-3">
        {children}
        {text.length > 0 && <Markdown>{text}</Markdown>}
        {(actions || copy) && (
          <MessageFooter>
            {copy && (
              <Button variant="ghost" size="icon" accessibilityLabel="Copy response" onPress={copy}>
                <Icon as={Copy} className="size-4" />
              </Button>
            )}
            {actions}
          </MessageFooter>
        )}
      </MessageContent>
    </Message>
  );
}
