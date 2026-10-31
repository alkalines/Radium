import { useEffect, useRef, useState, type ReactNode } from "react";
import type { TodoItem } from "backend/src/chatroom/session-tools";
import { AnimatePresence } from "motion/react";
import * as m from "motion/react-m";
import { ChevronDownIcon, ListTodoIcon } from "lucide-react";

import { duration, spring, transitions, variants } from "@/lib/motion";
import { cn } from "@/lib/utils";

const statusLabel: Record<TodoItem["status"], string> = {
  pending: "Not started",
  in_progress: "In progress",
  completed: "Completed",
};

const markerColor: Record<TodoItem["status"], string> = {
  completed: "text-signal-success",
  in_progress: "text-foreground",
  pending: "text-muted-foreground/60",
};

const textColor: Record<TodoItem["status"], string> = {
  completed: "text-muted-foreground decoration-muted-foreground",
  in_progress: "text-foreground",
  pending: "text-muted-foreground",
};

const rowClassName = "flex min-w-0 items-start gap-2.5 text-[13px] leading-5";
const checkPath = "M4.75 8.25 7 10.5 11.25 5.75";

/** SVG shapes scale and draw around their own centre, not the SVG origin. */
const shapeOrigin = { transformBox: "fill-box", transformOrigin: "center" } as const;

/**
 * The tray rises out of the prompt slot: a clip that opens upwards from the slot's top edge. Once
 * every item is done it holds briefly, so the last check lands, then sinks back.
 */
const trayVariants = {
  hidden: { opacity: 0, clipPath: "inset(100% 0 0 0)" },
  visible: { opacity: 1, clipPath: "inset(0% 0 0 0)", transition: spring.settle },
  exit: {
    opacity: 0,
    clipPath: "inset(100% 0 0 0)",
    transition: { ...transitions.exit, delay: duration.slow },
  },
};

/** Item text: struck through when completed (the decoration colour fades in the tray). */
function TodoText({ item }: { item: TodoItem }) {
  return (
    <span
      className={cn(
        "min-w-0 break-words line-through decoration-transparent transition-colors",
        textColor[item.status],
      )}
    >
      {item.content}
    </span>
  );
}

/**
 * The status box, drawn as one 16px SVG so it stays a true square at any zoom or pixel ratio
 * (a bordered element rounds its edges unevenly at fractional scales). `mt-0.5` centres it on
 * the first 20px text line. Completed is a filled green square with a check; in progress a
 * dot; pending the empty box. `children` adds the inner shapes for the current status.
 */
function MarkerFrame({ status, children }: { status: TodoItem["status"]; children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={16}
      height={16}
      role="img"
      aria-label={statusLabel[status]}
      className={cn(
        "mt-0.5 size-4 shrink-0 overflow-visible transition-colors",
        markerColor[status],
      )}
    >
      <rect
        x="1.5"
        y="1.5"
        width="13"
        height="13"
        rx="2.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1"
      />
      {children}
    </svg>
  );
}

/**
 * The agent's plan from a `todo_write` call, without motion: the call's Trace step shows it as a
 * record. The tray above the prompt animates its own rows (`TodoPanel`).
 */
export function TodoList({ items, className }: { items: TodoItem[]; className?: string }) {
  return (
    <ol className={cn("flex min-w-0 flex-col gap-2", className)}>
      {items.map((item, index) => (
        <li key={index} data-status={item.status} className={rowClassName}>
          <MarkerFrame status={item.status}>
            {item.status === "completed" ? (
              <>
                <rect x="1" y="1" width="14" height="14" rx="3" fill="currentColor" />
                <path
                  d={checkPath}
                  fill="none"
                  strokeWidth="1.75"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="stroke-background"
                />
              </>
            ) : null}
            {item.status === "in_progress" ? (
              <circle cx="8" cy="8" r="2.75" fill="currentColor" />
            ) : null}
          </MarkerFrame>
          <TodoText item={item} />
        </li>
      ))}
    </ol>
  );
}

/**
 * A tray marker: a status reached while watching animates in (the green fill pops and the check
 * draws; the dot grows). The in-progress dot pulses while `isPulsing` (CSS, stopped under reduced
 * motion and when the run stops).
 */
