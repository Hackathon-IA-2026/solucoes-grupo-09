/**
 * Screen 2 — Explicar (IDEA.md §43), read from the **real** gateway.
 *
 * Three of this screen's four panels need a promoted model and one does not,
 * and today that means three of them are absent. `use-explain.ts` carries the
 * table and the reasoning; what matters here is that the screen does not
 * pretend otherwise.
 *
 * **What survives, and why it is on this screen at all.** The restriction
 * reasons ONS observed are a settled record of a day that happened; no model
 * was ever involved in them. This panel is the one IDEA.md does not have, and
 * the header note that argued for it — "without it the screen would consist
 * entirely of model output while looking like it was explaining the grid" —
 * turns out to have been the load-bearing decision on the whole screen: it is
 * the only reason Explain is not a blank page today. `api-surface.md` says
 * Explain is "disabled with the same sentence" when nothing is promoted, and
 * that is one panel too broad.
 *
 * **What the narration is now.** The response carries a `Narration` that is
 * either the language model's prose, generated in the requested locale, or the
 * deterministic template's **plan** — an ordered list of catalogue keys and the
 * values their placeholders take. `i18n/narration.ts` renders both, so this
 * screen no longer composes a sentence of its own: the hand-rolled paragraph
 * and the `NARRATION_SOURCE = "template"` constant that stood in for a server
 * that was not being called are both gone, and the footnote now names the
 * source the response actually reported.
 *
 * **The reliability curve is a separate question and gets a separate answer.**
 * A card is keyed by lane and never by day, so it can answer while this day
 * refuses and refuse while this day answers. It carries its own refusal rather
 * than being folded into the screen's.
 */

import type { ObservedReason } from "@wattsteer/core/api";
import {
  Badge,
  HashIcon,
  LayersIcon,
  Panel,
  PanelHeader,
  PieChartIcon,
  SparklesIcon,
  space,
  usePalette,
} from "@wattsteer/ui";
import { router } from "expo-router";
import Head from "expo-router/head";
import type { ReactNode } from "react";
import { Text, View } from "react-native";
import {
  AppShell,
  MiniPill,
  ScreenTitle,
  SectionBlock,
} from "@/components/app/app-shell";
import { ForecastAbsent } from "@/components/app/forecast-absent";
import { ForecastStamp, HonestyNote, VintageBadge } from "@/components/app/honesty";
import { ReadingState } from "@/components/app/thinking-orb";
import {
  gateProfileOf,
  sharedParams,
  useAppParams,
} from "@/components/app/use-app-params";
import {
  type DiagnosedDay,
  type ModelCardState,
  useExplain,
} from "@/components/app/use-explain";
import { useServing } from "@/components/app/use-serving";
import { NO_BRIEFING_DATA } from "@/components/briefing/briefing-data";
import { usePublishBriefingSubject } from "@/components/briefing/briefing-subject";
import { BandFigure } from "@/components/charts/band-figure";
import { DriverBars } from "@/components/charts/driver-bars";
import { ReliabilityCurve } from "@/components/charts/reliability-curve";
import { RiskCaveat, RiskChip, RiskScale } from "@/components/charts/risk-class";
import { useCopy, useFormat, useI18n } from "@/i18n";
import { fill } from "@/i18n/format";
import { languageTag } from "@/i18n/locale";
import { renderNarration } from "@/i18n/narration";
import { attributedDrivers } from "@/lib/explain";
import { FIXTURE_LANE, subsystemMeta } from "@/lib/fixtures";

/**
 * Explicar, as a route and as a section of `/app`.
 *
 * `embedded` is the whole of the difference. Standing alone it is a page: its
 * own `Head`, its own `AppShell`, its own title. Inside the Overview it is a
 * `SectionBlock` under the same shell, reading the same selection, and it does
 * not publish a briefing subject — the page that owns the scroll speaks for
 * every section on it, because that channel is last-writer-wins and two
 * publishers do not merge, they race.
 *
 * One implementation rather than two so the section cannot drift from the page:
 * a panel added here appears in both, and `/app/explain` stays a URL that works
 * for anyone who has one.
 */
