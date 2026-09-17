/**
 * Did the forecast hold?
 *
 * ## The one question the Time Machine did not answer
 *
 * This screen was built to answer "how much could have been recovered" — the
 * floor, the avoidability, the plan against the executed. All of that is about
 * the *optimizer*. None of it is about whether the *forecast* was right, and a
 * reader deciding whether to trust tomorrow's number is asking about
 * yesterday's. The figures this panel needs were already on the page and were
 * never subtracted.
 *
 * ## Why there is no accuracy percentage
 *
 * The brief asks for "Acurácia: 49%", and one day cannot produce one. The
 * accuracy of a *distribution* is a property of many days: the fraction whose
 * settled total landed inside the band, which is `coverage_p10_in_band` and
 * which the gate already measures over a fold. A single day either landed
 * inside its band or it did not, and dividing two megawatt-hours to make a
 * percentage of it would be inventing a statistic with a familiar shape —
 * which is the thing this product refuses everywhere else.
 *
 * So the day says what the day knows: the error in MWh, its direction, and
 * which side of the band the settlement fell on. The aggregate lives with the
 * aggregate.
 *
 * ## Why a miss is not a failure
 *
 * A P10–P90 band is *supposed* to be missed about one day in five. A panel
 * that called every miss an error would teach a reader to want a band that is
 * never exceeded, which is a band too wide to act on. The copy says where the
 * day fell. It does not grade it.
 */

import type { Band } from "@wattsteer/core/api";
import {
  ArrowUpDownIcon,
  Panel,
  PanelHeader,
  space,
  type,
  usePalette,
} from "@wattsteer/ui";
import { Text, View } from "react-native";
import { BandStrip } from "@/components/charts/band-figure";
import { useCopy, useFormat } from "@/i18n";
import { fill } from "@/i18n/format";
import { forecastError, placementOf } from "@/lib/replay-accuracy";

export function AccuracyPanel({
  band,
  settled,
}: {
  /** What the forecast said in D−1, as the joint day band it was published as. */
  band: Band;
  /** What ONS settled, for the whole local day. */
  settled: number;
}) {
  const colors = usePalette();
  const copy = useCopy();
  const f = useFormat();
  const placement = placementOf(band, settled);
  const error = forecastError(band, settled);

  return (
    <Panel style={{ gap: space.lg }}>
      <PanelHeader
        icon={<ArrowUpDownIcon size={18} color={colors.inkMuted} />}
        title={copy.app.replay.accuracyTitle}
        subtitle={copy.app.replay.accuracySubtitle}
      />

      <View style={{ gap: space.md }}>
        {/*
          The band first and the settlement against it, because the question is
          where the day fell rather than what two numbers were. `BandStrip` is
          the component the forecast itself draws, so a reader is comparing the
          same object they were shown the day before.
        */}
        <BandStrip band={band} domainMax={Math.max(band.p90, settled) * 1.08} />
        <View
          style={{
            flexDirection: "row",
            flexWrap: "wrap",
            gap: space.lg,
            alignItems: "flex-end",
          }}
        >
          <Figure label={copy.app.replay.accuracyForecast} value={f.compact(band.p50)} />
          <Figure label={copy.app.replay.accuracySettled} value={f.compact(settled)} />
          <Figure
            label={copy.app.replay.accuracyError}
            // Signed, and the sign is a character rather than a colour: a
            // reader who cannot tell red from green still has to be able to
            // tell "more than forecast" from "less".
            value={`${error >= 0 ? "+" : "−"}${f.compact(Math.abs(error))}`}
          />
        </View>
      </View>

      <Text style={{ ...type.caption, lineHeight: 19, color: colors.inkMuted }}>
        {fill(copy.app.replay.accuracyPlacement[placement], {
          p10: f.compact(band.p10),
          p90: f.compact(band.p90),
        })}
      </Text>
      <Text style={{ ...type.caption, lineHeight: 19, color: colors.inkFaint }}>
        {copy.app.replay.accuracyNote}
      </Text>
    </Panel>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  const colors = usePalette();
  return (
    <View style={{ gap: 2 }}>
      <Text style={{ ...type.caption, color: colors.inkFaint }}>{label}</Text>
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: 5 }}>
        <Text
          style={{
            fontSize: 24,
            lineHeight: 28,
            fontWeight: "600",
            color: colors.ink,
            fontVariant: ["tabular-nums"],
          }}
        >
          {value}
        </Text>
        <Text style={{ ...type.caption, color: colors.inkFaint }}>MWh</Text>
      </View>
    </View>
  );
}
