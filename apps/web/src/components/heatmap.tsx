import type { ScrapeResult } from "@noviq/core";
import {
  ChevronDownIcon,
  ClockIcon,
  hatchGrape,
  hatchLime,
  Panel,
  PanelHeader,
  Pill,
  usePalette,
} from "@noviq/ui";
import { useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { heatmap } from "@/lib/analytics";

/** Cell + legend styles per intensity level (reference `cellProps`). */
function levelStyle(level: number, colors: { accent: string; surfaceSunken: string }) {
  switch (level) {
    case 1:
      return hatchGrape();
    case 2:
      return hatchLime();
    case 3:
      return { backgroundColor: "rgba(208, 242, 68, 0.45)" };
    case 4:
      return { backgroundColor: colors.accent };
    default:
      return { backgroundColor: "rgba(38, 38, 43, 0.55)" };
  }
}

/**
 * Reference `Heatmap` ("Activity by time / When reviews land"), computed from
 * the real review timestamps: 7 busiest hours × weekday grid with the
 * hatch/lime intensity scale and a Reviews/Ratings dimension toggle.
 */
export function Heatmap({ result }: { result: ScrapeResult }) {
  const colors = usePalette();
  const [dim, setDim] = useState<"reviews" | "ratings">("reviews");
  const data = heatmap(result.reviews, dim);
  if (!data) {
    return null;
  }

  return (
    <Panel testID="heatmap-panel" style={{ flex: 1 }}>
      <PanelHeader
        icon={<ClockIcon size={18} color={colors.inkMuted} />}
        title="Activity by time"
        subtitle="When reviews land"
        right={
          <Pill
            label={dim === "reviews" ? "Reviews" : "Ratings"}
            size="sm"
            tone="secondary"
            onPress={() => setDim((d) => (d === "reviews" ? "ratings" : "reviews"))}
            trailing={<ChevronDownIcon size={14} color={colors.ink} />}
          />
        }
      />

      {/* legend */}
      <View
        style={{
          marginTop: 20,
          flexDirection: "row",
          flexWrap: "wrap",
          columnGap: 16,
          rowGap: 8,
        }}
      >
        {data.legend.map((label, i) => (
          <View
            key={label}
            style={{ flexDirection: "row", alignItems: "center", gap: 6 }}
          >
            <View
              style={{
                width: 14,
                height: 14,
                borderRadius: 4,
                ...levelStyle(i + 1, colors),
              }}
            />
            <Text style={{ fontSize: 12, color: colors.inkMuted }}>{label}</Text>
          </View>
        ))}
      </View>

      {/* grid */}
      <View style={{ marginTop: 16, flexDirection: "row", gap: 8 }}>
        <View style={{ justifyContent: "space-between", paddingVertical: 2 }}>
          {data.hours.map((hour) => (
            <Text
              key={hour}
              style={{
                fontSize: 12,
                textAlign: "right",
                color: colors.inkMuted,
                fontVariant: ["tabular-nums"],
              }}
            >
              {hour}
            </Text>
          ))}
        </View>
        <View style={{ flex: 1 }}>
          <View style={{ gap: 6 }}>
            {data.levels.map((row, r) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: grid rows are positional
              <View key={r} style={{ flexDirection: "row", gap: 6 }}>
                {row.map((level, c) => (
                  <Pressable
                    // biome-ignore lint/suspicious/noArrayIndexKey: grid cells are positional
                    key={c}
                    // `img` role: aria-label is prohibited on a bare div, and
                    // these cells are informational, not interactive controls.
                    accessibilityRole="image"
                    accessibilityLabel={`${data.days[c]} ${data.hours[r]}: level ${level}`}
                    style={(state) => {
                      const { hovered = false } = state as { hovered?: boolean };
                      return {
                        flex: 1,
                        aspectRatio: 1,
                        borderRadius: 6,
                        borderCurve: "continuous",
                        transform: [{ scale: hovered ? 1.1 : 1 }],
                        ...levelStyle(level, colors),
                        ...(Platform.OS === "web"
                          ? ({
                              transitionProperty: "transform",
                              transitionDuration: "150ms",
                            } as object)
                          : null),
                      };
                    }}
                  />
                ))}
              </View>
            ))}
          </View>
          <View style={{ marginTop: 8, flexDirection: "row" }}>
            {data.days.map((day) => (
              <Text
                key={day}
                style={{
                  flex: 1,
                  textAlign: "center",
                  fontSize: 12,
                  color: colors.inkMuted,
                }}
              >
                {day}
              </Text>
            ))}
          </View>
        </View>
      </View>
    </Panel>
  );
}
