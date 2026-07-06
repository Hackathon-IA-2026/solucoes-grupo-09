import type { ScrapeState } from "@noviq/core";
import { useEffect, useRef, useState } from "react";
import { Animated, Easing, Platform, Text, View } from "react-native";
import { usePalette } from "@/hooks/use-palette";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import { radius, space } from "@/theme/tokens";
import { Button } from "./button";
import { FadeIn } from "./fade-in";

const STEPS = [
  { key: "queued", title: "Queued", detail: "Waiting for a scraper slot" },
  { key: "scraping", title: "Scraping", detail: "Browsing the store like a human" },
  { key: "done", title: "Done", detail: "Reviews ready to export" },
] as const;

function stepIndex(phase: ScrapeState["phase"]): number {
  if (phase === "submitting" || phase === "queued") return 0;
  if (phase === "scraping") return 1;
  return 2;
}

function Dot({ state }: { state: "done" | "active" | "pending" }) {
  const colors = usePalette();
  const reducedMotion = useReducedMotion();
  const pulse = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (state !== "active" || reducedMotion) {
      pulse.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1.5,
          duration: 900,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: Platform.OS !== "web",
        }),
        Animated.timing(pulse, {
          toValue: 1,
          duration: 900,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: Platform.OS !== "web",
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [state, reducedMotion, pulse]);

  const fill =
    state === "pending"
      ? colors.border
      : state === "done"
        ? colors.success
        : colors.accent;

  return (
    <View
      style={{ width: 28, height: 28, alignItems: "center", justifyContent: "center" }}
    >
      {state === "active" ? (
        <Animated.View
          style={{
            position: "absolute",
            width: 20,
            height: 20,
            borderRadius: 10,
            backgroundColor: colors.accentSoft,
            transform: [{ scale: pulse }],
          }}
        />
      ) : null}
      <View
        style={{
          width: 12,
          height: 12,
          borderRadius: 6,
          backgroundColor: fill,
          alignItems: "center",
          justifyContent: "center",
        }}
      />
    </View>
  );
}

/**
 * Visible system status for the whole job (Nielsen #1): a three-step timeline,
 * a live elapsed clock, and an always-available cancel (user control).
 * Announced politely to screen readers on each phase change.
 */
export function ProgressPanel({
  state,
  onCancel,
}: {
  state: Extract<ScrapeState, { phase: "submitting" | "queued" | "scraping" }>;
  onCancel: () => void;
}) {
  const colors = usePalette();
  const [seconds, setSeconds] = useState(0);
  const current = stepIndex(state.phase);

  useEffect(() => {
    const timer = setInterval(() => setSeconds((value) => value + 1), 1_000);
    return () => clearInterval(timer);
  }, []);

  const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

  return (
    <FadeIn
      duration={220}
      distance={0}
      testID="progress-panel"
      accessibilityLiveRegion="polite"
      accessibilityLabel={`Scrape ${STEPS[current].title}, ${clock} elapsed`}
      style={{
        backgroundColor: colors.surface,
        borderRadius: radius.xl,
        borderCurve: "continuous",
        borderWidth: 1,
        borderColor: colors.border,
        padding: space.xl,
        gap: space.lg,
        width: "100%",
      }}
    >
      <View
        style={{
          flexDirection: "row",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <Text style={{ color: colors.ink, fontSize: 18, fontWeight: "800" }}>
          Scraping {state.request.appId}
        </Text>
        <Text
          style={{
            color: colors.inkMuted,
            fontSize: 14,
            fontWeight: "600",
            fontVariant: ["tabular-nums"],
          }}
        >
          {clock}
        </Text>
      </View>

      <View style={{ gap: space.md }}>
        {STEPS.map((step, index) => {
          const status =
            index < current ? "done" : index === current ? "active" : "pending";
          return (
            <View
              key={step.key}
              style={{ flexDirection: "row", alignItems: "center", gap: space.md }}
            >
              <Dot state={status} />
              <View style={{ flex: 1 }}>
                <Text
                  style={{
                    color: status === "pending" ? colors.inkFaint : colors.ink,
                    fontSize: 15,
                    fontWeight: status === "active" ? "700" : "600",
                  }}
                >
                  {step.title}
                </Text>
                {status === "active" ? (
                  <Text style={{ color: colors.inkMuted, fontSize: 13 }}>
                    {step.detail}
                  </Text>
                ) : null}
              </View>
              {status === "done" ? (
                <Text style={{ color: colors.success, fontSize: 14, fontWeight: "700" }}>
                  ✓
                </Text>
              ) : null}
            </View>
          );
        })}
      </View>

      {state.phase !== "submitting" && state.pollErrors > 0 ? (
        <Text
          style={{ color: colors.warning, fontSize: 13 }}
          accessibilityLiveRegion="polite"
        >
          Connection hiccup — retrying…
        </Text>
      ) : null}

      <Button label="Cancel" variant="danger" onPress={onCancel} testID="cancel-button" />
    </FadeIn>
  );
}
