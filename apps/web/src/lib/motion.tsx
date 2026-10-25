import type { ReactNode } from "react";
import { LazyMotion, MotionConfig, domMax, stagger as staggerChildren } from "motion/react";
import type { Transition, Variants } from "motion/react";

/**
 * Motion tokens for the agentic interface. Every `transition` in the web app derives from these
 * values; see `docs/Interface_Design.md` §5 for when each token applies.
 *
 * Durations are in seconds, matching Motion's units.
 */
export const duration = {
  instant: 0.08,
  fast: 0.15,
  base: 0.24,
  /** Ceiling for any non-ambient animation. */
  slow: 0.4,
} as const;

export const ease = {
  out: [0.16, 1, 0.3, 1],
  in: [0.7, 0, 0.84, 0],
  inOut: [0.65, 0, 0.35, 1],
} as const satisfies Record<string, [number, number, number, number]>;

export const spring = {
  snap: { type: "spring", visualDuration: 0.2, bounce: 0 },
  settle: { type: "spring", visualDuration: 0.35, bounce: 0.15 },
  layout: { type: "spring", visualDuration: 0.4, bounce: 0.1 },
} as const satisfies Record<string, Transition>;

export const stagger = {
  step: 0.04,
  /** Siblings past this index enter together with it, keeping total stagger at or under 0.32s. */
  max: 8,
} as const;

export const transitions = {
  enter: { duration: duration.base, ease: ease.out },
  exit: { duration: duration.fast, ease: ease.in },
  feedback: { duration: duration.instant, ease: ease.out },
  layout: spring.layout,
  indicator: spring.snap,
} as const satisfies Record<string, Transition>;

/**
 * Shared choreography variants. Use the `hidden`/`visible`/`exit` labels so parents can cascade
 * into children without repeating state names.
 */
export const variants = {
  /** Element mounts because state changed. */
  reveal: {
    hidden: { opacity: 0, y: 6, filter: "blur(4px)" },
    visible: { opacity: 1, y: 0, filter: "blur(0px)", transition: spring.settle },
    exit: { opacity: 0, y: -4, filter: "blur(2px)", transition: transitions.exit },
  },
  /** Parent of a list whose children use `reveal`. */
  cascade: {
    hidden: {},
    visible: { transition: { delayChildren: staggerChildren(stagger.step) } },
  },
  /** One state view replacing another inside `AnimatePresence`. */
  swap: {
    hidden: { opacity: 0, scale: 0.98 },
    visible: { opacity: 1, scale: 1, transition: spring.settle },
    exit: { opacity: 0, scale: 0.98, transition: transitions.exit },
  },
} as const satisfies Record<string, Variants>;

/**
 * Per-child delay for cascades built without variants, e.g. rows mapped from an array.
 * Indices past `stagger.max` share the last slot so long lists do not lag.
 */
export function cascadeDelay(index: number) {
  return Math.min(index, stagger.max) * stagger.step;
}

/**
 * App-wide Motion setup: lazy-loads the `domMax` feature bundle (animations, gestures, layout)
 * for `m.*` components and turns off transform/layout animation for users who prefer reduced
 * motion. Mounted once in `Providers`.
 */
export function MotionProvider({ children }: { children: ReactNode }) {
  return (
    <LazyMotion features={domMax}>
      <MotionConfig reducedMotion="user">{children}</MotionConfig>
    </LazyMotion>
  );
}
