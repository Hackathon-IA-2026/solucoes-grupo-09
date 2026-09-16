/**
 * The briefing, on screen.
 *
 * It **overlays** the current screen rather than navigating to one. A reader
 * who asks a question mid-comparison should get their answer and then be
 * exactly where they were, and a route change would cost them the selection,
 * the scroll position and the back button.
 *
 * The stage is deliberately passive: it is handed a plan and a cursor and it
 * draws them. Everything about *when* a scene changes lives in
 * `lib/voice/briefing/clock.ts`, which owns no timer of its own and can be
 * tested with three numbers. This file has no timing logic to get wrong.
 */

import {
  focusRing,
  Panel,
  radius,
  space,
  usePalette,
  useReducedMotion,
} from "@wattsteer/ui";
import { Platform, Pressable, Text, View } from "react-native";
import type { BriefingData } from "@/components/briefing/briefing-data";
import { SceneRenderer } from "@/components/briefing/scene-renderer";
import { useCopy } from "@/i18n";
import { fill } from "@/i18n/format";
import type { BriefingCursor } from "@/lib/voice/briefing/clock";
import type { BriefingPlan } from "@/lib/voice/briefing/types";

export interface BriefingStageProps {
  readonly plan: BriefingPlan;
  readonly cursor: BriefingCursor;
  /**
   * The narration, as text.
   *
   * Always rendered, never only spoken. Audio can be refused by an autoplay
   * policy, turned off, or simply not heard — and a briefing a reader cannot
   * read is a briefing that sometimes says nothing at all.
   */
  readonly narration: string;
  /** True when no audio is playing, so the stage says why it is silent. */
  readonly silent: boolean;
  readonly data: BriefingData;
  readonly onDismiss: () => void;
}

export function BriefingStage({
  plan,
  cursor,
  narration,
  silent,
  data,
  onDismiss,
}: BriefingStageProps) {
  const colors = usePalette();
  const copy = useCopy();
  const reduced = useReducedMotion();
  const timed = cursor.index < 0 ? undefined : cursor.scenes[cursor.index];

  if (timed === undefined) {
    return null;
  }

  return (
    <View
      testID="briefing-stage"
      accessibilityLabel={copy.briefing.label}
      // `dialog` is not in react-native's `AccessibilityRole` union, and it is
      // the correct ARIA role for a surface that takes over the screen. Passed
      // through the web-only escape hatch this codebase already uses for props
      // the native types do not carry.
      {...(Platform.OS === "web"
        ? ({ role: "dialog", "aria-modal": true } as object)
        : null)}
      style={{
        ...(Platform.OS === "web" ? ({ position: "fixed" } as object) : null),
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
        // Dimmed rather than opaque: the screen underneath is the thing being
        // explained, and keeping it faintly visible is what makes the briefing
        // read as the product presenting itself rather than as a modal.
        backgroundColor: "rgba(0, 0, 0, 0.72)",
        alignItems: "center",
        justifyContent: "center",
        padding: space.lg,
      }}
    >
      <Panel style={{ width: "100%", maxWidth: 720, gap: space.lg }}>
        <View
          style={{
            flexDirection: "row",
            flexWrap: "wrap",
            alignItems: "center",
            justifyContent: "space-between",
            gap: space.sm,
          }}
        >
          <Text
            // The position is spoken by a screen reader as the sequence moves,
            // which is the only way a non-sighted reader can tell that it is
            // moving at all.
            accessibilityRole="progressbar"
            style={{ fontSize: 12, color: colors.inkFaint }}
          >
            {fill(copy.briefing.position, {
              index: String(cursor.index + 1),
              total: String(cursor.scenes.length),
            })}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={copy.briefing.dismiss}
            onPress={onDismiss}
            hitSlop={8}
            style={(state) => {
              const { focused = false, hovered = false } = state as {
                focused?: boolean;
                hovered?: boolean;
              };
              return {
                borderRadius: radius.pill,
                borderWidth: 1,
                borderColor: colors.border,
                backgroundColor: hovered ? colors.surfaceSunken : "transparent",
                paddingHorizontal: 12,
                paddingVertical: 4,
                ...focusRing(focused, colors.focus),
                ...(Platform.OS === "web" ? ({ cursor: "pointer" } as object) : null),
              };
            }}
          >
            <Text style={{ fontSize: 12, fontWeight: "600", color: colors.inkMuted }}>
              {copy.briefing.dismiss}
            </Text>
          </Pressable>
        </View>

        <View
          // `key` on the scene index, so a scene mounts fresh rather than
          // morphing into the next one. Under reduced motion the mount is a
          // cut, which is the same rule the map and the orb already follow.
          key={reduced ? "static" : cursor.index}
          style={{ minHeight: 240, justifyContent: "center" }}
        >
          <SceneRenderer scene={timed.scene} data={data} />
        </View>

        {silent ? (
          <Text style={{ fontSize: 11, color: colors.inkFaint }}>
            {copy.briefing.silent}
          </Text>
        ) : null}

        <Text style={{ fontSize: 13, lineHeight: 20, color: colors.inkMuted }}>
          {narration}
        </Text>

        {/*
          The reads, spelled out under every briefing. A briefing is a claim,
          and this product's standing rule is that a claim says where it came
          from — the same vocabulary `ForecastStamp` and `ObservedBadge` carry
          on the screens.
        */}
        {plan.sources.length === 0 ? null : (
          <Text style={{ fontSize: 11, lineHeight: 17, color: colors.inkFaint }}>
            {plan.sources.map((source) => source.read).join(" · ")}
          </Text>
        )}
      </Panel>
    </View>
  );
}
