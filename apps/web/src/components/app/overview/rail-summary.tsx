/**
 * The four rows added up, under the four rows.
 *
 * **Why it says `previsto` in its label.** The screen carries a second national
 * figure — the settled last 24 hours, in the column on the left — and on a
 * normal day the two land within a percent of each other: 193,4k forecast
 * against 193,8k settled. Two large numbers that close, with nothing on either
 * naming its kind, is read as one number measured twice, or worse as a 0,4k
 * error. It is neither: they are different days and different vocabularies.
 * The mock this follows put them at the same weight with no such word, and
 * added an `Erro (Δ)` between them, which is the arithmetic `honesty.md` exists
 * to prevent.
 *
 * **Why the probability names a subsystem.** `riskRow` is the worst of the
 * four, and its `occurrenceProbability` is that region's — P(at least one hour
 * above τ) *there*. The mock labelled the same 97% "em pelo menos um
 * subsistema", which is a joint probability over four regions: a larger
 * quantity, computed nowhere, and not derivable from four marginals without
 * their dependence. So the figure keeps the sentence the question card already
 * uses for it, which names the region it belongs to.
 *
 * **No band.** `magnitudeBand` is the persisted joint row where one exists and
 * `null` where none was published; a sum of four P50s carrying a band assembled
 * from four P10s would be the quantile addition `honesty.md` forbids outright.
 * The strip is drawn only from the joint row, and its absence is stated by the
 * caller rather than filled in here.
 */

import type { Band } from "@wattsteer/core/api";
import { space, type, usePalette } from "@wattsteer/ui";
import { Text, View } from "react-native";
import { BandStrip } from "@/components/charts/band-figure";
import { RiskChip } from "@/components/charts/risk-class";
import { useCopy, useFormat } from "@/i18n";
import { fill } from "@/i18n/format";
import { roundProbability, subsystemMeta } from "@/lib/fixtures";
import type { OutlookRow } from "@/lib/network";

export function RailSummary({
  totalMwh,
  band,
  riskRow,
}: {
  /** The sum of the four rows above. */
  totalMwh: number;
  /** The persisted joint band, or `null` where no national row was published. */
  band: Band | null;
  /** The worst of the four, whose probability this states. `null` if none. */
  riskRow: OutlookRow | null;
}) {
  const colors = usePalette();
  const copy = useCopy();
  const f = useFormat();
  return (
    <View style={{ gap: space.sm, paddingTop: space.xs }}>
      <View
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          alignItems: "flex-end",
          gap: space.md,
        }}
      >
        <View style={{ flexGrow: 1, flexShrink: 1, minWidth: 0, gap: 4 }}>
          <Text style={{ ...type.caption, color: colors.inkFaint }}>
            {copy.app.overview.railSumLabel}
          </Text>
          <View style={{ flexDirection: "row", alignItems: "baseline", gap: 5 }}>
            <Text
              style={{
                fontSize: 26,
                lineHeight: 30,
                fontWeight: "700",
                color: colors.ink,
                fontVariant: ["tabular-nums"],
              }}
            >
              {f.compact(totalMwh)}
            </Text>
            <Text style={{ ...type.caption, color: colors.inkFaint }}>MWh</Text>
          </View>
        </View>

        {riskRow === null ? null : (
          <View style={{ alignItems: "flex-end", gap: 4, flexShrink: 0 }}>
            <RiskChip probability={riskRow.occurrenceProbability} />
            <Text
              style={{
                ...type.caption,
                color: colors.inkFaint,
                fontVariant: ["tabular-nums"],
              }}
            >
              {fill(copy.app.grid.q1Detail, {
                probability: f.percentPoints(
                  roundProbability(riskRow.occurrenceProbability),
                ),
                subsystem: subsystemMeta(riskRow.subsystem).onsDisplayName,
              })}
            </Text>
          </View>
        )}
      </View>

      {band === null ? null : <BandStrip band={band} />}

      {/*
        The grain note, which is the claim this whole card rests on: expectations
        add exactly, and ONS's own SIN line is not what is being shown. It is the
        sentence the headline panel carries for the same figure.
      */}
      <Text style={{ ...type.caption, color: colors.inkFaint }}>
        {copy.readout.nationalGrainNote}
      </Text>
    </View>
  );
}
