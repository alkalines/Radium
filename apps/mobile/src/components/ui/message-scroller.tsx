import * as React from "react";
import { ArrowDown, ArrowUp } from "lucide-react-native";
import { ScrollView, View } from "react-native";
import { Button, type ButtonProps } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import {
  messageAnchorSpacer,
  messageScrollOffset,
  type MessageLayout,
} from "./message-scroller-layout";

/** Same imperative options as shadcn; smooth maps to native animated scrolling. */
export type MessageScrollOptions = {
  align?: "start" | "center" | "end" | "nearest";
  behavior?: "auto" | "instant" | "smooth";
  scrollMargin?: number;
};
type Controls = {
  scrollToMessage: (messageId: string, options?: MessageScrollOptions) => boolean;
  scrollToStart: (options?: MessageScrollOptions) => boolean;
  scrollToEnd: (options?: MessageScrollOptions) => boolean;
};
type ScrollState = {
  start: boolean;
  end: boolean;
  currentAnchorId: string | null;
  visibleMessageIds: string[];
};
type ContextValue = Controls & {
  scrollRef: React.RefObject<React.ComponentRef<typeof ScrollView> | null>;
  dimensions: React.RefObject<{ viewport: number; content: number; offset: number }>;
  follow: React.RefObject<boolean>;
  autoScroll: boolean;
  scrollEdgeThreshold: number;
  preserveScroll: React.RefObject<boolean>;
  rememberPosition: () => void;
  spacerHeight: number;
  state: ScrollState;
  layout: () => void;
  update: () => void;
  register: (id: string, row: MessageLayout | null) => void;
};
const ScrollerContext = React.createContext<ContextValue | null>(null);
function useScrollerContext() {
  const context = React.useContext(ScrollerContext);
  if (!context) throw new Error("MessageScroller parts must be inside MessageScrollerProvider.");
  return context;
}