export default function ExplainScreen({ embedded = false }: { embedded?: boolean }) {
  const colors = usePalette();
  const copy = useCopy();
  const f = useFormat();
  const { locale } = useI18n();
  const serving = useServing();
  const params = useAppParams();
  const meta = subsystemMeta(params.subsystem);
  const state = useExplain({
    subsystem: params.subsystem,
    targetDate: params.date,
    gateProfile: gateProfileOf(params.run),
    // The lane the rest of this deployment's numbers come from. It is a
    // published constant rather than a pick from `/v1/meta`'s list, because no
    // rule yet says which of two served lanes a reader is looking at — the
    // gateway refuses to default it for the same reason, and inventing the
    // rule here would be the client deciding it.
    lane: FIXTURE_LANE,
    locale: languageTag(locale),
  });

  /*
    Published for the briefing host beside the dock. This screen is the only one
    holding a diagnosis and the ONS reasons, so it is the only one whose briefing
    can carry a `cause` or a `constraint` scene — and on a refused day both are
    `null` here and `compose.ts` never emits them.

    At the top level rather than inside a render branch: the branches have
    already narrowed `state`, and a publish that only runs on the happy path
    would leave the host holding the previous screen's subject.
  */
  const diagnosedDay = state.status === "explained" ? state.day : null;
  usePublishBriefingSubject(
    {
      context: { locale, screen: "explain", params, serving, explain: state },
      data: {
        ...NO_BRIEFING_DATA,
        drivers:
          diagnosedDay === null
            ? null
            : attributedDrivers(diagnosedDay.diagnosis.attribution.drivers),
        // `reading` has no observed half yet and `refused` never will; both
        // publish nothing rather than an empty list, because "no reasons" and
        // "not read" are different facts and the scene says so.
        reasons:
          state.status === "explained" || state.status === "observedOnly"
            ? state.observed.reasons.rows
            : null,
        dayEnergy: diagnosedDay === null ? null : diagnosedDay.forecast.dayEnergyMwh,
        peakPower: diagnosedDay === null ? null : diagnosedDay.forecast.peakPowerMw,
      },
      counterfactual: undefined,
    },
    !embedded,
  );

  /**
   * Whether there is a diagnosis to describe, which the lede turns on.
   *
   * The Overview draws this same line and says why: its forecast lede promises
   * "every figure is a P10/P50/P90 interval", which is true of the forecast
   * panels and flatly false of the observed ones. This screen had the identical
   * problem and only half the fix — `absentNote` says there is nothing to
   * explain, but it says it three panels down, while the lede at the top went on
   * promising "what the model is reading" on a deployment where nothing is
   * promoted.
   *
   * Non-diagnosed covers `reading` and `refused` as well as an answered day
   * with no forecast in it, which is the same reading the Overview takes: the
   * specific statement is the body's job, and the lede's job is not to promise
   * a panel that is not there.
   */
  const diagnosed = state.status === "explained" && state.day !== null;

  const title = fill(copy.app.explain.title, { subsystem: meta.onsDisplayName });
  const lede = fill(diagnosed ? copy.app.explain.lede : copy.app.explain.ledeAbsent, {
    date: f.date(params.date),
  });

  const frame = (right: ReactNode, body: ReactNode) =>
    embedded ? (
      <SectionBlock id="explain" title={title} lede={lede} right={right}>
        {body}
      </SectionBlock>
    ) : (
      <>
        <Head>
          <title>{copy.app.explain.metaTitle}</title>
          <meta name="robots" content="noindex,follow" />
        </Head>
        <AppShell>
          <ScreenTitle title={title} lede={lede} right={right} />
          {body}
        </AppShell>
      </>
    );

  if (state.status === "reading") {
    return frame(null, <ReadingState title={copy.app.explain.readingTitle} />);
  }

  if (state.status === "refused") {
    return frame(
      null,
      <HonestyNote
        title={copy.app.explain.refusedTitle}
        tone="warning"
        points={[copy.error[state.code], copy.app.explain.refusedNote]}
      />,
    );
  }

  const day = state.status === "explained" ? state.day : null;

  return frame(
    day === null ? null : (
      <ForecastStamp
        origin={day.forecast.forecastOrigin}
        thresholdMw={day.forecast.thresholdMw}
      />
    ),
    <>
      {day === null ? null : <DiagnosedPanels day={day} />}

      <ReliabilityPanel card={state.observed.card} />

      <ObservedReasonsPanel
        reasons={state.observed.reasons.rows}
        date={state.observed.reasons.date}
        fidelity={state.observed.reasons.vintageFidelity}
      />

      {/*
        The absence sits below the answers, for the reason the Overview gives:
        opening on "no forecast for this day" makes a screen that is full of
        real settled reasons look empty. Everything above is observed and says
        so; this says why the modelled half is missing, which is what a reader
        wants *after* seeing what is there.
      */}
      {state.status === "observedOnly" ? (
        <ForecastAbsent
          code={state.code}
          title={copy.app.explain.absentTitle}
          note={copy.app.explain.absentNote}
        />
      ) : null}

      <View
        style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center" }}
      >
        <Text style={{ fontSize: 12, color: colors.inkMuted }}>
          {copy.app.explain.next}
        </Text>
        <MiniPill
          label={copy.app.explain.nextMitigate}
          active={false}
          onPress={() =>
            router.push({
              pathname: "/app/mitigate" as never,
              params: sharedParams(params),
            })
          }
        />
      </View>
    </>,
  );
}