function AnimatedMarker({ status, isPulsing }: { status: TodoItem["status"]; isPulsing: boolean }) {
  return (
    <MarkerFrame status={status}>
      <AnimatePresence initial={false}>
        {status === "completed" ? (
          <m.g key="completed" exit={{ opacity: 0, transition: transitions.exit }}>
            <m.rect
              x="1"
              y="1"
              width="14"
              height="14"
              rx="3"
              fill="currentColor"
              style={shapeOrigin}
              initial={{ scale: 0.6, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={spring.snap}
            />
            <m.path
              d={checkPath}
              fill="none"
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="stroke-background"
              initial={{ pathLength: 0 }}
              animate={{ pathLength: 1 }}
              // The check draws once the fill has popped.
              transition={{ ...transitions.enter, delay: duration.instant }}
            />
          </m.g>
        ) : null}
        {status === "in_progress" ? (
          <m.g key="in-progress" exit={{ opacity: 0, transition: transitions.exit }}>
            {isPulsing ? (
              <circle
                cx="8"
                cy="8"
                r="2.75"
                fill="currentColor"
                style={shapeOrigin}
                className="animate-signal-pulse motion-reduce:animate-none"
              />
            ) : null}
            <m.circle
              cx="8"
              cy="8"
              r="2.75"
              fill="currentColor"
              style={shapeOrigin}
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              transition={spring.snap}
            />
          </m.g>
        ) : null}
      </AnimatePresence>
    </MarkerFrame>
  );
}

/**
 * Stable keys for tray rows: the content, numbered when the same text repeats, so an item keeps
 * its row (and animates its status) across `todo_write` calls that replace the whole list.
 */
function itemKeys(items: TodoItem[]) {
  const seen: Record<string, number> = {};
  return items.map((item) => {
    const count = (seen[item.content] ?? 0) + 1;
    seen[item.content] = count;
    return `${count}:${item.content}`;
  });
}

/**
 * The tray's rows: present on mount they render in place; rows the model adds reveal, rows shift
 * with `layout`, and a status change draws its marker and fades the strikethrough. The item in
 * progress stays scrolled into view.
 */
function TrayList({ items, isRunning }: { items: TodoItem[]; isRunning: boolean }) {
  const keys = itemKeys(items);
  const listRef = useRef<HTMLOListElement>(null);
  const activeIndex = items.findIndex((item) => item.status === "in_progress");

  useEffect(() => {
    if (activeIndex === -1) return;
    listRef.current?.children[activeIndex]?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  return (
    <ol
      ref={listRef}
      className="flex max-h-40 min-w-0 flex-col gap-2 overflow-y-auto px-3.5 pt-0.5 pb-3"
    >
      <AnimatePresence initial={false}>
        {items.map((item, index) => (
          <m.li
            key={keys[index]}
            layout="position"
            variants={variants.reveal}
            initial="hidden"
            animate="visible"
            exit="exit"
            transition={transitions.layout}
            data-status={item.status}
            className={rowClassName}
          >
            <AnimatedMarker status={item.status} isPulsing={isRunning} />
            <TodoText item={item} />
          </m.li>
        ))}
      </AnimatePresence>
    </ol>
  );
}

/**
 * The list the todo tray should show, or `undefined` to drop it: the tray stays while any item is
 * open. A list that just finished is returned for one more commit, because `AnimatePresence` exits
 * with the tray's last render: that render must show the final check, which then lands while the
 * tray holds before sinking back. A list already finished when it first appears never shows.
 */
export function useTodoTrayItems(todos: TodoItem[] | undefined) {
  const isOpen = todos !== undefined && todos.some((todo) => todo.status !== "completed");
  const [wasOpen, setWasOpen] = useState(isOpen);

  useEffect(() => {
    setWasOpen(isOpen);
  }, [isOpen]);

  return isOpen || wasOpen ? todos : undefined;
}

/**
 * The Session's todo list as the top of the prompt slot (Composer, or the prompt that replaces
 * it): the same width with rounded top corners and no bottom border, so the slot's own top border
 * divides them and the pair reads as one extended input. The caller squares the slot's top
 * corners while the tray is attached. Mount it inside `AnimatePresence`: it rises in and, once the
 * caller drops it, sinks back. The header counts completed items and folds the list.
 */
export function TodoPanel({ items, isRunning }: { items: TodoItem[]; isRunning: boolean }) {
  const [isOpen, setIsOpen] = useState(true);
  const completed = items.filter((item) => item.status === "completed").length;
  const current = items.find((item) => item.status === "in_progress");

  return (
    <m.div
      variants={trayVariants}
      initial="hidden"
      animate="visible"
      exit="exit"
      className="flex flex-col overflow-hidden rounded-t-2xl border border-b-0 border-border bg-card"
    >
      <button
        type="button"
        aria-expanded={isOpen}
        onClick={() => setIsOpen((open) => !open)}
        className="flex min-w-0 items-center gap-2 py-2 pr-2.5 pl-3.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        <ListTodoIcon className="size-3.5 shrink-0" />
        <span className="shrink-0 font-medium">Todos</span>
        <span className="relative inline-flex shrink-0 tabular-nums">
          <AnimatePresence mode="popLayout" initial={false}>
            <m.span
              key={completed}
              variants={variants.reveal}
              initial="hidden"
              animate="visible"
              exit="exit"
            >
              {completed}
            </m.span>
          </AnimatePresence>
          /{items.length}
        </span>
        <AnimatePresence initial={false}>
          {!isOpen && current ? (
            <m.span
              key={current.content}
              variants={variants.reveal}
              initial="hidden"
              animate="visible"
              exit="exit"
              className="min-w-0 truncate text-foreground"
            >
              {current.content}
            </m.span>
          ) : null}
        </AnimatePresence>
        <ChevronDownIcon
          className={cn("ml-auto size-3.5 shrink-0 transition-transform", !isOpen && "-rotate-90")}
        />
      </button>
      {isOpen ? <TrayList items={items} isRunning={isRunning} /> : null}
    </m.div>
  );
}
