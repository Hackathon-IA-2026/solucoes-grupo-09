/**
 * What the map's colours mean, beside the map.
 *
 * The four regions are painted by risk class and nothing on the screen said
 * which colour was which — a reader could see that the Nordeste is a different
 * red from the Norte without being able to say what either red claimed. A
 * choropleth with no key is a picture, not a reading.
 *
 * **Three classes, because there are three.** `RiskClass` is `low | elevated |
 * high` and `riskColor` maps exactly those. A legend offering a fourth step —
 * a "muito alto" above `high`, say — would name a bin the gate never derived,
 * and `derive_risk_bins` refuses to publish edges nobody measured for the same
 * reason a legend must not invent one: the class is what the reader carries
 * away, and an unmeasured class is a claim with nothing behind it.
 *
 * The order is high first. The legend sits over a map whose subject is the
 * region in trouble, and a key that makes the reader scan to the bottom for the
 * colour they are looking at is ordered for the taxonomy rather than for them.
 */

import type { RiskClass } from "@wattsteer/core/api";
import { radius, space, type, usePalette } from "@wattsteer/ui";
import { Text, View } from "react-native";
import { riskColor } from "@/components/charts/risk-color";
import { useCopy } from "@/i18n";

/** Worst first — see the header. */
const CLASSES: readonly RiskClass[] = ["high", "elevated", "low"];

export function RiskLegend() {
  const colors = usePalette();
  const copy = useCopy();
  return (
    <View
      testID="risk-legend"
      style={{
        gap: 6,
        padding: space.sm,
        borderRadius: radius.md,
        borderCurve: "continuous",
        borderWidth: 1,
        borderColor: colors.border,
        // The map shows through everywhere else; the key needs to be readable
        // over whichever region it happens to land on.
        backgroundColor: colors.surface,
      }}
    >
      <Text style={{ ...type.caption, color: colors.inkFaint }}>
        {copy.app.overview.riskLegendLabel}
      </Text>
      {CLASSES.map((klass) => (
        <View
          key={klass}
          style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}
        >
          <View
            style={{
              width: 10,
              height: 10,
              borderRadius: radius.pill,
              backgroundColor: riskColor(colors, klass).fg,
              flexShrink: 0,
            }}
          />
          <Text style={{ ...type.caption, color: colors.inkMuted }}>
            {copy.app.risk[klass]}
          </Text>
        </View>
      ))}
    </View>
  );
}