/**
 * The day, as the model sees it: its risk, its two bands, its drivers and the
 * paragraph about them.
 *
 * Written in full and rendered by nothing today. That is the point: "these
 * screens light up with no further edits when a model is promoted" is only a
 * claim if the code that lights up is already here and already type-checks
 * against the contract.
 */
function DiagnosedPanels({ day }: { day: DiagnosedDay }) {
  const colors = usePalette();
  const copy = useCopy();
  const f = useFormat();
  const { forecast, diagnosis } = day;

  return (
    <>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.lg }}>
        <Panel style={{ flexGrow: 1, flexShrink: 1, flexBasis: 300, gap: space.lg }}>
          <PanelHeader
            icon={<HashIcon size={18} color={colors.inkMuted} />}
            title={copy.app.explain.riskTitle}
            subtitle={copy.app.explain.riskSubtitle}
          />
          <RiskChip probability={forecast.dayOccurrenceProbability} />
          <RiskScale probability={forecast.dayOccurrenceProbability} />
          <RiskCaveat />
        </Panel>
        <Panel style={{ flexGrow: 1, flexShrink: 1, flexBasis: 300 }}>
          <BandFigure
            label={copy.app.explain.magnitude}
            band={forecast.dayEnergyMwh}
            unit="MWh"
            footnote={copy.app.explain.magnitudeNote}
          />
        </Panel>
        <Panel style={{ flexGrow: 1, flexShrink: 1, flexBasis: 300 }}>
          <BandFigure
            label={copy.app.explain.peakPower}
            band={forecast.peakPowerMw}
            unit="MW"
            tone="violet"
          />
        </Panel>
      </View>

      <Panel>
        <PanelHeader
          icon={<SparklesIcon size={18} color={colors.inkMuted} />}
          title={copy.app.explain.narrationTitle}
          subtitle={copy.app.explain.narrationSubtitle}
        />
        <Text
          style={{
            marginTop: space.lg,
            fontSize: 15,
            lineHeight: 25,
            color: colors.inkMuted,
          }}
        >
          {/*
            Both arms of the union, rendered by one function. The model's
            arrives as prose already in the requested locale — the single
            settled exception to "codes on the wire, the client renders the
            words"; the template's arrives as a plan of catalogue keys and
            values, and `i18n/narration.ts` formats each value through `Intl`,
            because `412,0` and `412.0` are the same number and different
            strings and which one a reader sees is a property of the reader.
          */}
          {renderNarration(diagnosis.narration, copy, f)}
        </Text>
        <Text style={{ marginTop: space.md, fontSize: 11, color: colors.inkFaint }}>
          {/* The source the response reported, not a constant this file chose. */}
          {diagnosis.narration.source === "model"
            ? copy.app.explain.narrationNoteModel
            : copy.app.explain.narrationNoteTemplate}
        </Text>
        {diagnosis.withheldBy.length === 0 ? null : (
          <Text style={{ marginTop: space.sm, fontSize: 11, color: colors.inkFaint }}>
            {/*
              A `withhold` rule fired: the drivers are untouched and the
              template narration stands in for the model's. A 200, not an
              error, and saying so is the difference between "the model chose
              not to speak" and "the model was not asked".
            */}
            {fill(copy.app.explain.narrationWithheld, {
              // Rule codes, not prose: they are identifiers the server chose
              // and an operator greps for, so they travel untranslated the way
              // a lane name and a reason code do.
              codes: diagnosis.withheldBy.join(", "),
            })}
          </Text>
        )}
      </Panel>

      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.lg }}>
        <Panel style={{ flexGrow: 1, flexShrink: 1, flexBasis: 380 }}>
          <PanelHeader
            icon={<LayersIcon size={18} color={colors.inkMuted} />}
            title={copy.app.explain.driversTitle}
            subtitle={copy.app.explain.driversSubtitle}
          />
          <View style={{ marginTop: space.lg }}>
            {/*
              All eight groups, ranked by the server. `lib/driver-rows.ts`
              applies the `share >= 0.03` cut, the six-row cap and the merge
              into `other` — the half of the rule that is the client's, and the
              half the server must never hold.
            */}
            <DriverBars drivers={attributedDrivers(diagnosis.attribution.drivers)} />
          </View>
        </Panel>
      </View>
    </>
  );
}

