/**
 * The day's twenty-four hours, as a thing you can scrub and play.
 *
 * ## Why it is a slider and not a row of buttons
 *
 * Twenty-four buttons is twenty-four tab stops between the map and whatever is
 * after it, and a keyboard reader who wanted to pass the timeline would press
 * Tab two dozen times. One `slider` is one stop, and the arrow keys mean what
 * they already mean everywhere else. `Home` and `End` jump to the ends, because
 * a reader who knows the pattern will try them.
 *
 * ## Why the bars are here and not in a chart
 *
 * The profile chart answers "what did the day look like"; this answers "where
 * am I in it". They are the same numbers and different questions, and a reader
 * scrubbing needs the shape *under the handle* — a separate chart above would
 * make them look up to find out what they are about to select.
 *
 * ## Motion
 *
 * Play steps the hour on an interval and stops at the end rather than looping:
 * a loop makes a reader who looked away unable to tell a replay from a live
 * feed, and this is a settled day that is not moving. `useReducedMotion`
 * removes the control entirely rather than playing instantly — a reader who
 * asked for less motion did not ask for a slideshow.
 */

import { radius, space, type, usePalette, useReducedMotion } from "@wattsteer/ui";
import { useEffect, useRef } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { useCopy, useFormat } from "@/i18n";
import type { DayHour } from "./use-day-matrix";

/** How long one hour is held while playing. */
const STEP_MS = 420;