/** Native transcript controller. Layout positions are scoped to mounted items; no DOM observers are used. */
export function MessageScrollerProvider({
  children,
  autoScroll = false,
  defaultScrollPosition = "end",
  scrollEdgeThreshold = 8,
  scrollMargin = 0,
  scrollPreviousItemPeek = 64,
}: React.PropsWithChildren<{
  autoScroll?: boolean;
  defaultScrollPosition?: "start" | "end" | "last-anchor";
  scrollEdgeThreshold?: number;
  scrollMargin?: number;
  scrollPreviousItemPeek?: number;
}>) {
  const scrollRef = React.useRef<React.ComponentRef<typeof ScrollView>>(null);
  const dimensions = React.useRef({ viewport: 0, content: 0, offset: 0 });
  const rows = React.useRef(new Map<string, MessageLayout>());
  const initialized = React.useRef(false);
  const pendingAnchor = React.useRef<string | null>(null);
  const lastAnchor = React.useRef<string | null>(null);
  const activeAnchor = React.useRef<string | null>(null);
  const preserveScroll = React.useRef(true);
  const readingAnchor = React.useRef<{ id: string; top: number } | null>(null);
  const spacer = React.useRef(0);
  const [spacerHeight, setSpacerHeight] = React.useState(0);
  const follow = React.useRef(autoScroll);
  const frame = React.useRef<number | null>(null);
  const [state, setState] = React.useState<ScrollState>({
    start: false,
    end: false,
    currentAnchorId: null,
    visibleMessageIds: [],
  });

  const update = React.useCallback(() => {
    const { offset, content, viewport } = dimensions.current;
    const ordered = [...rows.current].sort((a, b) => a[1].y - b[1].y);
    const visibleMessageIds = ordered
      .filter(([, row]) => row.y + row.height > offset && row.y < offset + viewport)
      .map(([id]) => id);
    const anchors = ordered.filter(
      ([, row]) => row.scrollAnchor && row.y <= offset + scrollMargin + scrollEdgeThreshold,
    );
    const currentAnchorId = anchors.at(-1)?.[0] ?? null;
    const start = offset > scrollEdgeThreshold;
    const end = content - viewport - offset > scrollEdgeThreshold;
    setState((previous) =>
      previous.start === start &&
      previous.end === end &&
      previous.currentAnchorId === currentAnchorId &&
      previous.visibleMessageIds.join("\0") === visibleMessageIds.join("\0")
        ? previous
        : { start, end, currentAnchorId, visibleMessageIds },
    );
  }, [scrollEdgeThreshold, scrollMargin]);

  const rememberPosition = React.useCallback(() => {
    const { offset } = dimensions.current;
    const visible = [...rows.current]
      .sort((a, b) => a[1].y - b[1].y)
      .find(([, row]) => row.y + row.height > offset);
    readingAnchor.current = visible ? { id: visible[0], top: visible[1].y - offset } : null;
  }, []);

  const scroll = React.useCallback(
    (y: number, options?: MessageScrollOptions) => {
      if (!scrollRef.current) return false;
      dimensions.current.offset = y;
      scrollRef.current.scrollTo({ y, animated: options?.behavior === "smooth" });
      rememberPosition();
      update();
      return true;
    },
    [rememberPosition, update],
  );

  const scrollToMessage = React.useCallback(
    (id: string, options?: MessageScrollOptions) => {
      const row = rows.current.get(id);
      if (!row) return false;
      follow.current = false;
      return scroll(
        messageScrollOffset(row, {
          ...dimensions.current,
          align: options?.align ?? "start",
          scrollMargin: options?.scrollMargin ?? scrollMargin,
        }),
        options,
      );
    },
    [scroll, scrollMargin],
  );
  const scrollToStart = React.useCallback(
    (options?: MessageScrollOptions) => {
      follow.current = false;
      return scroll(0, options);
    },
    [scroll],
  );
  const scrollToEnd = React.useCallback(
    (options?: MessageScrollOptions) => {
      follow.current = autoScroll;
      return scroll(Math.max(0, dimensions.current.content - dimensions.current.viewport), options);
    },
    [autoScroll, scroll],
  );

  const layout = React.useCallback(() => {
    if (frame.current != null) cancelAnimationFrame(frame.current);
    // Coalesce viewport, content and row layout events before selecting an anchor.
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      const { content, viewport } = dimensions.current;
      if (!viewport || !content || rows.current.size === 0) return;
      const ordered = [...rows.current].sort((a, b) => a[1].y - b[1].y);
      const anchor = ordered.filter(([, row]) => row.scrollAnchor).at(-1);
      if (pendingAnchor.current) activeAnchor.current = pendingAnchor.current;
      const activeRow = activeAnchor.current ? rows.current.get(activeAnchor.current) : undefined;
      const nextSpacer = activeRow
        ? messageAnchorSpacer(
            activeRow.y,
            content - spacer.current,
            viewport,
            scrollMargin + scrollPreviousItemPeek,
          )
        : 0;
      if (Math.abs(nextSpacer - spacer.current) > 0.5) {
        spacer.current = nextSpacer;
        setSpacerHeight(nextSpacer);
        return;
      }
      if (!initialized.current) {
        initialized.current = true;
        if (defaultScrollPosition === "last-anchor" && anchor && content - anchor[1].y > viewport)
          scrollToMessage(anchor[0]);
        else if (defaultScrollPosition !== "start") scrollToEnd();
        else scrollToStart();
        lastAnchor.current = anchor?.[0] ?? null;
      } else if (pendingAnchor.current && pendingAnchor.current !== lastAnchor.current) {
        const id = pendingAnchor.current;
        pendingAnchor.current = null;
        lastAnchor.current = id;
        scrollToMessage(id, { scrollMargin: scrollMargin + scrollPreviousItemPeek });
        follow.current = autoScroll;
      } else if (autoScroll && follow.current) scrollToEnd();
      else if (preserveScroll.current && readingAnchor.current) {
        // The ScrollView has one Content wrapper, so native child-index preservation cannot track rows.
        const row = rows.current.get(readingAnchor.current.id);
        if (row) {
          const target = Math.max(
            0,
            Math.min(row.y - readingAnchor.current.top, content - viewport),
          );
          if (Math.abs(target - dimensions.current.offset) > 0.5) scroll(target);
        }
      }
      update();
    });
  }, [
    autoScroll,
    defaultScrollPosition,
    scrollMargin,
    scrollPreviousItemPeek,
    scrollToEnd,
    scrollToMessage,
    scrollToStart,
    scroll,
    update,
  ]);
  React.useEffect(
    () => () => {
      if (frame.current != null) cancelAnimationFrame(frame.current);
    },
    [],
  );
  const register = React.useCallback(
    (id: string, row: MessageLayout | null) => {
      if (!row) {
        rows.current.delete(id);
        update();
        return;
      }
      // Prepending history must not be mistaken for a newly appended user turn.
      const previousLastY = Math.max(-1, ...[...rows.current.values()].map((item) => item.y));
      if (initialized.current && !rows.current.has(id) && row.scrollAnchor && row.y > previousLastY)
        pendingAnchor.current = id;
      rows.current.set(id, row);
      layout();
    },
    [layout, update],
  );
  return (
    <ScrollerContext.Provider
      value={{
        scrollRef,
        dimensions,
        follow,
        autoScroll,
        scrollEdgeThreshold,
        preserveScroll,
        rememberPosition,
        spacerHeight,
        state,
        layout,
        update,
        register,
        scrollToMessage,
        scrollToEnd,
        scrollToStart,
      }}
    >
      {children}
    </ScrollerContext.Provider>
  );
}