/**
 * The calibration curve, or the reason there is none.
 *
 * `GET /v1/model/card?lane=` refuses with `MODEL_UNAVAILABLE` whenever no
 * artifact is promoted, and the response type says so structurally: `laneState`
 * is the constant `"promoted"`, because the other three states are never a card
 * with empty groups. So this panel has exactly two renderings and today it is
 * the second one.
 *
 * **The refused artifact's own card is not shown, and that is a decision.**
 * `GET /v1/model/artifacts` will serve the card of an artifact the gate
 * refused — and on these lanes the gate refused it *on calibration*, so that
 * card's reliability curve is literally the evidence for the refusal. It is an
 * operator's read and not a reader's: a calibration curve on a product screen
 * is the promise "this is how well the model you are looking at is calibrated",
 * and there is no model anyone is looking at. Drawing a refused artifact's
 * curve under that heading would be the same failure as a fixture curve, one
 * step subtler.
 */
function ReliabilityPanel({ card }: { card: ModelCardState }) {
  const colors = usePalette();
  const copy = useCopy();
  const f = useFormat();

  if (card.status === "refused") {
    return (
      <Panel>
        <PanelHeader
          icon={<PieChartIcon size={18} color={colors.inkMuted} />}
          title={copy.app.explain.reliabilityTitle}
          subtitle={copy.app.explain.reliabilitySubtitle}
        />
        <Text
          style={{
            marginTop: space.lg,
            fontSize: 12,
            lineHeight: 19,
            color: colors.inkMuted,
          }}
        >
          {copy.error[card.code]}
        </Text>
        <Text style={{ marginTop: space.sm, fontSize: 11, color: colors.inkFaint }}>
          {copy.app.explain.reliabilityAbsentNote}
        </Text>
      </Panel>
    );
  }

  const reliability = card.card.reliability;
  return (
    <Panel>
      <PanelHeader
        icon={<PieChartIcon size={18} color={colors.inkMuted} />}
        title={copy.app.explain.reliabilityTitle}
        subtitle={copy.app.explain.reliabilitySubtitle}
        right={<VintageBadge fidelity={reliability.vintageFidelity} />}
      />
      <View style={{ marginTop: space.lg }}>
        <ReliabilityCurve points={reliability.points} />
      </View>
      <Text style={{ marginTop: space.md, fontSize: 11, color: colors.inkFaint }}>
        {fill(copy.app.explain.reliabilityNote, {
          hours: f.exact(reliability.sampleHours),
          from: f.date(reliability.window.start),
          to: f.date(reliability.window.end),
        })}
      </Text>
    </Panel>
  );
}

