import * as React from "react";
import {
  type MotionValue,
  useMotionValue,
  useReducedMotion,
  useSpring,
  useTransform,
} from "motion/react";
import * as m from "motion/react-m";

import { cascadeDelay, duration, spring, transitions } from "@/lib/motion";
import { cn } from "@/lib/utils";

/**
 * Glyphs of `public/radium_extended.svg`, split so each letter animates on its own. `offset` is the
 * glyph's x translation and `center` the middle of its ink, both in the source glyph units below.
 */
const glyphs = [
  {
    offset: 1213.541667,
    center: 0.385,
    d: "M0.686,-0L0.555,-0C0.536,-0 0.521,-0.009 0.51,-0.027L0.401,-0.241C0.39,-0.259 0.375,-0.268 0.356,-0.268L0.229,-0.268L0.229,-0L0.084,-0L0.084,-0.387L0.413,-0.387C0.446,-0.387 0.473,-0.396 0.492,-0.413C0.511,-0.43 0.521,-0.453 0.521,-0.481C0.521,-0.509 0.511,-0.532 0.492,-0.549C0.473,-0.566 0.446,-0.575 0.413,-0.575L0.134,-0.575C0.12,-0.575 0.108,-0.58 0.099,-0.59C0.089,-0.599 0.084,-0.611 0.084,-0.625L0.084,-0.7L0.426,-0.7C0.496,-0.7 0.554,-0.68 0.6,-0.64C0.645,-0.601 0.668,-0.548 0.668,-0.483C0.668,-0.437 0.655,-0.397 0.63,-0.363C0.604,-0.33 0.571,-0.305 0.531,-0.288L0.686,-0Z",
  },
  {
    offset: 2077.541667,
    center: 0.376,
    d: "M0.746,-0L0.589,-0L0.375,-0.558L0.157,-0L0.006,-0L0.294,-0.7L0.408,-0.7C0.441,-0.7 0.466,-0.683 0.482,-0.65L0.746,-0Z",
  },
  {
    offset: 2979.941667,
    center: 0.403,
    d: "M0.353,-0L0.279,-0L0.317,-0.098C0.326,-0.118 0.341,-0.128 0.362,-0.128C0.377,-0.128 0.388,-0.129 0.393,-0.13L0.397,-0.131C0.45,-0.142 0.492,-0.168 0.524,-0.208C0.557,-0.248 0.573,-0.294 0.573,-0.347C0.573,-0.412 0.551,-0.466 0.508,-0.508C0.465,-0.55 0.413,-0.571 0.352,-0.571L0.229,-0.571L0.229,-0L0.084,-0L0.084,-0.7L0.353,-0.7C0.424,-0.7 0.488,-0.684 0.543,-0.653C0.599,-0.622 0.643,-0.579 0.675,-0.526C0.707,-0.473 0.723,-0.413 0.723,-0.348C0.723,-0.282 0.707,-0.223 0.673,-0.171C0.64,-0.118 0.596,-0.077 0.54,-0.046C0.485,-0.015 0.422,-0 0.353,-0Z",
  },
  {
    offset: 3908.741667,
    center: 0.152,
    d: "M0.224,-0L0.224,-0.65C0.224,-0.664 0.219,-0.676 0.209,-0.685C0.2,-0.695 0.188,-0.7 0.174,-0.7L0.079,-0.7L0.079,-0L0.224,-0Z",
  },
  {
    offset: 4272.341667,
    center: 0.38,
    d: "M0.38,0.011C0.473,0.011 0.547,-0.017 0.605,-0.072C0.662,-0.127 0.69,-0.204 0.69,-0.302L0.69,-0.649C0.69,-0.663 0.685,-0.675 0.675,-0.684C0.666,-0.694 0.654,-0.699 0.64,-0.699L0.545,-0.699L0.545,-0.302C0.545,-0.249 0.531,-0.206 0.502,-0.173C0.472,-0.14 0.432,-0.123 0.381,-0.123C0.33,-0.123 0.29,-0.139 0.26,-0.172C0.23,-0.205 0.215,-0.248 0.215,-0.302L0.215,-0.699L0.07,-0.699L0.07,-0.302C0.07,-0.207 0.098,-0.131 0.153,-0.074C0.208,-0.017 0.284,0.011 0.38,0.011Z",
  },
  {
    offset: 5184.341667,
    center: 0.462,
    d: "M0.218,-0L0.084,-0L0.084,-0.7L0.221,-0.7C0.251,-0.7 0.275,-0.685 0.292,-0.656L0.462,-0.324L0.632,-0.656C0.649,-0.685 0.673,-0.7 0.703,-0.7L0.792,-0.7L0.46,-0.05L0.218,-0.515L0.218,-0ZM0.84,-0L0.706,-0L0.706,-0.408L0.84,-0.68L0.84,-0Z",
  },
] as const;

// Source geometry: a 6000×1100 viewBox, an outer scale/offset, and 1200-unit glyphs on a shared
// baseline. Letter centers are derived from it so the cursor math matches the drawn ink.
const viewBox = { width: 6000, height: 1100 };
const outer = { scale: 1.230012, x: -1616.656417, y: -587.935629 };
const glyphScale = 1200;
const baseline = 1338.541667;
const capHeight = 0.7 * glyphScale;

