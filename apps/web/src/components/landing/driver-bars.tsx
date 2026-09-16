import { Panel, PanelHeader, PieChartIcon, space, usePalette } from "@wattsteer/ui";
import { Text, View } from "react-native";
import { driverBarColor } from "@/components/charts/driver-bars";
import { useCopy } from "@/i18n";
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
  const copy = useCopy();
  const colors = usePalette();
  const max = Math.max(...DRIVERS.map((d) => d.share));

  return (
    <Panel
      testID="showcase-explain"
      /*
        `flexShrink: 1` beside the grow, because react-native-web defaults
        `flexShrink` to 0 (ADR-0001). A 320px basis in a narrower box then
        overflows instead of giving width back: measured at 320px, these three
        cards each wanted 320 in a 288 box and the remainder was clipped.
      */
      style={{ flexGrow: 1, flexShrink: 1, flexBasis: 320, gap: space.lg }}
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
        {DRIVERS.map((driver) => (
          <View
            key={driver.code}
            style={{ flexDirection: "row", alignItems: "center", gap: space.md }}
          >
            {/*
              The product's own words for the product's own groups. This panel
              used to read a second driver dictionary that named features the
              engine never attributes to; there is one dictionary now, shared
              with the Explain screen, so a renamed group cannot leave the
              landing page describing the old one.
            */}
            <Text
              numberOfLines={1}
              style={{ flex: 1, fontSize: 13, color: colors.inkMuted }}
            >
              {driver.code === "other"
                ? copy.app.drivers.merged
                : copy.app.drivers.groups[driver.code]}
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
                  width: `${(driver.share / max) * 100}%`,
                  height: "100%",
                  borderRadius: 5,
                  /*
                    The Explain screen's own rule, imported rather than
                    restated. This was `index === 0 ? accent : violet` — colour
                    by position, which on a panel where every driver raises the
                    risk painted the top bar in the hue the product uses for
                    "lowers". The landing shows the product's components; it has
                    to show the product's encodings too.
                  */
                  backgroundColor: driverBarColor(driver.direction, colors),
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
              {`${Math.round(driver.share * 100)}%`}
            </Text>
          </View>
        ))}
      </View>

      <Footnote pinned={true}>{copy.showcase.explain.note}</Footnote>
    </Panel>
  );
}
