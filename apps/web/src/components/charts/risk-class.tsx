/**
 * Risk, coloured without implying precision the model does not have.
 *
 * `@wattsteer/ui` already ships `RiskBar`: a continuous green→yellow→red
 * gradient with a marker positioned by the score. It is a good component and
 * it is the wrong one here, for three reasons that are worth writing down
 * because the instinct to reach for it is strong.
 *
 *  1. **A continuous gradient promises continuous resolution.** A marker that
 *     can sit anywhere on a smooth ramp says the model can tell 31% from 33%.
 *     It cannot — see the reliability curve on the Explain screen, which shows
 *     the classifier over-confident in the top bins. Colour that varies
 *     smoothly is a claim about the model, not a styling choice.
 *  2. **Traffic-light hues carry an action.** Green/amber/red reads as
 *     go/caution/stop. What is actually being shown is P(this subsystem sees
 *     an hour above the 5 MW threshold tomorrow), which nobody should act on
 *     without opening the magnitude band underneath it.
 *  3. **Hue alone fails colour-vision-deficient readers**, and a grid product
 *     read at 6 a.m. is exactly where that matters.
 *
 * What ships instead:
 *
 *  - **Three named, wide, ordered bins** — Low (<25%), Elevated (25–60%), High
 *    (≥60%) — defined in `lib/fixtures/grid.ts` because the bin edges are a
 *    model-facing decision that a calibration curve is checked against, not a
 *    styling one.
 *  - **Redundant encoding**: the class name in words, a three-step glyph
 *    filled to the level, *and* colour. Any two of the three can be lost.
 *  - **No gradient.** The scale is drawn as three discrete segments with the
 *    boundaries visible, so the reader can see the bin the number fell into
 *    and how close it was to the next one.
 *  - **The probability is rounded to the nearest 5 points and prefixed `≈`.**
 *
 * Colour is `inkMuted` / `warning` / `danger` — three steps, no ramp. Lime is
 * deliberately not used: it is the product's positive accent, and a *low*
 * curtailment risk is not an achievement, it is just a quiet day.
 *
 * Candidate for promotion into `@wattsteer/ui` alongside (or in place of)
 * `RiskBar` once a human has signed off the bin edges.
 */

import { radius, space, usePalette } from "@wattsteer/ui";
import { Text, View } from "react-native";
import { riskColor } from "@/components/charts/risk-color";
import { useCopy, useFormat } from "@/i18n";
import type { RiskClass } from "@/lib/fixtures";
import { RISK_BINS, riskClass, roundProbability } from "@/lib/fixtures";

/*
  Re-exported rather than relocated silently: the subsystem map imports
  `riskColor` from this module and `test/observed-overview.test.ts` names it
  here. The definition moved to `risk-color.ts` so this file exports only
  components — a component file with a plain export cannot be hot-replaced —
  and the argument for why the three-step palette exists at all stays in the
  header above, where a reader reaching for `@wattsteer/ui`'s gradient will
  meet it.
*/
export { riskColor } from "@/components/charts/risk-color";

const LEVEL: Record<RiskClass, number> = { low: 1, elevated: 2, high: 3 };

function useRiskColor(klass: RiskClass): { fg: string; bg: string } {
  return riskColor(usePalette(), klass);
}

/** Three ascending bars, filled to the class level. Never colour alone. */
export function RiskSteps({ klass, size = 12 }: { klass: RiskClass; size?: number }) {
  const { fg } = useRiskColor(klass);
  const colors = usePalette();
  const level = LEVEL[klass];
  return (
    <View
      aria-hidden={true}
      style={{ flexDirection: "row", alignItems: "flex-end", gap: 2, height: size }}
    >
      {[1, 2, 3].map((step) => (
        <View
          key={step}
          style={{
            width: 3,
            height: (size / 3) * step,
            borderRadius: 1,
            backgroundColor: step <= level ? fg : colors.borderStrong,
          }}
        />
      ))}
    </View>
  );
}

export function RiskChip({ probability }: { probability: number }) {
  const copy = useCopy();
  const f = useFormat();
  const klass = riskClass(probability);
  const { fg, bg } = useRiskColor(klass);
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        alignSelf: "flex-start",
        gap: 8,
        borderRadius: radius.pill,
        backgroundColor: bg,
        paddingHorizontal: 12,
        paddingVertical: 6,
      }}
    >
      <RiskSteps klass={klass} />
      <Text style={{ fontSize: 13, fontWeight: "700", color: fg }}>
        {copy.app.risk[klass]}
      </Text>
      {/*
        **No `opacity` on this number, and the reason is measured.** It carried
        `opacity: 0.8` to sit a step behind the class word beside it. Computed
        against the real tokens, over the real card, that took the `low` chip to
        **4.35:1** — under WCAG AA's 4.5 floor for body text, which axe reports
        as a serious `color-contrast` violation. The other two chips survived
        it (elevated 5.95, high 4.94), which is exactly how this kind of defect
        stays hidden: it is one of three states, on the calmest one.

        At full opacity the three are 5.95, 8.40 and 6.90. The hierarchy it was
        buying is still here and costs nothing — `500` against the label's
        `700`, on the same hue. Weight was always doing that work; the opacity
        was doing it twice and paying for it in contrast.
      */}
      <Text style={{ fontSize: 13, fontWeight: "500", color: fg }}>
        {`≈${f.percentPoints(roundProbability(probability))}`}
      </Text>
    </View>
  );
}

/**
 * The scale itself: three segments, boundaries visible, the active bin lit and
 * a marker inside it. No ramp — the marker's position within a segment is
 * informative about *how close to the edge*, and nothing finer is claimed.
 */
export function RiskScale({ probability }: { probability: number }) {
  const colors = usePalette();
  const copy = useCopy();
  const f = useFormat();
  const klass = riskClass(probability);
  const active = useRiskColor(klass);
  return (
    <View style={{ gap: 6 }}>
      <View style={{ flexDirection: "row", gap: 3, height: 10 }}>
        {RISK_BINS.map((bin) => {
          const isActive = bin.klass === klass;
          const width = (bin.to - bin.from) * 100;
          const within = isActive
            ? Math.max(0, Math.min(1, (probability - bin.from) / (bin.to - bin.from)))
            : 0;
          return (
            <View
              key={bin.klass}
              style={{
                flexGrow: width,
                flexBasis: 0,
                borderRadius: 5,
                backgroundColor: isActive ? active.bg : colors.surfaceSunken,
                justifyContent: "center",
              }}
            >
              {isActive ? (
                <View
                  style={{
                    position: "absolute",
                    left: `${within * 100}%`,
                    top: -2,
                    bottom: -2,
                    width: 3,
                    marginLeft: -1.5,
                    borderRadius: 2,
                    backgroundColor: active.fg,
                  }}
                />
              ) : null}
            </View>
          );
        })}
      </View>
      <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
        {RISK_BINS.map((bin) => (
          <Text
            key={bin.klass}
            style={{
              fontSize: 10,
              color: bin.klass === klass ? colors.ink : colors.inkFaint,
              fontWeight: bin.klass === klass ? "700" : "400",
            }}
          >
            {`${copy.app.risk[bin.klass]} ${f.number(bin.from * 100)}–${f.percentPoints(
              bin.to * 100,
            )}`}
          </Text>
        ))}
      </View>
    </View>
  );
}

/** The one-line caveat that has to travel with any risk number. */
export function RiskCaveat() {
  const colors = usePalette();
  const copy = useCopy();
  return (
    <Text style={{ fontSize: 11, color: colors.inkFaint, marginTop: space.sm }}>
      {copy.app.risk.caveat}
    </Text>
  );
}
