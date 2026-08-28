import { formatDate } from "@wattsteer/core";
import {
  Badge,
  Panel,
  PanelHeader,
  RotateCcwIcon,
  space,
  usePalette,
} from "@wattsteer/ui";
import { Text, View } from "react-native";
import {
  centre,
  type Figure,
  formatMwh,
  formatPercent,
  formatRange,
  upper,
} from "./band";
import { BandRail, railLabel } from "./band-figure";
import { copy } from "./copy";
import { REPLAY } from "./fixtures";
import { Footnote } from "./section";

/**
 * The Replay panel — IDEA.md §45 and §47, the line the pitch closes on.
 *
 * **Rebuilt.** `investidor10-web/compare-bars.tsx` supplied the idea (two
 * bars on a shared scale, the comparison read as a length difference) but
 * nothing else survived, because the two bars here are *different kinds of
 * number*: the actual is an `observed` measurement with no band, and the
 * counterfactual is a model output with one. Drawing them identically would
 * assert a symmetry that does not exist. So the actual gets a single marker
 * labelled observed, the counterfactual gets a band, and the visual
 * difference carries the epistemic one.
 *
 * The `VintageFidelity` label is not a disclaimer bolted on the bottom: a
 * replay over a pre-go-live window is scored against ONS's *current*
 * restatement of that day, which ONS rewrote in place, so the number is
 * optimistic by an unknown amount. The domain model makes that product-visible
 * and this panel is where it becomes visible.
 */
export function ReplayCompare() {
  const colors = usePalette();
  const max = Math.max(upper(REPLAY.actual), upper(REPLAY.optimized)) * 1.05;

  return (
    <Panel
      testID="showcase-replay"
      style={{ flexGrow: 1, flexBasis: 320, gap: space.lg }}
    >
      <PanelHeader
        icon={<RotateCcwIcon size={18} color={colors.inkMuted} />}
        title={copy.showcase.replay.panelTitle}
        subtitle={`${REPLAY.subsystem} · ${formatDate(REPLAY.day)}`}
        right={<Badge label="revision-optimistic" tone="warning" />}
      />

      <Text style={{ fontSize: 15, fontWeight: "600", color: colors.ink }}>
        {copy.showcase.replay.heading}
      </Text>

      <View style={{ gap: space.lg }}>
        <CompareRow
          label={copy.showcase.replay.actualLabel}
          figure={REPLAY.actual}
          max={max}
        />
        <CompareRow
          label={copy.showcase.replay.optimizedLabel}
          figure={REPLAY.optimized}
          max={max}
          accent={true}
        />
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
        <View style={{ flexGrow: 1, flexBasis: 140, gap: 2 }}>
          <Text style={{ fontSize: 12, color: colors.inkMuted }}>
            {copy.showcase.replay.recoveredLabel}
          </Text>
          <Text
            style={{
              fontSize: 26,
              lineHeight: 30,
              fontWeight: "600",
              letterSpacing: -0.6,
              fontVariant: ["tabular-nums"],
              color: colors.accent,
            }}
          >
            {`${formatMwh(centre(REPLAY.recovered))} MWh`}
          </Text>
          {REPLAY.recovered.kind === "band" ? (
            <Text style={{ fontSize: 12, color: colors.inkFaint }}>
              {`${copy.band.rangeLabel} ${formatRange(REPLAY.recovered.band)}`}
            </Text>
          ) : null}
        </View>
        <View style={{ flexGrow: 1, flexBasis: 140, gap: 2 }}>
          <Text style={{ fontSize: 12, color: colors.inkMuted }}>
            {copy.showcase.replay.reductionLabel}
          </Text>
          <Text
            style={{
              fontSize: 26,
              lineHeight: 30,
              fontWeight: "600",
              letterSpacing: -0.6,
              fontVariant: ["tabular-nums"],
              color: colors.ink,
            }}
          >
            {formatPercent(REPLAY.reduction)}
          </Text>
          <Text style={{ fontSize: 12, color: colors.inkFaint }}>median to observed</Text>
        </View>
      </View>

      <Footnote>{copy.showcase.replay.vintageNote}</Footnote>
    </Panel>
  );
}

function CompareRow({
  label,
  figure,
  max,
  accent = false,
}: {
  label: string;
  figure: Figure;
  max: number;
  accent?: boolean;
}) {
  const colors = usePalette();
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
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text style={{ fontSize: 13, fontWeight: "600", color: colors.ink }}>
            {label}
          </Text>
          {figure.kind === "observed" ? (
            <Badge label={copy.band.observedLabel} tone="neutral" />
          ) : null}
        </View>
        <Text
          style={{
            fontSize: 20,
            fontWeight: "700",
            fontVariant: ["tabular-nums"],
            color: accent ? colors.accent : colors.ink,
          }}
        >
          {`${formatMwh(centre(figure))} MWh`}
        </Text>
      </View>
      <BandRail figure={figure} max={max} label={railLabel(figure, "MWh", label)} />
      <Text
        style={{ fontSize: 12, color: colors.inkMuted, fontVariant: ["tabular-nums"] }}
      >
        {figure.kind === "band"
          ? `${copy.band.rangeLabel} ${formatRange(figure.band)}`
          : copy.band.observedNote}
      </Text>
    </View>
  );
}
