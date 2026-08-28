import { usePalette } from "@negotiatio/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Platform, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";

const KNOB = 22;
const TRACK_H = 6;

/** Log-scale mapping so R$ 100 → R$ 1M feels linear to the thumb. */
function positionToValue(pos: number, min: number, max: number): number {
  "worklet";
  const t = Math.max(0, Math.min(1, pos));
  return min * (max / min) ** t;
}

function valueToPosition(value: number, min: number, max: number): number {
  "worklet";
  const clamped = Math.max(min, Math.min(max, value));
  return Math.log(clamped / min) / Math.log(max / min);
}

/** Snap to a "nice" money step that scales with magnitude (50 → 10k). */
function niceRound(value: number): number {
  "worklet";
  const step = value < 1000 ? 50 : value < 10_000 ? 100 : value < 100_000 ? 1000 : 10_000;
  return Math.round(value / step) * step;
}

/**
 * Draggable amount slider for the simulation — log scale, lime fill, springy
 * knob that scales up while dragging. Follows external `value` changes (the
 * preset pills) when not being dragged.
 *
 * The pan handler runs entirely on the UI thread; `runOnJS(onChange)` fires
 * only when the *snapped* value actually changes (a `lastSent` shared value
 * dedupes frames), so dragging doesn't flood the JS thread with re-renders.
 */
export function AmountSlider({
  value,
  min = 100,
  max = 1_000_000,
  onChange,
}: {
  value: number;
  min?: number;
  max?: number;
  onChange: (next: number) => void;
}) {
  const colors = usePalette();
  const [trackWidth, setTrackWidth] = useState(0);
  const progress = useSharedValue(valueToPosition(value, min, max));
  const dragging = useSharedValue(false);
  const lastSent = useSharedValue(value);

  // Presets move the knob when the user isn't dragging.
  useEffect(() => {
    if (!dragging.value) {
      lastSent.value = value;
      progress.value = withSpring(valueToPosition(value, min, max), {
        damping: 18,
        stiffness: 180,
      });
    }
  }, [value, min, max, progress, dragging, lastSent]);

  const emit = useCallback((next: number) => onChange(next), [onChange]);

  // The knob travels [0, trackWidth - KNOB]; map the pointer over that same
  // span (centered on the knob) so the thumb tracks the finger exactly.
  const span = Math.max(1, trackWidth - KNOB);

  const pan = useMemo(
    () =>
      Gesture.Pan()
        .onBegin((e) => {
          "worklet";
          dragging.value = true;
          const t = Math.max(0, Math.min(1, (e.x - KNOB / 2) / span));
          progress.value = t;
          const snapped = niceRound(positionToValue(t, min, max));
          if (snapped !== lastSent.value) {
            lastSent.value = snapped;
            runOnJS(emit)(snapped);
          }
        })
        .onUpdate((e) => {
          "worklet";
          const t = Math.max(0, Math.min(1, (e.x - KNOB / 2) / span));
          progress.value = t;
          const snapped = niceRound(positionToValue(t, min, max));
          if (snapped !== lastSent.value) {
            lastSent.value = snapped;
            runOnJS(emit)(snapped);
          }
        })
        .onFinalize(() => {
          "worklet";
          dragging.value = false;
        }),
    [span, min, max, emit, dragging, lastSent, progress],
  );

  const knobScale = useDerivedValue(() =>
    withSpring(dragging.value ? 1.25 : 1, { damping: 14, stiffness: 240 }),
  );

  const fillStyle = useAnimatedStyle(() => ({
    // Fill up to the knob's center so the lime edge always meets the thumb.
    width: progress.value * span + KNOB / 2,
  }));
  const knobStyle = useAnimatedStyle(() => ({
    left: progress.value * span,
    transform: [{ scale: knobScale.value }],
  }));

  return (
    <GestureDetector gesture={pan}>
      <View
        onLayout={(e) => setTrackWidth(Math.round(e.nativeEvent.layout.width))}
        accessibilityRole="adjustable"
        accessibilityLabel="Valor investido"
        style={{
          height: 36,
          justifyContent: "center",
          ...(Platform.OS === "web" ? ({ cursor: "pointer" } as object) : null),
        }}
      >
        {/* track */}
        <View
          style={{
            height: TRACK_H,
            borderRadius: TRACK_H / 2,
            backgroundColor: colors.surfaceSunken,
            overflow: "hidden",
          }}
        >
          <Animated.View
            style={[{ height: TRACK_H, backgroundColor: colors.accent }, fillStyle]}
          />
        </View>
        {/* knob */}
        <Animated.View
          style={[
            {
              position: "absolute",
              width: KNOB,
              height: KNOB,
              borderRadius: KNOB / 2,
              backgroundColor: colors.accent,
              borderWidth: 3,
              borderColor: colors.canvas,
              ...(Platform.OS === "web"
                ? ({ boxShadow: "0 2px 8px rgba(0,0,0,0.4)" } as object)
                : {
                    shadowColor: "#000",
                    shadowOpacity: 0.4,
                    shadowRadius: 4,
                    shadowOffset: { width: 0, height: 2 },
                    elevation: 4,
                  }),
            },
            knobStyle,
          ]}
        />
      </View>
    </GestureDetector>
  );
}
