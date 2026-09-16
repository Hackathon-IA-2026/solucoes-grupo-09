/**
 * The briefing, on screen.
 *
 * It **overlays** the current screen rather than navigating to one. A reader
 * who asks a question mid-comparison should get their answer and then be
 * exactly where they were, and a route change would cost them the selection,
 * the scroll position and the back button.
 *
 * The stage is deliberately passive about *time*: it is handed a plan and a
 * cursor and it draws them. Everything about when a scene changes lives in
 * `lib/voice/briefing/clock.ts`, which owns no timer of its own and can be
 * tested with three numbers. What this file owns is how a scene *arrives*.
 */

import {
  focusRing,
  motion,
  Panel,
  radius,
  space,
  type as typography,
  usePalette,
  useReducedMotion,
} from "@wattsteer/ui";
import type { ReactNode } from "react";
import { useEffect, useRef } from "react";
import { Animated, Platform, Pressable, Text, View } from "react-native";
import type { BriefingData } from "@/components/briefing/briefing-data";
import { SceneRenderer } from "@/components/briefing/scene-renderer";
import { useCopy } from "@/i18n";
import { fill } from "@/i18n/format";
import type { BriefingCursor } from "@/lib/voice/briefing/clock";
import type { BriefingPlan } from "@/lib/voice/briefing/types";

/** How far a scene rises as it arrives. The plan's figure (§5.2). */
const RISE_PX = 8;

/**
 * The fraction of a scene spent arriving.
 *
 * A proportion rather than a duration, because scenes are not all the same
 * length and `clock.ts` may compress them further against a short narration. At
 * 0.12 a 2,200 ms title spends ~260 ms arriving and a 4,800 ms fan chart ~575 —
 * both near `motion.base`, without either being pinned to it while the other
 * drifts.
 */
const ENTER_FRACTION = 0.12;

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
  /** Close on Escape. Web only — the native build has no `document`. */
  readonly escapeToDismiss?: boolean;
}