export function DayTimeline({
  hours,
  index,
  onIndex,
  playing,
  onPlaying,
}: {
  hours: readonly DayHour[];
  /** Which hour is selected, as an index into `hours`. */
  index: number;
  onIndex: (next: number) => void;
  playing: boolean;
  onPlaying: (next: boolean) => void;
}) {
  const colors = usePalette();
  const copy = useCopy();
  const f = useFormat();
  const reduced = useReducedMotion();
  const latest = useRef({ index, hours: hours.length });
  latest.current = { index, hours: hours.length };

  useEffect(() => {
    if (!playing || reduced) {
      return;
    }
    const id = setInterval(() => {
      const { index: at, hours: count } = latest.current;
      if (at >= count - 1) {
        // Stops rather than loops: a settled day is not moving, and a loop
        // makes a replay indistinguishable from a live feed.
        onPlaying(false);
        return;
      }
      onIndex(at + 1);
    }, STEP_MS);
    return () => clearInterval(id);
  }, [playing, reduced, onIndex, onPlaying]);

  if (hours.length === 0) {
    return null;
  }
  const peak = Math.max(...hours.map((hour) => hour.totalMwh), 1e-9);
  const current = hours[Math.min(index, hours.length - 1)] as DayHour;

  const step = (delta: number) => {
    onPlaying(false);
    onIndex(Math.max(0, Math.min(hours.length - 1, index + delta)));
  };

  return (
    <View style={{ gap: space.sm }}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "baseline",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: space.sm,
        }}
      >
        <Text style={{ ...type.caption, color: colors.inkFaint }}>
          {copy.app.console.timelineLabel}
        </Text>
        <Text
          style={{
            ...type.label,
            color: colors.ink,
            fontVariant: ["tabular-nums"],
          }}
        >
          {`${f.hour(current.hourLocal)} · ${f.compact(current.totalMwh)} MWh`}
        </Text>
      </View>

      <View style={{ flexDirection: "row", alignItems: "flex-end", gap: space.sm }}>
        {reduced ? null : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={playing ? copy.app.console.pause : copy.app.console.play}
            onPress={() => onPlaying(!playing)}
            hitSlop={8}
            style={(state) => {
              const { focused = false } = state as { focused?: boolean };
              return {
                width: 34,
                height: 34,
                borderRadius: radius.pill,
                borderWidth: 1,
                borderColor: colors.border,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: colors.surfaceSunken,
                ...focusRingOf(focused, colors.focus),
                ...(Platform.OS === "web" ? ({ cursor: "pointer" } as object) : null),
              };
            }}
          >
            {/* A glyph, not an icon font: two shapes, and the label above
                carries the meaning for anything that cannot see either. */}
            <Text style={{ ...type.label, color: colors.ink }}>
              {playing ? "❚❚" : "▶"}
            </Text>
          </Pressable>
        )}

        <View
          accessibilityRole="adjustable"
          accessibilityLabel={copy.app.console.timelineLabel}
          accessibilityValue={{
            min: 0,
            max: hours.length - 1,
            now: index,
            text: `${f.hour(current.hourLocal)}, ${f.compact(current.totalMwh)} MWh`,
          }}
          accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
          onAccessibilityAction={(event) =>
            step(event.nativeEvent.actionName === "increment" ? 1 : -1)
          }
          /*
            The web half, spread the way `region-handlers.ts` does it:
            react-native's prop mapping does not carry `onKeyDown`, `tabIndex`
            or the `aria-*` a slider needs, and a keyboard is the thing this
            control is for.

            `preventDefault` on the arrows for the reason the map gives: this
            sits inside a scroll view, and an unhandled arrow scrolls the page
            out from under the reader on the very gesture meant to move along
            it. Space and Enter toggle play, because a reader who has focused a
            transport control will try them.
          */
          {...(Platform.OS === "web"
            ? ({
                role: "slider",
                tabIndex: 0,
                "aria-valuemin": 0,
                "aria-valuemax": hours.length - 1,
                "aria-valuenow": index,
                "aria-valuetext": `${f.hour(current.hourLocal)}, ${f.compact(
                  current.totalMwh,
                )} MWh`,
                onKeyDown: (event: { key: string; preventDefault: () => void }) => {
                  const by: Record<string, number> = {
                    ArrowRight: 1,
                    ArrowUp: 1,
                    ArrowLeft: -1,
                    ArrowDown: -1,
                    Home: -hours.length,
                    End: hours.length,
                  };
                  if (event.key === " " || event.key === "Enter") {
                    event.preventDefault();
                    onPlaying(!playing);
                    return;
                  }
                  const delta = by[event.key];
                  if (delta === undefined) {
                    return;
                  }
                  event.preventDefault();
                  step(delta);
                },
              } as object)
            : null)}
          style={{
            flex: 1,
            flexDirection: "row",
            alignItems: "flex-end",
            gap: 2,
            height: 44,
            paddingHorizontal: 2,
            borderRadius: radius.sm,
          }}
        >
          {hours.map((hour, at) => {
            const selected = at === index;
            const share = hour.totalMwh / peak;
            return (
              <Pressable
                key={hour.hourLocal}
                accessibilityRole="button"
                accessibilityLabel={`${f.hour(hour.hourLocal)}, ${f.compact(
                  hour.totalMwh,
                )} MWh`}
                onPress={() => {
                  onPlaying(false);
                  onIndex(at);
                }}
                style={{ flex: 1, height: "100%", justifyContent: "flex-end" }}
              >
                <View
                  style={{
                    // A floor, so an hour with almost nothing is still a target
                    // and still says "measured, and small" rather than absent.
                    height: `${Math.max(6, share * 100)}%`,
                    borderRadius: 2,
                    backgroundColor: selected ? colors.accent : colors.violet,
                    opacity: selected ? 1 : 0.45,
                  }}
                />
              </Pressable>
            );
          })}
        </View>
      </View>

      <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
        <Text style={{ ...type.caption, color: colors.inkFaint }}>
          {f.hour(hours[0]?.hourLocal ?? 0)}
        </Text>
        <Text style={{ ...type.caption, color: colors.inkFaint }}>
          {f.hour(hours.at(-1)?.hourLocal ?? 23)}
        </Text>
      </View>
    </View>
  );
}

/** The shell's focus ring, inlined to avoid a cycle through `app-shell`. */
function focusRingOf(focused: boolean, colour: string): object {
  return focused
    ? { outlineStyle: "solid", outlineWidth: 2, outlineColor: colour, outlineOffset: 2 }
    : {};
}