/**
 * Observed restriction reasons, at the grain ONS reports them and no finer.
 *
 * The single hardest thing on this screen to get right: a reason is a property
 * of a `ReportingEntity`, and there is no path in the type system from a plant
 * to one. Most curtailed energy belongs to a *conjunto*, where the reason
 * belongs to the settlement unit and may not be pushed down to member plants;
 * the Tipo I / II-B plants are their own reporting entities and their reasons
 * genuinely are observed at plant grain. So the panel labels the grain per row
 * rather than assuming one for the table.
 *
 * `reason.description` is `dsc_restricao` as ONS wrote it, and stays in ONS's
 * Portuguese in both locales: it is a source record, not copy, and translating
 * one would be inventing evidence.
 *
 * **`cause_mixed` is now on the row and is rendered.** The fixture shape had no
 * field for it; the wire does, because the schema already records that an hour
 * changed cause mid-way, and hiding that would make the single stored reason
 * look like an observation rather than a simplification.
 */
function ObservedReasonsPanel({
  reasons,
  date,
  fidelity,
}: {
  reasons: readonly ObservedReason[];
  date: string;
  fidelity: Parameters<typeof VintageBadge>[0]["fidelity"];
}) {
  const colors = usePalette();
  const copy = useCopy();
  const f = useFormat();
  return (
    <Panel>
      <PanelHeader
        icon={<HashIcon size={18} color={colors.inkMuted} />}
        title={copy.app.explain.reasonsTitle}
        subtitle={fill(copy.app.explain.reasonsSubtitle, { date: f.date(date) })}
        right={<VintageBadge fidelity={fidelity} />}
      />
      <View style={{ marginTop: space.lg, gap: space.md }}>
        {reasons.length === 0 ? (
          <Text style={{ fontSize: 12, lineHeight: 19, color: colors.inkMuted }}>
            {copy.app.explain.reasonsEmpty}
          </Text>
        ) : (
          reasons.map((reason) => (
            <View
              key={reason.entityCode}
              style={{
                flexDirection: "row",
                flexWrap: "wrap",
                alignItems: "center",
                gap: 10,
                paddingBottom: space.md,
                borderBottomWidth: 1,
                borderBottomColor: colors.border,
              }}
            >
              <Badge
                label={reason.reason}
                tone={reason.reason === "REL" ? "danger" : "violet"}
              />
              <Badge label={reason.origin} tone="neutral" />
              <View style={{ flexGrow: 1, flexShrink: 1, flexBasis: 200 }}>
                <Text style={{ fontSize: 14, fontWeight: "600", color: colors.ink }}>
                  {reason.entityLabel}
                </Text>
                <Text style={{ fontSize: 11, color: colors.inkFaint }}>
                  {reason.grain === "conjunto"
                    ? copy.app.explain.grainConjunto
                    : copy.app.explain.grainPlant}
                </Text>
              </View>
              <Text
                style={{
                  fontSize: 14,
                  fontWeight: "700",
                  fontVariant: ["tabular-nums"],
                  color: colors.ink,
                }}
              >
                {`${f.number(reason.constrainedOffMwh, 1)} MWh`}
              </Text>
              {reason.causeMixed ? (
                <Text style={{ fontSize: 11, color: colors.inkFaint, flexBasis: "100%" }}>
                  {copy.app.explain.causeMixed}
                </Text>
              ) : null}
              {reason.description === null ? null : (
                <Text style={{ fontSize: 11, color: colors.inkFaint, flexBasis: "100%" }}>
                  {reason.description}
                </Text>
              )}
            </View>
          ))
        )}
        <Text style={{ fontSize: 11, lineHeight: 18, color: colors.inkFaint }}>
          {copy.app.explain.reasonLegend}
        </Text>
      </View>
    </Panel>
  );
}
