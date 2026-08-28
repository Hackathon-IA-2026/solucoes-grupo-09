import { Panel, PanelHeader, PieChartIcon, space, usePalette } from "@wattsteer/ui";
import { Text, View } from "react-native";
import { copy } from "./copy";
import { DRIVERS } from "./fixtures";
import { Footnote } from "./section";

/**
 * Driver attribution — the Diagnosis screen's panel.
 *
 * **Ported form, replaced content.** `RatingDistribution`, in the template's
 * `breakdown.tsx` (staged in `reference/`), is a ranked list of horizontal
 * bars sharing one scale,
 * with a right-aligned tabular percentage; that is structurally what a SHAP
 * ranking is, so the geometry, the shared `max` (bars normalised to the
 * largest, not to 100%, so small contributions stay legible) and the tabular
 * alignment all carry over unchanged. What was dropped is the store-wide
 * comparison tick: there is no second distribution to compare a SHAP ranking
 * against, and leaving the marker in would have invented one.
 *
 * The contributions are point estimates and are *not* banded. A SHAP value is
 * an attribution of one model output, not a forecast quantity — giving it a
 * P10–P90 would be inventing uncertainty rather than reporting it.
 */
export function DriverBars() {
  const colors = usePalette();
  const max = Math.max(...DRIVERS.map((d) => d.contribution));

  return (
    <Panel
      testID="showcase-explain"
      style={{ flexGrow: 1, flexBasis: 320, gap: space.lg }}
    >
      <PanelHeader
        icon={<PieChartIcon size={18} color={colors.inkMuted} />}
        title={copy.showcase.explain.panelTitle}
        subtitle={copy.showcase.explain.panelSub}
      />

      <Text style={{ fontSize: 15, fontWeight: "600", color: colors.ink }}>
        {copy.showcase.explain.heading}
      </Text>

      <View style={{ gap: space.md }}>
        {DRIVERS.map((driver, index) => (
          <View
            key={driver.label}
            style={{ flexDirection: "row", alignItems: "center", gap: space.md }}
          >
            <Text
              numberOfLines={1}
              style={{ flex: 1, fontSize: 13, color: colors.inkMuted }}
            >
              {driver.label}
            </Text>
            <View
              style={{
                width: 96,
                height: 10,
                borderRadius: 5,
                backgroundColor: colors.surfaceSunken,
                overflow: "hidden",
              }}
            >
              <View
                style={{
                  width: `${(driver.contribution / max) * 100}%`,
                  height: "100%",
                  borderRadius: 5,
                  backgroundColor: index === 0 ? colors.accent : colors.violet,
                }}
              />
            </View>
            <Text
              style={{
                width: 42,
                textAlign: "right",
                fontSize: 13,
                fontWeight: "600",
                fontVariant: ["tabular-nums"],
                color: colors.ink,
              }}
            >
              {`${Math.round(driver.contribution * 100)}%`}
            </Text>
          </View>
        ))}
      </View>

      <Footnote>{copy.showcase.explain.note}</Footnote>
    </Panel>
  );
}
