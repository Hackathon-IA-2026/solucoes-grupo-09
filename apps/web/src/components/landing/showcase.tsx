import { Badge, Panel, radius, space, usePalette } from "@wattsteer/ui";
import { StyleSheet, Text, View } from "react-native";
import { useCopy, useI18n } from "@/i18n";
import { fill } from "@/i18n/format";
import { band, centre, formatMwhExact, formatRange } from "./band";
import { BandRail, useRailLabel } from "./band-figure";
import { DriverBars } from "./driver-bars";
import { MitigationStack } from "./mitigation-stack";
import { ReplayCompare } from "./replay-compare";
import { SectionHeading } from "./section";

/**
 * "The product, shown" — rebuilt from the template's `showcase.tsx`, staged
 * in `reference/` (that directory's README grades what was worth taking).
 *
 * The old section's premise was "every scrape ends in this": a dashboard of
 * one thing the visitor had just asked for. WattSteer's product is a
 * sequence — forecast, diagnose, optimise, prove — and the hero already
 * carries the forecast, so this section shows the three stages that come
 * after it, one panel each, in the order the pitch tells them.
 *
 * What survives from the reference is the frame, and it is worth keeping:
 * a labelled sample badge, a centred heading with one accent clause, real
 * product components over deterministic fixture data rather than
 * screenshots, and the charts left interactive. What is gone is the
 * `StatCards` row that used to open it — four single-figure tiles, which is
 * precisely the shape a banded KPI cannot occupy.
 */

const styles = StyleSheet.create({
  badge: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    borderRadius: radius.pill,
    borderWidth: 1,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  // Geometry, not spacing: a 6 px dot is the smallest mark that still reads as
  // round at 1x, and its radius is half its width by definition.
  dot: { width: 6, height: 6, borderRadius: 3 },
});

export function Showcase({ wide }: { wide: boolean }) {
  const copy = useCopy();
  const colors = usePalette();
  return (
    <>
      <View style={{ alignItems: "center", gap: space.lg }}>
        <View
          style={[
            styles.badge,
            { borderColor: colors.border, backgroundColor: colors.surface },
          ]}
        >
          <View style={[styles.dot, { backgroundColor: colors.violet }]} />
          <Text style={{ fontSize: 12, fontWeight: "500", color: colors.inkMuted }}>
            {copy.showcase.badge}
          </Text>
        </View>
      </View>

      <SectionHeading
        title={copy.showcase.title.lead}
        accent={copy.showcase.title.accent}
        sub={copy.showcase.sub}
        wide={wide}
      />

      <BandExplainer wide={wide} />

      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.lg }}>
        <DriverBars />
        <MitigationStack />
        <ReplayCompare />
      </View>
    </>
  );
}

/** Two forecasts, same median, different confidence — drawn side by side. */
const CONFIDENT = band(3900, 4180, 4500);
const UNCERTAIN = band(1400, 4180, 8600);

/**
 * The design decision, made arguable on the page itself. Both examples share
 * a median; only a UI that draws the interval can tell them apart, which is
 * the whole argument for the rail in one picture.
 */
function BandExplainer({ wide }: { wide: boolean }) {
  const copy = useCopy();
  const { locale } = useI18n();
  const colors = usePalette();
  const max = 9000;
  return (
    <Panel testID="band-explainer" style={{ gap: space.lg }}>
      <View style={{ flexDirection: wide ? "row" : "column", gap: space.xl }}>
        <View style={{ flex: wide ? 1 : undefined, gap: space.md }}>
          <Badge label={copy.band.rangeLabel} tone="violet" />
          <Text style={{ fontSize: 20, fontWeight: "600", color: colors.ink }}>
            {copy.band.explainerTitle}
          </Text>
          <Text style={{ fontSize: 14, lineHeight: 22, color: colors.inkMuted }}>
            {copy.band.explainerBody}
          </Text>
        </View>
        <View
          style={{ flex: wide ? 1 : undefined, gap: space.lg, justifyContent: "center" }}
        >
          <ExampleRail
            label={copy.band.explainerConfident}
            figure={CONFIDENT}
            max={max}
          />
          <ExampleRail
            label={copy.band.explainerUncertain}
            figure={UNCERTAIN}
            max={max}
          />
          {/* This sentence *is* the panel's argument, so it is set at 13 px in
              `inkMuted` (6.79:1 on `surface`) rather than the 12 px `inkFaint`
              it was (4.82:1) — the faintest type on the page was carrying the
              point the page is making. */}
          <Text style={{ fontSize: 13, lineHeight: 19, color: colors.inkMuted }}>
            {fill(copy.band.explainerSame, {
              value: formatMwhExact(locale, centre(CONFIDENT)),
            })}
          </Text>
        </View>
      </View>
    </Panel>
  );
}

function ExampleRail({
  label,
  figure,
  max,
}: {
  label: string;
  figure: ReturnType<typeof band>;
  max: number;
}) {
  const { locale } = useI18n();
  const railLabel = useRailLabel();
  const colors = usePalette();
  return (
    <View style={{ gap: space.sm }}>
      <View
        style={{ flexDirection: "row", justifyContent: "space-between", gap: space.md }}
      >
        <Text style={{ fontSize: 13, color: colors.inkMuted }}>{label}</Text>
        <Text
          style={{
            fontSize: 13,
            fontWeight: "600",
            fontVariant: ["tabular-nums"],
            color: colors.onVioletSoft,
          }}
        >
          {figure.kind === "band" ? formatRange(locale, figure.band) : ""}
        </Text>
      </View>
      <BandRail figure={figure} max={max} label={railLabel(figure, "MWh", label)} />
    </View>
  );
}
