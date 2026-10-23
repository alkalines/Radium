import * as React from "react";
import Animated, {
  cancelAnimation,
  ReduceMotion,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { Text } from "@/components/ui/text";

const AnimatedText = Animated.createAnimatedComponent(Text);

/** Native equivalent of the running-title shimmer, shared by Trace and attachments. Respects reduced motion and cancels on unmount. */
export function ActivityText({
  active,
  style,
  ...props
}: React.ComponentProps<typeof Text> & { active: boolean }) {
  const opacity = useSharedValue(1);
  const reduceMotion = useReducedMotion();
  React.useEffect(() => {
    opacity.value =
      active && !reduceMotion
        ? withRepeat(
            withTiming(0.5, { duration: 900, reduceMotion: ReduceMotion.System }),
            -1,
            true,
          )
        : 1;
    return () => cancelAnimation(opacity);
  }, [active, opacity, reduceMotion]);
  const animatedStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return <AnimatedText {...props} style={[style, animatedStyle]} />;
}
