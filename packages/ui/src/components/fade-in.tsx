import { type PropsWithChildren, useEffect, useRef } from "react";
import { Animated, Platform, type ViewProps } from "react-native";
import { useReducedMotion } from "../hooks/use-reduced-motion";
import { motion } from "../tokens";

interface FadeInProps extends ViewProps {
  /** Slide-up distance in px (0 = pure fade). */
  distance?: number;
  duration?: number;
  /** Stagger delay before the animation starts (reference animate-rise). */
  delay?: number;
  /** Add a 0.9→1 scale (reference animate-pop, for bubbles/tooltips). */
  pop?: boolean;
}

/**
 * Mount fade/slide-in on React Native's core Animated — deliberately not
 * Reanimated, which would add ~½MB to the web bundle for an effect this
 * simple. Skips straight to the final state under prefers-reduced-motion.
 */
export function FadeIn({
  children,
  distance = 12,
  duration = motion.slow,
  delay = 0,
  pop = false,
  style,
  ...rest
}: PropsWithChildren<FadeInProps>) {
  const reducedMotion = useReducedMotion();
  const progress = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (reducedMotion) {
      progress.setValue(1);
      return;
    }
    const animation = Animated.timing(progress, {
      toValue: 1,
      duration,
      delay,
      // The native driver doesn't exist on web; RNW animates on the JS thread.
      useNativeDriver: Platform.OS !== "web",
    });
    animation.start();
    return () => animation.stop();
  }, [progress, duration, delay, reducedMotion]);

  return (
    <Animated.View
      {...rest}
      style={[
        style,
        {
          opacity: progress,
          transform: [
            {
              translateY: progress.interpolate({
                inputRange: [0, 1],
                outputRange: [distance, 0],
              }),
            },
            ...(pop
              ? [
                  {
                    scale: progress.interpolate({
                      inputRange: [0, 1],
                      outputRange: [0.9, 1],
                    }),
                  },
                ]
              : []),
          ],
        },
      ]}
    >
      {children}
    </Animated.View>
  );
}