/** How far, in wordmark heights, the cursor still pulls on a letter. */
const reach = 1.6;
/**
 * Lift at full proximity and the boot drop, as fractions of the cap height (local units). The drop
 * stays within the spec's 6px enter offset at the 64px size.
 */
const liftRatio = 0.14;
const dropRatio = 0.1;

/** Off-wordmark pointer position, far enough that every letter rests. */
const restingPointer = -100;

const { type: _springType, ...snapSpring } = spring.snap;

/**
 * The Radium wordmark for the empty Session. On mount the letters drop in with a brand-colored
 * charge that cools to the foreground; afterwards each letter lifts and tints toward the brand as
 * the cursor approaches. Solid fills only: the tint is per-letter opacity, never a gradient.
 * Under reduced motion it renders static and attaches no pointer listener.
 */
function RadiumWordmark({ className, ...props }: React.ComponentProps<"svg">) {
  const ref = React.useRef<SVGSVGElement>(null);
  const shouldReduceMotion = useReducedMotion();
  const pointerX = useMotionValue(restingPointer);
  const pointerY = useMotionValue(restingPointer);

  // Track the cursor anywhere in the window, relative to the wordmark, so letters react as it
  // approaches. A hidden Tab has an empty rect and is skipped.
  React.useEffect(() => {
    if (shouldReduceMotion) return;

    function handlePointerMove(event: PointerEvent) {
      const rect = ref.current?.getBoundingClientRect();
      if (!rect || rect.width === 0) return;
      pointerX.set((event.clientX - rect.left) / rect.width);
      pointerY.set((event.clientY - rect.top) / rect.height);
    }

    function handlePointerLeave() {
      pointerX.set(restingPointer);
      pointerY.set(restingPointer);
    }

    window.addEventListener("pointermove", handlePointerMove, { passive: true });
    document.documentElement.addEventListener("pointerleave", handlePointerLeave);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      document.documentElement.removeEventListener("pointerleave", handlePointerLeave);
    };
  }, [shouldReduceMotion, pointerX, pointerY]);

  return (
    <svg
      ref={ref}
      data-slot="radium-wordmark"
      role="img"
      aria-label="Radium"
      viewBox={`0 0 ${viewBox.width} ${viewBox.height}`}
      className={cn("overflow-visible text-foreground", className)}
      {...props}
    >
      <g transform={`matrix(${outer.scale},0,0,${outer.scale},${outer.x},${outer.y})`}>
        {glyphs.map((glyph, index) => (
          <Letter
            key={glyph.offset}
            glyph={glyph}
            index={index}
            pointerX={pointerX}
            pointerY={pointerY}
            isStatic={Boolean(shouldReduceMotion)}
          />
        ))}
      </g>
    </svg>
  );
}

function Letter({
  glyph,
  index,
  pointerX,
  pointerY,
  isStatic,
}: {
  glyph: (typeof glyphs)[number];
  index: number;
  pointerX: MotionValue<number>;
  pointerY: MotionValue<number>;
  isStatic: boolean;
}) {
  const centerX =
    (outer.scale * (glyph.offset + glyphScale * glyph.center) + outer.x) / viewBox.width;
  const aspect = viewBox.width / viewBox.height;

  // 0 when the cursor is beyond `reach`, 1 on the letter; squared so the falloff feels soft.
  const proximity = useTransform([pointerX, pointerY], ([x, y]: number[]) => {
    const distance = Math.hypot((x - centerX) * aspect, y - 0.5);
    const linear = Math.max(0, 1 - distance / reach);
    return linear * linear;
  });
  const smoothed = useSpring(proximity, snapSpring);
  const lift = useTransform(smoothed, (value) => -value * liftRatio * capHeight);
  // Crossfade rather than stack: brand over a fully opaque foreground reads washed out mid-way.
  const foregroundOpacity = useTransform(smoothed, (value) => 1 - value);

  const glyphTransform = `matrix(${glyphScale},0,0,${glyphScale},${glyph.offset},${baseline})`;
  const path = <path d={glyph.d} />;

  if (isStatic) {
    return (
      <g transform={glyphTransform} fill="currentColor">
        {path}
      </g>
    );
  }

  const delay = cascadeDelay(index);

  // Boot is a deliberate exception to `initial={false}` for content present at load: the wordmark
  // only exists in the empty Session, where it is the ambient entrance (spec §5.3).
  return (
    <m.g
      initial={{ opacity: 0, y: dropRatio * capHeight }}
      animate={{ opacity: 1, y: 0, transition: { ...spring.settle, delay } }}
    >
      <m.g style={{ y: lift }}>
        <m.g transform={glyphTransform} fill="currentColor" style={{ opacity: foregroundOpacity }}>
          {path}
        </m.g>
        <m.g
          transform={glyphTransform}
          className="fill-brand"
          initial={{ opacity: 1 }}
          animate={{
            opacity: 0,
            transition: { ...transitions.enter, delay: delay + duration.base },
          }}
        >
          {path}
        </m.g>
        <m.g transform={glyphTransform} className="fill-brand" style={{ opacity: smoothed }}>
          {path}
        </m.g>
      </m.g>
    </m.g>
  );
}

export { RadiumWordmark };
