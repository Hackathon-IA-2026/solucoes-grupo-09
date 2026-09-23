/**
 * The ⓘ beside a panel title: the panel's explanation, shown only when asked.
 *
 * The dashboard carries its figures bare and its sentences here. An operator
 * who knows what a P10–P90 band is should not read a paragraph under every
 * panel to reach the next figure; one who does not can open it. The text is
 * the same text the panels used to print, so nothing the product states is
 * lost — it moved behind a control.
 *
 * It opens **inline**, as a full-width row under the header it sits in, and
 * never as a floating popover: a box positioned past the header's edge is a
 * horizontal overflow at 320px, which `no-horizontal-overflow.spec.ts` holds
 * every screen to.
 */

import { focusRing, radius, space, usePalette } from "@wattsteer/ui";
import { useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import Svg, { Circle, Path } from "react-native-svg";

function InfoGlyph({ color }: { color: string }) {
  return (
    <Svg width={16} height={16} viewBox="0 0 24 24">
      <Circle cx={12} cy={12} r={10} stroke={color} strokeWidth={2} fill="none" />
      <Path d="M12 11v6" stroke={color} strokeWidth={2} strokeLinecap="round" />
      <Circle cx={12} cy={7.5} r={1.3} fill={color} />
    </Svg>
  );
}

export function InfoHint({
  label,
  points,
  testID,
}: {
  /** What the button is announced as, e.g. "About this panel". */
  label: string;
  points: readonly string[];
  testID?: string;
}) {
  const colors = usePalette();
  const [open, setOpen] = useState(false);
  if (points.length === 0) {
    return null;
  }
  return (
    <>
      <Pressable
        testID={testID}
        accessibilityRole="button"
        accessibilityLabel={label}
        aria-expanded={open}
        onPress={() => setOpen((was) => !was)}
        hitSlop={10}
        style={(state) => {
          const { focused = false } = state as { focused?: boolean };
          return {
            width: 28,
            height: 28,
            borderRadius: radius.pill,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: open ? colors.surfaceSunken : "transparent",
            ...focusRing(focused, colors.focus, 1),
            ...(Platform.OS === "web" ? ({ cursor: "pointer" } as object) : null),
          };
        }}
      >
        <InfoGlyph color={open ? colors.ink : colors.inkMuted} />
      </Pressable>
      {open ? (
        <View
          style={{
            flexBasis: "100%",
            flexShrink: 1,
            minWidth: 0,
            gap: space.xs,
            padding: space.md,
            borderRadius: radius.md,
            backgroundColor: colors.surfaceSunken,
          }}
        >
          {points.map((point) => (
            <Text
              key={point}
              style={{
                fontSize: 12,
                lineHeight: 18,
                color: colors.inkMuted,
                ...(Platform.OS === "web"
                  ? ({ overflowWrap: "anywhere" } as object)
                  : null),
              }}
            >
              {point}
            </Text>
          ))}
        </View>
      ) : null}
    </>
  );
}
