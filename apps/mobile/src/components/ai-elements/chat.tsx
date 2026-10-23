import * as React from "react";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";

export {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
  useMessageScroller,
  useMessageScrollerScrollable,
  useMessageScrollerVisibility,
} from "@/components/ui/message-scroller";

/** Current Chat composition. Supply MessageScrollerItem children; transport and composer stay with the screen. */
export function Chat({ children, ...props }: React.ComponentProps<typeof MessageScrollerProvider>) {
  return (
    <MessageScrollerProvider autoScroll {...props}>
      <MessageScroller>
        <MessageScrollerViewport>
          <MessageScrollerContent>{children}</MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton />
      </MessageScroller>
    </MessageScrollerProvider>
  );
}