/** Transcript frame; constrain its height through the parent layout. */
export function MessageScroller({ className, ...props }: React.ComponentProps<typeof View>) {
  return <View className={cn("relative min-h-0 flex-1", className)} {...props} />;
}
/** Native scroll viewport; preserves the first visible row when older history is prepended. */
export function MessageScrollerViewport({
  preserveScrollOnPrepend = true,
  className,
  onScroll,
  onLayout,
  onContentSizeChange,
  onScrollBeginDrag,
  ...props
}: React.ComponentProps<typeof ScrollView> & { preserveScrollOnPrepend?: boolean }) {
  const context = useScrollerContext();
  React.useEffect(() => {
    context.preserveScroll.current = preserveScrollOnPrepend;
  }, [context.preserveScroll, preserveScrollOnPrepend]);
  return (
    <ScrollView
      ref={context.scrollRef}
      accessibilityLabel="Messages"
      keyboardShouldPersistTaps="handled"
      scrollEventThrottle={32}
      className={cn("flex-1", className)}
      {...props}
      onLayout={(event) => {
        context.dimensions.current.viewport = event.nativeEvent.layout.height;
        context.layout();
        onLayout?.(event);
      }}
      onContentSizeChange={(width, height) => {
        context.dimensions.current.content = height;
        context.layout();
        onContentSizeChange?.(width, height);
      }}
      onScrollBeginDrag={(event) => {
        context.follow.current = false;
        onScrollBeginDrag?.(event);
      }}
      onScroll={(event) => {
        const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
        context.dimensions.current = {
          offset: contentOffset.y,
          content: contentSize.height,
          viewport: layoutMeasurement.height,
        };
        context.follow.current =
          context.autoScroll &&
          contentSize.height - layoutMeasurement.height - contentOffset.y <=
            context.scrollEdgeThreshold;
        context.rememberPosition();
        context.update();
        onScroll?.(event);
      }}
    />
  );
}
/** Direct children must be MessageScrollerItem so their layout coordinates share one owner. */
export function MessageScrollerContent({
  className,
  children,
  spacerClassName,
  ...props
}: React.ComponentProps<typeof View> & { spacerClassName?: string }) {
  const { spacerHeight } = useScrollerContext();
  return (
    <View className={cn("gap-4 p-4", className)} {...props}>
      {children}
      <View
        className={spacerClassName}
        style={{ height: spacerHeight }}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      />
    </View>
  );
}
/** A stable message or annotation identity, optionally marking a user-turn boundary. */
export function MessageScrollerItem({
  messageId,
  scrollAnchor = false,
  onLayout,
  ...props
}: React.ComponentProps<typeof View> & { messageId: string; scrollAnchor?: boolean }) {
  const { register } = useScrollerContext();
  React.useEffect(() => () => register(messageId, null), [messageId, register]);
  return (
    <View
      {...props}
      onLayout={(event) => {
        const { y, height } = event.nativeEvent.layout;
        register(messageId, { y, height, scrollAnchor });
        onLayout?.(event);
      }}
    />
  );
}
/** Jump control hidden when its target edge is already visible. */
export function MessageScrollerButton({
  direction = "end",
  behavior = "smooth",
  children,
  onPress,
  className,
  ...props
}: ButtonProps & { direction?: "start" | "end"; behavior?: MessageScrollOptions["behavior"] }) {
  const context = useScrollerContext();
  if (!context.state[direction]) return null;
  return (
    <Button
      variant="outline"
      size="icon"
      accessibilityLabel={direction === "end" ? "Jump to latest" : "Jump to start"}
      className={cn("absolute bottom-3 self-center rounded-full", className)}
      {...props}
      onPress={(event) => {
        onPress?.(event);
        if (!event.isDefaultPrevented())
          (direction === "end" ? context.scrollToEnd : context.scrollToStart)({ behavior });
      }}
    >
      {children ?? <Icon as={direction === "end" ? ArrowDown : ArrowUp} className="size-4" />}
    </Button>
  );
}
/** Imperative commands return false when the viewport or target row is not mounted. */
export function useMessageScroller(): Controls {
  const { scrollToMessage, scrollToEnd, scrollToStart } = useScrollerContext();
  return { scrollToMessage, scrollToEnd, scrollToStart };
}
/** Edges with content outside the current viewport. */
export function useMessageScrollerScrollable() {
  const {
    state: { start, end },
  } = useScrollerContext();
  return { start, end };
}
/** Mounted visible row IDs and the most recent user-turn anchor above the reading line. */
export function useMessageScrollerVisibility() {
  const {
    state: { currentAnchorId, visibleMessageIds },
  } = useScrollerContext();
  return { currentAnchorId, visibleMessageIds };
}
