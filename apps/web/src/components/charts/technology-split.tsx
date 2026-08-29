/**
 * The technology split — and the reason it is not a chart with a band on it.
 *
 * The Overview used to take the technology selection and rebuild the whole
 * forecast from it: a P10/P50/P90 per hour *per technology*, drawn as a fan.
 * There is no such model. The forecaster has one head per subsystem, so the
 * only thing it can divide between the two fleets is the **expectation**, and
 * an expectation divides exactly because expectations add.
 *
 * So the selector's job changed rather than disappearing. It picks which of
 * two scalars this panel emphasises, and the panel exists to make that a
 * visible, honest answer instead of a silently narrower forecast:
 *
 *  - The **day expectation** is stated first, as a plain number, with the
 *    reason it is not the middle of the band underneath it. `E[Y]` sits above
 *    the median whenever there is meaningful mass on "no curtailment at all",
 *    and on a quiet subsystem the median is flatly zero while the expectation
 *    is not — which is precisely the case a screen showing only a P50 reports
 *    as "nothing happening".
 *  - The **two scalars** are drawn as shares of that expectation, on one
 *    track. A share is the only comparison the numbers support; a pair of
 *    strips with quantiles on them would be inventing a distribution.
 *
 * There is deliberately no `Band` anywhere in this file, and the props cannot
 * carry one: `TechnologySplit` is two `number`s in `@wattsteer/core` and the
 * schema rejects anything else at the boundary.
 */

import { space, usePalette } from "@wattsteer/ui";
import { Text, View } from "react-native";
import { useCopy, useFormat } from "@/i18n";
import type { Technology, TechnologySplit } from "@/lib/fixtures";
import { splitFor } from "@/lib/fixtures";

const ORDER: readonly Technology[] = ["WIND", "SOLAR"];

export function TechnologySplitPanel({
  split,
  expectedMwh,
  emphasis,
}: {
  split: TechnologySplit;
  /** `E[Y]` for the day. The two scalars sum to it. */
  expectedMwh: number;
  /** Which scalar the URL's technology selection is asking about. */
  emphasis: Technology;
}) {
  const colors = usePalette();
  const copy = useCopy();
  const f = useFormat();
  const total = Math.max(split.windMwh + split.solarMwh, 1e-9);

  return (
    <View style={{ gap: space.md }}>
      <View style={{ gap: 4 }}>
        <Text style={{ fontSize: 13, fontWeight: "500", color: colors.inkMuted }}>
          {copy.app.split.expected}
        </Text>
        <View style={{ flexDirection: "row", alignItems: "baseline", gap: 6 }}>
          <Text
            selectable={true}
            style={{
              fontSize: 40,
              lineHeight: 44,
              fontWeight: "600",
              letterSpacing: -0.8,
              fontVariant: ["tabular-nums"],
              color: colors.ink,
            }}
          >
            {f.compact(expectedMwh)}
          </Text>
          <Text style={{ fontSize: 14, fontWeight: "500", color: colors.inkMuted }}>
            MWh
          </Text>
        </View>
        <Text style={{ fontSize: 11, color: colors.inkFaint, lineHeight: 17 }}>
          {copy.app.split.expectedNote}
        </Text>
      </View>

      <View style={{ gap: space.sm }}>
        {ORDER.map((technology) => {
          const value = splitFor(split, technology);
          const emphasised = technology === emphasis;
          const tone = technology === "WIND" ? colors.accent : colors.violet;
          return (
            <View key={technology} style={{ gap: 5 }}>
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: space.sm,
                }}
              >
                <Text
                  style={{
                    fontSize: 12,
                    fontWeight: emphasised ? "700" : "500",
                    color: emphasised ? colors.ink : colors.inkMuted,
                  }}
                >
                  {emphasised
                    ? `${copy.app.technology[technology]} · ${copy.app.split.emphasised}`
                    : copy.app.technology[technology]}
                </Text>
                <Text
                  style={{
                    fontSize: 13,
                    fontWeight: emphasised ? "700" : "500",
                    fontVariant: ["tabular-nums"],
                    color: emphasised ? colors.ink : colors.inkMuted,
                  }}
                >
                  {`${f.compact(value)} MWh · ${f.percent(value / total)}`}
                </Text>
              </View>
              {/*
                A share of one expectation, on one track — not an interval.
                The unemphasised fleet is dimmed rather than hidden: a split
                whose other half you cannot see is a filter again.
              */}
              <View
                style={{
                  height: 8,
                  borderRadius: 4,
                  backgroundColor: colors.surfaceSunken,
                  overflow: "hidden",
                }}
              >
                <View
                  style={{
                    height: "100%",
                    width: `${Math.min(100, (value / total) * 100)}%`,
                    borderRadius: 4,
                    backgroundColor: tone,
                    opacity: emphasised ? 0.85 : 0.28,
                  }}
                />
              </View>
            </View>
          );
        })}
      </View>

      <Text style={{ fontSize: 11, color: colors.inkFaint, lineHeight: 17 }}>
        {copy.app.split.note}
      </Text>
    </View>
  );
}
