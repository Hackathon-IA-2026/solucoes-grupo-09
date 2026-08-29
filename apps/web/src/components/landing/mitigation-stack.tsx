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
import { SCENARIO_BRL_PER_MWH } from "@/lib/economics";
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
  const final = MITIGATION[MITIGATION.length - 1];
  const max = Math.max(...MITIGATION.map((step) => upper(step.remaining))) * 1.05;
  const avoided = 1 - centre(final.remaining) / centre(baseline.remaining);
  const recoveredMedian = final.recovered === null ? 0 : centre(final.recovered);
  const scenarioBrl = recoveredMedian * SCENARIO_BRL_PER_MWH;

  return (
    <Panel
      testID="showcase-mitigate"
      style={{ flexGrow: 1, flexBasis: 320, gap: space.lg }}
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
          padding: 12,
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
            rate: f.brl(SCENARIO_BRL_PER_MWH),
          })}
        </Text>
      </View>

      <Footnote>{copy.showcase.mitigate.note}</Footnote>
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
    <View style={{ gap: 8 }}>
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
    <View style={{ flexGrow: 1, flexBasis: 140, gap: 2 }}>
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
