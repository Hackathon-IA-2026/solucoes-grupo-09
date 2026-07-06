import { useCallback, useState } from "react";
import type { LayoutChangeEvent } from "react-native";

/**
 * Container-query breakpoints: measure the element itself via `onLayout`
 * instead of trusting window dimensions (which are unreliable during
 * static-render hydration on web, and wrong for split-screen on iPad anyway).
 * Width is 0 on the first pass, so layouts must default mobile-first.
 */
export function useContainerWidth(): [number, (event: LayoutChangeEvent) => void] {
  const [width, setWidth] = useState(0);
  const onLayout = useCallback((event: LayoutChangeEvent) => {
    setWidth(Math.round(event.nativeEvent.layout.width));
  }, []);
  return [width, onLayout];
}
