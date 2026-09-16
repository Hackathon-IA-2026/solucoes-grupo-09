import { BRL_PER_MWH } from "@wattsteer/core";
import {
  Badge,
  Panel,
  PanelHeader,
  radius,
  SlidersHorizontalIcon,
  space,
  usePalette,
} from "@wattsteer/ui";
import { Text, View } from "react-native";
import { useCopy, useFormat, useI18n } from "@/i18n";
import { fill } from "@/i18n/format";
import { centre, formatMwhExact, formatPercent, formatRange, upper } from "./band";
import { BandRail, useRailLabel } from "./band-figure";
import { MITIGATION, type MitigationStep, stepDetail, stepLabel } from "./fixtures";
import { Footnote } from "./section";

/**
 * The Flex Optimizer panel: no action → + battery → + flexible load, each
 * step shrinking the curtailment that remains.
 *
 * **Rebuilt, not ported.** The nearest reference shape is
 * `investidor10-web/compare-bars.tsx` (a two-series comparison), but this is
 * three cumulative states of one quantity, and each state carries a band. So
 * every step is a `BandRail` on a shared scale: the bars shorten *and* the
 * bands narrow as flexibility is added, which is the actual result and is
 * invisible in any single-figure treatment.
 *
 * Two honesty constraints from the map are enforced here rather than
 * decorated on:
 *
 * - **The headline KPIs are MWh recovered and % curtailment avoided.** R$
 *   appears once, explicitly labelled a scenario, with the assumed R$/MWh
 *   printed beside it.
 * - **The percentage is computed from medians and says so.** A ratio of two
 *   quantiles is not the quantile of the ratio, so there is no honest band to
 *   put on "% avoided" without the optimizer's joint distribution. Rather
 *   than fabricate one, the figure is labelled as a median-to-median ratio.
 */
export function MitigationStack() {
  const copy = useCopy();
  const f = useFormat();
  const { locale } = useI18n();
  const colors = usePalette();
  const baseline = MITIGATION[0];
  // `MITIGATION` is a non-empty literal in `fixtures.ts`; `.at` cannot see that.
  const final = MITIGATION.at(-1) as MitigationStep;
  const max = Math.max(...MITIGATION.map((step) => upper(step.remaining))) * 1.05;
  const avoided = 1 - centre(final.remaining) / centre(baseline.remaining);
  const recoveredMedian = final.recovered === null ? 0 : centre(final.recovered);
  const scenarioBrl = recoveredMedian * BRL_PER_MWH;

  return (
    <Panel
      testID="showcase-mitigate"
      /*
        `flexShrink: 1` beside the grow, because react-native-web defaults
        `flexShrink` to 0 (ADR-0001). A 320px basis in a narrower box then
        overflows instead of giving width back: measured at 320px, these three
        cards each wanted 320 in a 288 box and the remainder was clipped.
      */
      style={{ flexGrow: 1, flexShrink: 1, flexBasis: 320, gap: space.lg }}
    >
      <PanelHeader
        icon={<SlidersHorizontalIcon size={18} color={colors.inkMuted} />}
        title={copy.showcase.mitigate.panelTitle}
        subtitle={copy.showcase.mitigate.panelSub}
      />

      <Text style={{ fontSize: 15, fontWeight: "600", color: colors.ink }}>
        {copy.showcase.mitigate.heading}
      </Text>

      <View style={{ gap: space.lg }}>
        {MITIGATION.map((step) => (
          <StepRow key={step.key} step={step} max={max} />
        ))}
      </View>

      <View
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          gap: space.md,
          borderTopWidth: 1,
          borderTopColor: colors.border,
          paddingTop: space.lg,
        }}
      >
        <Kpi
          label={copy.showcase.mitigate.recoveredLabel}
          value={`${formatMwhExact(locale, recoveredMedian)} MWh`}
          detail={
            final.recovered !== null && final.recovered.kind === "band"
              ? `${copy.band.rangeLabel} ${formatRange(locale, final.recovered.band)}`
              : null
          }
          highlight={true}
        />
        <Kpi
          label={copy.showcase.mitigate.avoidedLabel}
          value={formatPercent(locale, avoided)}
          detail={copy.showcase.mitigate.medianToMedian}
          highlight={false}
        />
      </View>

      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: space.md,
          borderRadius: radius.lg,
          borderCurve: "continuous",
          borderWidth: 1,
          borderColor: colors.border,
          backgroundColor: colors.canvasTint,
          padding: space.md,
        }}
      >
        <Badge label={copy.showcase.mitigate.scenarioLabel} tone="neutral" />
        <Text
          style={{
            flex: 1,
            fontSize: 13,
            color: colors.inkMuted,
            fontVariant: ["tabular-nums"],
          }}
        >
          {fill(copy.showcase.mitigate.economicNote, {
            value: f.brl(scenarioBrl),
            rate: f.brl(BRL_PER_MWH),
          })}
        </Text>
      </View>

      <Footnote pinned={true}>{copy.showcase.mitigate.note}</Footnote>
    </Panel>
  );
}

function StepRow({ step, max }: { step: MitigationStep; max: number }) {
  const copy = useCopy();
  const f = useFormat();
  const { locale } = useI18n();
  const railLabel = useRailLabel();
  const colors = usePalette();
  const label = stepLabel(copy, step.key);
  const detail = stepDetail(copy, f, step.key);
  return (
    <View style={{ gap: space.sm }}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: space.md,
        }}
      >
        <Text style={{ fontSize: 13, fontWeight: "600", color: colors.ink }}>
          {label}
        </Text>
        <Text
          style={{
            fontSize: 15,
            fontWeight: "700",
            fontVariant: ["tabular-nums"],
            color: step.recovered === null ? colors.inkMuted : colors.accent,
          }}
        >
          {`${formatMwhExact(locale, centre(step.remaining))} MWh`}
        </Text>
      </View>
      <BandRail
        figure={step.remaining}
        max={max}
        label={railLabel(step.remaining, "MWh", label)}
      />
      <Text
        style={{ fontSize: 12, color: colors.inkMuted, fontVariant: ["tabular-nums"] }}
      >
        {/* biome-ignore lint/nursery/noLeakedRender: both arms are a string or null, and this is a ternary rather than a `&&` — there is no falsy value to leak */}
        {step.remaining.kind === "band"
          ? `${copy.band.rangeLabel} ${formatRange(locale, step.remaining.band)}${detail === null ? "" : ` · ${detail}`}`
          : detail}
      </Text>
    </View>
  );
}

function Kpi({
  label,
  value,
  detail,
  highlight,
}: {
  label: string;
  value: string;
  detail: string | null;
  highlight: boolean;
}) {
  const colors = usePalette();
  return (
    <View style={{ flexGrow: 1, flexShrink: 1, flexBasis: 140, gap: space.xs }}>
      <Text style={{ fontSize: 12, color: colors.inkMuted }}>{label}</Text>
      <Text
        style={{
          fontSize: 26,
          lineHeight: 30,
          fontWeight: "600",
          letterSpacing: -0.6,
          fontVariant: ["tabular-nums"],
          color: highlight ? colors.accent : colors.ink,
        }}
      >
        {value}
      </Text>
      {detail === null ? null : (
        <Text style={{ fontSize: 12, color: colors.inkFaint }}>{detail}</Text>
      )}
    </View>
  );
}
