/**
 * The technology split — and the reason it is not a chart with a band on it.
 *
 * The Overview used to take the technology selection and rebuild the whole
 * forecast from it: a P10/P50/P90 per hour *per technology*, drawn as a fan.
 * There is no such model. The forecaster has one head per subsystem, so the
 * only thing it can divide between the two fleets is the **expectation**, and
 * an expectation divides exactly because expectations add.
 *
 * So the selector's job changed rather than disappearing. It picks which of
 * two scalars this panel emphasises, and the panel exists to make that a
 * visible, honest answer instead of a silently narrower forecast:
 *
 *  - The **day expectation** is stated first, as a plain number, with the
 *    reason it is not the middle of the band underneath it. `E[Y]` sits above
 *    the median whenever there is meaningful mass on "no curtailment at all",
 *    and on a quiet subsystem the median is flatly zero while the expectation
 *    is not — which is precisely the case a screen showing only a P50 reports
 *    as "nothing happening".
 *  - The **two scalars** are drawn as shares of that expectation, on one
 *    track. A share is the only comparison the numbers support; a pair of
 *    strips with quantiles on them would be inventing a distribution.
 *
 * There is deliberately no `Band` anywhere in this file, and the props cannot
 * carry one: `TechnologySplit` is two `number`s in `@wattsteer/core` and the
 * schema rejects anything else at the boundary.
 */

import { space, usePalette } from "@wattsteer/ui";
import { Text, View } from "react-native";
import { useCopy, useFormat } from "@/i18n";
import type { Technology, TechnologySplit } from "@/lib/fixtures";
import { splitFor } from "@/lib/fixtures";

const ORDER: readonly Technology[] = ["WIND", "SOLAR"];

export function TechnologySplitPanel({
  split,
  expectedMwh,
  emphasis,
}: {
  split: TechnologySplit;
  /** `E[Y]` for the day. The two scalars sum to it. */
  expectedMwh: number;
  /** Which scalar the URL's technology selection is asking about. */
  emphasis: Technology;
}) {
  const colors = usePalette();
  const copy = useCopy();
  const f = useFormat();
  const total = Math.max(split.windMwh + split.solarMwh, 1e-9);

  return (
    <View style={{ gap: space.md }}>
      <View style={{ gap: 4 }}>
        <Text style={{ fontSize: 13, fontWeight: "500", color: colors.inkMuted }}>
          {copy.app.split.expected}
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
            {f.compact(expectedMwh)}
          </Text>
          <Text style={{ fontSize: 14, fontWeight: "500", color: colors.inkMuted }}>
            MWh
          </Text>
        </View>
        <Text style={{ fontSize: 11, color: colors.inkFaint, lineHeight: 17 }}>
          {copy.app.split.expectedNote}
        </Text>
      </View>

      <SplitTracks split={split} emphasis={emphasis} total={total} />

      <Text style={{ fontSize: 11, color: colors.inkFaint, lineHeight: 17 }}>
        {copy.app.split.note}
      </Text>
    </View>
  );
}

/**
 * The same two fleets, **settled** — the observed counterpart of
 * {@link TechnologySplitPanel}.
 *
 * The difference between the two panels is not cosmetic and the copy says so.
 * The forecast split is a *division of one modelled expectation*: the
 * forecaster has a single head per subsystem, so wind and solar there are two
 * slices of one number it produced, and neither has a distribution of its own.
 * This split is **two separate settlements**: `GET /v1/curtailment/hours`
 * publishes at (subsystem, technology, valid_time) grain, so ONS measured the
 * fleets apart and the total is their sum rather than their source.
 *
 * That makes this the one panel on the observed half that is *stronger* than
 * its forecast counterpart, and it is worth a reader knowing which of the two
 * they are looking at for that reason alone — quite apart from the fact that
 * one is about a day that happened and the other about a day that has not.
 */