export function BriefingStage({
  plan,
  cursor,
  narration,
  silent,
  data,
  onDismiss,
  escapeToDismiss = false,
}: BriefingStageProps) {
  const colors = usePalette();
  const copy = useCopy();
  const reduced = useReducedMotion();
  const timed = cursor.index < 0 ? undefined : cursor.scenes[cursor.index];

  /*
    Escape closes it, which is what a reader expects of anything covering the
    screen — and the only way out for someone on a keyboard who has not yet
    reached the close control. Registered on the document rather than on the
    overlay because the overlay is not focused: nothing here steals focus, so a
    key handler bound to it would never fire.
  */
  useEffect(() => {
    if (!escapeToDismiss) {
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onDismiss();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [escapeToDismiss, onDismiss]);

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
        // `fixed` on web so a briefing stays put while the screen under it
        // scrolls; `absolute` on native, which has no fixed positioning — and
        // without either, the four offsets below do nothing at all.
        position: Platform.OS === "web" ? ("fixed" as "absolute") : "absolute",
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
        // Dimmed rather than opaque: the screen underneath is the thing being
        // explained, and keeping it faintly visible is what makes the briefing
        // read as the product presenting itself rather than as a modal.
        backgroundColor: colors.scrim,
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
            accessibilityValue={{
              min: 1,
              max: cursor.scenes.length,
              now: cursor.index + 1,
            }}
            style={{ ...typography.caption, color: colors.inkFaint }}
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
            <Text style={{ ...typography.caption, color: colors.inkMuted }}>
              {copy.briefing.dismiss}
            </Text>
          </Pressable>
        </View>

        <SceneFrame index={cursor.index} progress={cursor.progress} reduced={reduced}>
          <SceneRenderer scene={timed.scene} data={data} />
        </SceneFrame>

        <ProgressRail cursor={cursor} />

        {silent ? (
          <Text style={{ ...typography.caption, color: colors.inkFaint }}>
            {copy.briefing.silent}
          </Text>
        ) : null}

        {/*
          **Announced, not just printed.** A briefing changes scene under a
          reader who cannot see it and says nothing; the transcript beside it
          already gets this right. `polite` rather than `assertive` because the
          agent is usually speaking the same words aloud at the same moment.
        */}
        <Text
          accessibilityLiveRegion="polite"
          {...(Platform.OS === "web" ? ({ "aria-live": "polite" } as object) : null)}
          style={{ ...typography.bodySmall, color: colors.inkMuted }}
        >
          {narration}
        </Text>

        {/*
          The reads, spelled out under every briefing. A briefing is a claim,
          and this product's standing rule is that a claim says where it came
          from — the same vocabulary `ForecastStamp` and `ObservedBadge` carry
          on the screens.
        */}
        {plan.sources.length === 0 ? null : (
          <View style={{ gap: 2 }}>
            {plan.sources.map((source) => (
              <Text
                key={source.read}
                style={{ ...typography.caption, color: colors.inkFaint }}
              >
                {[source.read, source.asOf, source.fidelity]
                  .filter((part) => part !== null && part !== "")
                  .join(" · ")}
              </Text>
            ))}
          </View>
        )}
      </Panel>
    </View>
  );
}

/**
 * One scene, arriving.
 *
 * **The rise is driven by the cursor, not by a timer of its own.** `clock.ts`
 * already computes how far through the current scene the narration has reached,
 * and a second clock here would run at its own rate and drift from the sentence
 * being spoken. So the travel is a pure function of `progress` — the same number
 * the scene change is decided from, and therefore unable to disagree with it.
 *
 * The opacity is a one-shot on the scene index instead, because a fade driven
 * from `progress` would run backwards when the last scene is *held* past its own
 * duration and `progress` is pinned at 1.
 *
 * Under reduced motion the scene simply appears — the rule the map, the risk bar
 * and the orb already follow.
 */
function SceneFrame({
  index,
  progress,
  reduced,
  children,
}: {
  index: number;
  progress: number;
  reduced: boolean;
  children: ReactNode;
}) {
  const entering = Math.min(1, progress / ENTER_FRACTION);
  const opacity = useRef(new Animated.Value(1)).current;

  // biome-ignore lint/correctness/useExhaustiveDependencies: `index` is the re-run key, not a value the body reads — the fade runs once per scene, and dropping it would leave the first scene's fade to stand for all of them
  useEffect(() => {
    if (reduced) {
      opacity.setValue(1);
      return;
    }
    opacity.setValue(0);
    Animated.timing(opacity, {
      toValue: 1,
      duration: motion.base,
      // `false` on web: react-native-web's native driver cannot animate
      // opacity off the JS thread, and asking for it logs a warning per scene.
      useNativeDriver: Platform.OS !== "web",
    }).start();
    // Keyed on the scene, not on `progress`: the fade runs once per scene, and
    // re-running it every tick would strobe.
  }, [index, reduced, opacity]);

  return (
    <Animated.View
      style={{
        minHeight: 240,
        justifyContent: "center",
        opacity: reduced ? 1 : opacity,
        transform: [{ translateY: reduced ? 0 : RISE_PX * (1 - entering) }],
      }}
    >
      {children}
    </Animated.View>
  );
}

/**
 * Where the briefing has got to, as a rail rather than a number.
 *
 * One segment per scene, filled for those that have played and part-filled for
 * the one playing — so a reader sees both how far in they are and how much is
 * left, which "scene 2 of 5" alone cannot say. Lime on a sunken track, the same
 * pairing every band rail in the product uses.
 *
 * Hidden from assistive technology on purpose: the position line above it
 * already carries this as a `progressbar` with a real value, and announcing the
 * same fact twice per tick would make the live region unusable.
 */
function ProgressRail({ cursor }: { cursor: BriefingCursor }) {
  const colors = usePalette();
  return (
    <View
      accessibilityElementsHidden={true}
      importantForAccessibility="no-hide-descendants"
      style={{ flexDirection: "row", gap: 3 }}
    >
      {cursor.scenes.map((timed, index) => {
        const filled =
          index < cursor.index ? 1 : index === cursor.index ? cursor.progress : 0;
        return (
          <View
            key={`${timed.scene.type}-${timed.start}`}
            style={{
              flex: 1,
              height: 3,
              borderRadius: 2,
              backgroundColor: colors.surfaceSunken,
              overflow: "hidden",
            }}
          >
            <View
              style={{
                width: `${Math.round(filled * 100)}%`,
                height: "100%",
                borderRadius: 2,
                backgroundColor: colors.accent,
              }}
            />
          </View>
        );
      })}
    </View>
  );
}
