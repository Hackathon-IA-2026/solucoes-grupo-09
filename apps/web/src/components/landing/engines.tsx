import {
  IconCircle,
  LayersIcon,
  Panel,
  PieChartIcon,
  RotateCcwIcon,
  SlidersHorizontalIcon,
  space,
  usePalette,
} from "@wattsteer/ui";
import type { ComponentType } from "react";
import { Text, View } from "react-native";
import { copy } from "./copy";
import { SectionHeading } from "./section";

/**
 * "Four engines, not one model" — IDEA.md §19's structure, which is the part
 * of the pitch that distinguishes this from a forecasting demo. Deliberately
 * four equal cards rather than a pipeline diagram: the reading order matters
 * (forecast → diagnose → optimise → prove) but arrows would imply a request
 * path that does not exist, since Replay re-runs the whole chain rather than
 * consuming the previous stage's output.
 */

type IconComponent = ComponentType<{ size?: number; color: string }>;

/** Parallel to `copy.engines.items`; index-matched, in the same order. */
const ENGINE_ICONS: readonly IconComponent[] = [
  LayersIcon,
  PieChartIcon,
  SlidersHorizontalIcon,
  RotateCcwIcon,
];

export function Engines({ wide }: { wide: boolean }) {
  const colors = usePalette();
  const basis: `${number}%` = wide ? "47%" : "100%";

  return (
    <>
      <SectionHeading title={copy.engines.title} sub={copy.engines.sub} wide={wide} />
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.lg }}>
        {copy.engines.items.map((engine, index) => {
          const Icon = ENGINE_ICONS[index];
          const tint = index % 2 === 0 ? colors.accent : colors.violet;
          return (
            <Panel
              key={engine.name}
              delay={index * 60}
              style={{ flexGrow: 1, flexBasis: basis, gap: space.md }}
            >
              <View style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>
                <IconCircle>
                  <Icon size={18} color={tint} />
                </IconCircle>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 17, fontWeight: "600", color: colors.ink }}>
                    {engine.name}
                  </Text>
                  <Text style={{ fontSize: 13, color: colors.inkMuted }}>
                    {engine.question}
                  </Text>
                </View>
              </View>
              <Text style={{ fontSize: 14, lineHeight: 22, color: colors.inkMuted }}>
                {engine.body}
              </Text>
            </Panel>
          );
        })}
      </View>
    </>
  );
}
