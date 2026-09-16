/**
 * The day summed over the four subsystems — one panel per half of the screen.
 *
 * Both are in this file and not beside their own stacks, because the pair *is*
 * the statement. They are the same question — "what is the number for the whole
 * country?" — answered under the two vocabularies this product keeps apart, and
 * reading them next to each other is the fastest way to see that the forecast
 * one may not add its quantiles while the settled one may add its measurements.
 * Split across two files, that argument is something a reader has to assemble.
 *
 * Neither panel computes anything. Both gateway reads publish their national
 * figure already — `apps/api/src/api/grid.ts` explains why each is allowed to
 * exist — so these components receive a number and print it.
 */

import type { GridNow, NationalOutlook } from "@wattsteer/core/api";
import {
  CalendarDaysIcon,
  gradientBg,
  Panel,
  PanelHeader,
  READOUT_WASH,
  space,
  usePalette,
} from "@wattsteer/ui";
import { Text, View } from "react-native";
import { ObservedBadge } from "@/components/app/honesty";
import { BandFigure, ExpectationFigure } from "@/components/charts/band-figure";
import { useCopy, useFormat } from "@/i18n";
import { fill } from "@/i18n/format";

/**
 * The day, summed over the four subsystems — the landing page's headline
 * readout, in the product, on the gateway's own numbers.
 *
 * It is the answer to "we show this to a visitor and then never again": the
 * landing's big sample card opens with a national figure, a risk census and the
 * additivity argument, and the Overview went straight to the map without ever
 * stating the total the four rows are parts of. `GET /v1/grid/outlook` has
 * published `national` all along — `apps/api/src/api/grid.ts` computes it — so
 * this panel reads it rather than deriving anything.
 *
 * **Nothing here is added by this screen, and the distinction is the panel's
 * whole point.** `expectedMwh` is the gateway's sum of the four
 * `day_expected_mwh`, which is exact under any dependence between subsystems
 * because expectations add. `band` is the *persisted joint* band — quantiles
 * over four day totals drawn on one shared ensemble index — and is `null` with
 * a stated reason when no such row exists. What the panel must never do is
 * assemble a band by adding the four subsystems' quantiles, and it cannot: it
 * is handed one `Band | null` and has no quantiles to add.
 *
 * The copy is `copy.readout.*`, shared with the landing page. The three
 * sentences it borrows — what the figure is, the risk census, and why the ONS
 * `SIN` line is never used — are facts about the forecaster and the source
 * data, identical on both surfaces. Restating them under `copy.app.*` would be
 * two wordings of one claim, free to drift apart.
 */
export function NationalFigureBlock({ national }: { national: NationalOutlook }) {
  const colors = usePalette();
  const copy = useCopy();
  const f = useFormat();
  return (
    <View style={{ gap: space.md }}>
      {national.band === null ? (
        <ExpectationFigure
          label={copy.readout.nationalLabel}
          value={national.expectedMwh}
          unit="MWh"
          reason={national.bandUnavailableReason}
        />
      ) : (
        <BandFigure label={copy.readout.nationalLabel} band={national.band} unit="MWh" />
      )}
      <Text style={{ fontSize: 12, color: colors.inkMuted }}>
        {fill(copy.readout.riskCounts, {
          high: f.number(national.riskClassCounts.high),
          elevated: f.number(national.riskClassCounts.elevated),
          low: f.number(national.riskClassCounts.low),
        })}
      </Text>
      <Text style={{ fontSize: 11, lineHeight: 17, color: colors.inkFaint }}>
        {copy.readout.nationalGrainNote}
      </Text>
    </View>
  );
}

/**
 * The settled counterpart of {@link NationalPanel}, and the one that is on
 * screen today.
 *
 * Same finding, other half: `GET /v1/grid/now` publishes `national` and the
 * Overview never drew it, so a reader who had just been shown a national
 * headline on the landing page arrived at the product and found four regions
 * and no total.
 *
 * `derived: "sum_of_four"` is a **field** on that object rather than a comment
 * — `packages/core` says so in as many words: *"it says which four rows were
 * added, so a reader cannot mistake it for an ONS `SIN` row"* — and the note
 * under the figure is that field, read out. The panel carries an
 * `ObservedBadge` for the same reason every other settled panel does: the two
 * national figures on this screen are never both present, and the one that is
 * has to say which of the two claims it is making.
 *
 * No `ExpectationFigure` and no band here, and there could not be one. This is
 * a measurement, and the sentence a missing band would need — *why* the
 * forecaster cannot publish one — is not a sentence about settled megawatt
 * hours at all.
 */
export function ObservedNationalPanel({
  national,
  window: windowLabel,
}: {
  national: GridNow["national"];
  /** The 24-hour window these four measurements cover. */
  window: string;
}) {
  const colors = usePalette();
  const copy = useCopy();
  const f = useFormat();
  return (
    <Panel style={gradientBg(READOUT_WASH, colors.surface)}>
      <PanelHeader
        icon={<CalendarDaysIcon size={18} color={colors.inkMuted} />}
        title={copy.app.observed.nationalTitle}
        subtitle={copy.app.observed.nationalSubtitle}
        right={<ObservedBadge />}
      />
      <View style={{ marginTop: space.lg, gap: space.sm }}>
        <Text style={{ fontSize: 13, fontWeight: "500", color: colors.inkMuted }}>
          {copy.app.observed.nationalLabel}
        </Text>
        <View style={{ flexDirection: "row", alignItems: "baseline", gap: 6 }}>
          <Text
            selectable={true}
            style={{
              fontSize: 40,
              lineHeight: 44,
              fontWeight: "600",
              letterSpacing: -0.8,
              fontVariant: ["tabular-nums"],
              color: colors.ink,
            }}
          >
            {f.compact(national.last24hConstrainedOffMwh)}
          </Text>
          <Text style={{ fontSize: 14, fontWeight: "500", color: colors.inkMuted }}>
            MWh
          </Text>
        </View>
        <Text style={{ fontSize: 11, color: colors.info, fontVariant: ["tabular-nums"] }}>
          {windowLabel}
        </Text>
        <Text style={{ fontSize: 11, lineHeight: 17, color: colors.inkFaint }}>
          {copy.app.observed.nationalNote}
        </Text>
      </View>
    </Panel>
  );
}