export function ObservedSplitPanel({
  split,
  emphasis,
  window: windowLabel,
}: {
  split: TechnologySplit;
  /** Which scalar the URL's technology selection is asking about. */
  emphasis: Technology;
  /** The settled day these two numbers cover. */
  window: string;
}) {
  const colors = usePalette();
  const copy = useCopy();
  const f = useFormat();
  const settled = split.windMwh + split.solarMwh;
  const total = Math.max(settled, 1e-9);

  return (
    <View style={{ gap: space.md }}>
      <View style={{ gap: 4 }}>
        <View
          style={{
            flexDirection: "row",
            flexWrap: "wrap",
            alignItems: "center",
            justifyContent: "space-between",
            gap: space.sm,
          }}
        >
          <Text style={{ fontSize: 13, fontWeight: "500", color: colors.inkMuted }}>
            {copy.app.observed.splitTotal}
          </Text>
          {/*
            **No badge here, and the panel header's is the one that stays.** This
            component renders inside a `Panel` whose `PanelHeader` already
            carries `ObservedBadge` on its right edge, so the word appeared
            twice within one card — once naming the panel and once naming the
            total inside it. A caveat repeated inside its own scope stops
            reading as a caveat and starts reading as decoration, which is the
            same argument that collapsed four "Dados de exemplo" badges on the
            landing hero into one and then to none.

            The claim is not weakened: every figure in this panel is under a
            header that says `Observado`, and the subtitle beside it says
            "liquidado, duas medições".
          */}
        </View>
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
            {f.compact(settled)}
          </Text>
          <Text style={{ fontSize: 14, fontWeight: "500", color: colors.inkMuted }}>
            MWh
          </Text>
        </View>
        <Text style={{ fontSize: 11, color: colors.info, fontVariant: ["tabular-nums"] }}>
          {windowLabel}
        </Text>
      </View>

      <SplitTracks split={split} emphasis={emphasis} total={total} />

      <Text style={{ fontSize: 11, color: colors.inkFaint, lineHeight: 17 }}>
        {copy.app.observed.splitNote}
      </Text>
    </View>
  );
}

/**
 * The two fleets as shares of one total, on two tracks.
 *
 * **The one thing both panels above genuinely share.** The blocks they drew
 * were byte-identical — fifty-seven lines each, differing only in a comment —
 * which is the shape of a copy-paste rather than of a coincidence: the same
 * pair of labelled rows, the same tabular figures, the same dimming of the
 * fleet the URL did not ask about.
 *
 * Extracting it does **not** merge the two panels, and that distinction is the
 * whole reason this is a third component rather than a `variant` prop on a
 * single one. The panels differ in what their total *means* — a division of one
 * modelled expectation on one side, two separate ONS settlements on the other —
 * and this component has no opinion about that. It is handed a total and two
 * scalars and draws their proportion. Everything that makes the two claims
 * different is in the headline, the badge and the footnote, which stay where
 * they are and stay distinct.
 *
 * `total` is a parameter rather than `windMwh + solarMwh` computed here, for
 * exactly that reason: the forecast panel's denominator is the expectation the
 * two scalars divide, and re-deriving it would be this component forming an
 * opinion about a quantity it was told.
 */
function SplitTracks({
  split,
  emphasis,
  /** The denominator. Its meaning belongs to the caller; see above. */
  total,
}: {
  split: TechnologySplit;
  emphasis: Technology;
  total: number;
}) {
  const colors = usePalette();
  const copy = useCopy();
  const f = useFormat();
  return (
    <View style={{ gap: space.sm }}>
      {ORDER.map((technology) => {
        const value = splitFor(split, technology);
        const emphasised = technology === emphasis;
        const tone = technology === "WIND" ? colors.accent : colors.violet;
        return (
          <View key={technology} style={{ gap: 5 }}>
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
                gap: space.sm,
              }}
            >
              <Text
                style={{
                  fontSize: 12,
                  fontWeight: emphasised ? "700" : "500",
                  color: emphasised ? colors.ink : colors.inkMuted,
                }}
              >
                {emphasised
                  ? `${copy.app.technology[technology]} · ${copy.app.split.emphasised}`
                  : copy.app.technology[technology]}
              </Text>
              <Text
                style={{
                  fontSize: 13,
                  fontWeight: emphasised ? "700" : "500",
                  fontVariant: ["tabular-nums"],
                  color: emphasised ? colors.ink : colors.inkMuted,
                }}
              >
                {`${f.compact(value)} MWh · ${f.percent(value / total)}`}
              </Text>
            </View>
            {/*
              A share of one expectation, on one track — not an interval.
              The unemphasised fleet is dimmed rather than hidden: a split
              whose other half you cannot see is a filter again.
            */}
            <View
              style={{
                height: 8,
                borderRadius: 4,
                backgroundColor: colors.surfaceSunken,
                overflow: "hidden",
              }}
            >
              <View
                style={{
                  height: "100%",
                  width: `${Math.min(100, (value / total) * 100)}%`,
                  borderRadius: 4,
                  backgroundColor: tone,
                  opacity: emphasised ? 0.85 : 0.28,
                }}
              />
            </View>
          </View>
        );
      })}
    </View>
  );
}
