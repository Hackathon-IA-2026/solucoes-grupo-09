/**
 * One headline figure of the replayed day, with the lines that qualify it.
 *
 * The dashboard's top row is five of these. Each names what it is in its own
 * words — a forecast, a settled figure, a deviation, a track record, a fleet
 * result — and carries its unit beside the number rather than folded into it,
 * so a card never shows a bare number a reader has to guess the kind of.
 *
 * An absent figure is a sentence in the value's place, never a zero or a dash:
 * `value: null` renders `absent` in the figure's own position, in the muted
 * ink the rest of the product uses for a stated absence.
 */

import { Panel, radius, space, usePalette } from "@wattsteer/ui";
import type { ReactNode } from "react";
import { Text, View } from "react-native";
import { InfoHint } from "@/components/app/time-machine/info-hint";

export type KpiTone = "forecast" | "settled" | "neutral" | "record" | "fleet";

export function KpiCard({
  icon,
  title,
  kicker,
  value,
  unit,
  absent,
  tone,
  lines = [],
  hint = [],
  testID,
}: {
  icon: ReactNode;
  title: string;
  kicker: string;
  /** The figure, formatted — or `null` for a stated absence. */
  value: string | null;
  unit?: string;
  /** What is said in the figure's place when `value` is `null`. */
  absent?: string;
  tone: KpiTone;
  lines?: readonly string[];
  /** The figure's explanation, behind the ⓘ rather than under the number. */
  hint?: readonly string[];
  testID?: string;
}) {
  const colors = usePalette();
  const accent = {
    forecast: colors.violet,
    settled: colors.ink,
    neutral: colors.inkMuted,
    record: colors.info,
    fleet: colors.accentStrong,
  }[tone];
  const wash = {
    forecast: colors.violetSoft,
    settled: colors.surfaceSunken,
    neutral: colors.surfaceSunken,
    record: colors.infoSoft,
    fleet: colors.accentSoft,
  }[tone];

  return (
    <Panel
      testID={testID}
      style={{
        // ADR-0001: a basis without a shrink is a floor, and five of these in
        // one wrapping row must give way at 320px.
        flexGrow: 1,
        flexShrink: 1,
        flexBasis: 210,
        minWidth: 0,
        gap: space.sm,
        borderTopWidth: 3,
        borderTopColor: accent,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          alignItems: "center",
          gap: space.sm,
        }}
      >
        <View
          style={{
            width: 30,
            height: 30,
            borderRadius: radius.pill,
            backgroundColor: wash,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {icon}
        </View>
        <Text
          style={{ fontSize: 15, fontWeight: "700", color: colors.ink, flexShrink: 1 }}
        >
          {title}
        </Text>
        <View style={{ flexGrow: 1 }} />
        <InfoHint label={title} points={hint} />
      </View>
      <Text style={{ fontSize: 12, lineHeight: 17, color: colors.inkMuted }}>
        {kicker}
      </Text>
      {value === null ? (
        <Text style={{ fontSize: 14, lineHeight: 20, color: colors.inkFaint }}>
          {absent}
        </Text>
      ) : (
        <View
          style={{
            flexDirection: "row",
            alignItems: "baseline",
            gap: 6,
            flexWrap: "wrap",
          }}
        >
          <Text
            selectable={true}
            style={{
              fontSize: 34,
              lineHeight: 40,
              fontWeight: "700",
              letterSpacing: -0.8,
              fontVariant: ["tabular-nums"],
              color: tone === "neutral" ? colors.ink : accent,
            }}
          >
            {value}
          </Text>
          {unit === undefined ? null : (
            <Text style={{ fontSize: 15, fontWeight: "600", color: colors.inkMuted }}>
              {unit}
            </Text>
          )}
        </View>
      )}
      {lines.map((line) => (
        <Text
          key={line}
          style={{ fontSize: 12, lineHeight: 18, color: colors.inkMuted, flexShrink: 1 }}
        >
          {line}
        </Text>
      ))}
    </Panel>
  );
}
