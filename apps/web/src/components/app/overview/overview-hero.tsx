/**
 * The Overview's hero: the four subsystems as one block, with the map at the
 * centre and the selection's figures around it.
 *
 * ## Where it came from
 *
 * A mockup at `/app/console`, built to answer whether a map-centred layout
 * suits a product with four regions rather than four hundred cities. It does,
 * so it is the Overview now and the mockup route is gone.
 *
 * ## What it is, and what it deliberately is not
 *
 * It is the **top** of the screen, not the whole of it. The panels below still
 * draw everything they drew — the P10–P90 bands for the day and the peak, the
 * technology split, the risk caveat, the settled section — because a layout
 * that reads better is not a reason to publish less. Promoting this mockup
 * twice dropped panels nobody was thinking about, and the fix both times was to
 * compare component lists rather than to look at the screen.
 *
 * The reference dashboards it borrows from are beautiful and they lie: eight
 * digits of precision over invented geography, every number a single confident
 * figure. This borrows the layout and none of the certainty. Every figure is
 * drawn by a component the product already ships, and where there is no band it
 * says why rather than drawing one.
 */

import { SUBSYSTEM_DISPLAY_ORDER } from "@wattsteer/core";
import {
  ClockIcon,
  MapIcon,
  Panel,
  PieChartIcon,
  SearchIcon,
  space,
  type,
  usePalette,
  ZapIcon,
} from "@wattsteer/ui";
import { Link } from "expo-router";
import { useState } from "react";
import { Platform, Text, View } from "react-native";
import type { AppParams } from "@/components/app/params";
import { gateProfileOf } from "@/components/app/use-app-params";
import { useRunLanes } from "@/components/app/use-run-lanes";
import { SelectedRegion } from "@/components/app/selected-region";
import type { ForecastNetwork, ObservedNetwork } from "@/components/app/use-network";
import { FanChart } from "@/components/charts/fan-chart";
import { ObservedProfile } from "@/components/charts/observed-profile";
import { riskColor } from "@/components/charts/risk-color";
import { RiskChip } from "@/components/charts/risk-class";
import { QuestionCard } from "@/components/app/figures/question-cards";
import { BandTriple, PanelTitle, RailFact } from "@/components/app/figures/rail-panels";
import { useCoverage } from "@/components/app/figures/use-coverage";
import { RegionMap } from "@/components/app/map/region-map";
import type { Scope } from "@/components/app/map/scope-bar";
import { SplitTracks } from "@/components/charts/technology-split";
import { useCopy, useFormat, useI18n } from "@/i18n";
import { fill } from "@/i18n/format";
import { criticalWindow } from "@/lib/critical-window";
import type { SubsystemCode } from "@/lib/fixtures";
import { roundProbability, subsystemMeta } from "@/lib/fixtures";
import {
  forecastHours,
  forecastRow,
  observedDay,
  observedRows,
  outlookRows,
} from "@/lib/network";
import { HERO_COPY } from "./hero-copy";
import { NationalFigureBlock, ObservedNationalPanel } from "./national-panel";
import { HeroStat, RegionRow } from "./region-rail";

/**
 * The width at which the rails move beside the map rather than under it.
 *
 * Measured on the content column rather than the window: the shell centres its
 * page, so a window query would put rails beside a map on a 1200px viewport
 * whose column is 1160 and not on a 1100px one whose column is the same. The
 * map is the thing that must not be squeezed.
 */
const RAILS_BESIDE_MAP = 980;

export function OverviewHero({
  observed,
  forecast,
  params,
  onExplain,
}: {
  observed: ObservedNetwork;
  forecast: ForecastNetwork | null;
  /**
   * The screen's own Explain handler.
   *
   * Not `scrollToSection` called from here, which is what the first cut did and
   * what `app-overview-selection.spec.ts` caught within the hour: the control
   * scrolled but stopped carrying the selection, so pressing "Explicar
   * NORDESTE" opened the section pointed at whatever was selected before. The
   * screen owns "select **and** go", and always did.
   */
  onExplain: (subsystem: SubsystemCode) => void;
  /** The live selection, with its writer — the map and the rail set it. */
  params: AppParams & {
    setParams: (next: Partial<Omit<AppParams, "date">>) => void;
  };
}) {
  const colors = usePalette();
  const copy = useCopy();
  const f = useFormat();
  const { locale } = useI18n();
  const text = HERO_COPY[locale === "en" ? "en" : "pt"];
  const [hovered, setHovered] = useState<SubsystemCode | null>(null);
  /*
    Which region the map's pills are pointing at. Local, like the console's, and
    for the same reason: `subsystem` is the shared choice every screen reads, and
    scope only says whether this map is currently narrowed to it.
  */
  const [scope, setScope] = useState<Scope>(
    // A link that named a region is somebody pointing at it, and the screen
    // opens where they pointed. A plain visit opens on the whole grid.
    params.subsystemFromUrl === true ? "region" : "sin",
  );
  /*
    The run chips moved onto the map with the region chips, so this screen asks
    for the lane table the way the console does. The hook also carries the
    correction that keeps `run` off a gate that cannot serve.
  */
  const { inertFor: runInert } = useRunLanes();
  /*
    The band's measured coverage, for the gate this screen is reading. The
    statistic the operator brief calls "accuracy" — see `use-coverage.ts` for
    why it is coverage and not a per-day score.
  */
  const coverage = useCoverage(gateProfileOf(params.run));
  const [width, setWidth] = useState(0);
  const wide = width >= RAILS_BESIDE_MAP;

  const meta = subsystemMeta(observed.subsystem as SubsystemCode);
  const day = observedDay(observed.hours);

  /*
    The map's paint and the rail's rows come from the same read, which is what
    keeps them from disagreeing. `outlookRows` where a forecast exists,
    `observedRows` where it does not — the same union the Overview draws, and
    the same reason: a settled megawatt-hour and a modelled risk class are not
    two renderings of one fact.
  */
  const paint = forecast
    ? ({ kind: "forecast", rows: outlookRows(forecast.outlook) } as const)
    : ({
        kind: "observed",
        rows: observedRows(observed.now.subsystems, SUBSYSTEM_DISPLAY_ORDER),
      } as const);

  const regions = forecast
    ? outlookRows(forecast.outlook).map((row) => ({
        code: subsystemMeta(row.subsystem).short,
        subsystem: row.subsystem,
        name: subsystemMeta(row.subsystem).onsDisplayName,
        value: row.dayExpectedMwh,
        chip: <RiskChip probability={row.occurrenceProbability} compact={true} />,
        note: `≈${f.percentPoints(roundProbability(row.occurrenceProbability))}`,
      }))
    : observedRows(observed.now.subsystems, SUBSYSTEM_DISPLAY_ORDER).map((row) => ({
        code: subsystemMeta(row.subsystem).short,
        subsystem: row.subsystem,
        name: row.onsDisplayName,
        value: row.last24hMwh,
        chip: undefined,
        note: undefined,
      }));

  const largest = Math.max(...regions.map((row) => row.value), 1e-6);
  const national = regions.reduce((sum, row) => sum + row.value, 0);
  const mine = regions.find((row) => row.subsystem === observed.subsystem);
  const selectedRow = forecast === null ? null : forecastRow(forecast.forecast);

  /*
    The region leading the day — the answer to "where?". Not an average of four
    and not a national row: there is no national band, because quantiles do not
    add, and the only thing an operator can act on is the region carrying the
    day.
  */
  const leaderRow =
    forecast === null
      ? null
      : outlookRows(forecast.outlook).reduce((worst, row) =>
          row.dailyEnergy.p50 > worst.dailyEnergy.p50 ? row : worst,
        );

  /*
    **"Onde?" is not always one place.**

    Naming the leader alone is right when one region carries the day and wrong
    when four are in the same bin — which is most of this week: all four read
    `Alto`, and a card saying "NORDESTE" tells a reader the other three are
    quiet. So in the overall scope the card names every region in the worst bin
    that is on the board, and falls back to the leader only when that bin has
    one member. With a region chosen, the answer is that region: the reader has
    already said where they are looking.
  */
  const atRisk =
    forecast === null
      ? []
      : outlookRows(forecast.outlook).filter(
          (row) => row.riskClass === (leaderRow?.riskClass ?? "low"),
        );

  /*
    **"Por quê?" is not always one reason either.**

    ONS splits a day between codes often enough that the second one is worth
    saying when it carries real energy. Below this the card names one: a second
    reason at 4 % is noise, and a card is 168 px.
  */
  /*
    **What "Quanto?" and "Vai cortar?" are about, which the scope decides.**

    Both cards used the selected region unconditionally, which was fine while a
    national block sat above them saying so. With one panel following the scope,
    a card that ignored it would put the region's 226,7k beside the panel's
    275,3k with nothing saying they are different subjects — the exact confusion
    the merge was made to remove.

    In the overall scope the magnitude is the national one the gateway
    publishes, and the risk is the worst bin any subsystem is in: there is no
    national risk class and adding four probabilities would not make one.
  */
  const nationalBand = forecast === null ? null : forecast.outlook.national.band;
  const magnitudeMwh =
    forecast === null || selectedRow === null
      ? null
      : scope === "sin"
        ? (nationalBand?.p50 ?? forecast.outlook.national.expectedMwh)
        : selectedRow.dailyEnergy.p50;
  const magnitudeBand =
    scope === "sin" ? nationalBand : (selectedRow?.dailyEnergy ?? null);
  const riskRow = scope === "sin" ? leaderRow : selectedRow;

  const SECOND_REASON_SHARE = 0.15;
  const spokenReasons = observed.reasons
    .slice(0, 2)
    .filter((entry, index) => index === 0 || entry.share >= SECOND_REASON_SHARE);

  /*
    The hours to act in. `null` where no hour of the day is more likely to
    curtail than not, which is an answer and not a gap — the card simply does
    not claim a window it does not have.
  */
  const window =
    forecast === null ? null : criticalWindow(forecastHours(forecast.forecast));

  const headline = (
    <Panel style={{ gap: space.lg }}>
      {/*
        **The three quantiles, named, and the coverage under them.**

        This was one large number with a band strip below it, which says what the
        median is and leaves the edges to be read off a bar. The interval is the
        product's claim, so all three are printed — and the fraction of settled
        days that actually landed inside the band goes with them, because an
        interval without its measured coverage is a promise with no record.
      */}
      {selectedRow === null || forecast === null ? (
        <>
          <HeroStat
            label={text.totalLabel}
            value={day.totalMwh}
            unit="MWh"
            note={text.totalNoteObserved}
          />
          <Text style={{ ...type.caption, color: colors.inkFaint }}>{text.noBand}</Text>
        </>
      ) : scope === "sin" ? (
        <NationalFigureBlock national={forecast.outlook.national} />
      ) : (
        <>
          <PanelTitle
            title={text.totalLabel}
            note={`${subsystemMeta(selectedRow.subsystem).onsDisplayName} · ${
              text.totalNoteForecast
            }`}
          />
          <BandTriple band={selectedRow.dailyEnergy} />
        </>
      )}

      {/*
        The coverage is the gate's, measured over a held-out fold for this
        lane — so it describes the band whichever subject the band is about, and
        sits outside the branch rather than being repeated inside each one.
      */}
      {forecast !== null && coverage.status === "read" ? (
        <RailFact
          label={copy.app.grid.coverageLabel}
          value={f.percent(coverage.coverage.dayTotal, 0)}
          note={fill(copy.app.grid.coverageNote, {
            days: f.number(coverage.coverage.days),
            target: f.percent(coverage.coverage.target, 0),
          })}
        />
      ) : null}
      {/*
        **The division, in the card that already states the total.**

        This card and `ObservedSplitPanel` were showing the same figure under
        the same sentence — 46,3k MWh, "dia liquidado, somando as horas
        publicadas" — one with a national share under it and one with the two
        fleet bars. Two cards, one number, and a reader comparing them looking
        for the difference that is not there.

        So the bars move here, and the standalone panel goes. The note is the
        one the split panel carried, because it is the sentence that earns the
        bars: ONS settles the two fleets separately, so these are two
        measurements and the total is their sum.
      */}
      {forecast === null ? (
        <>
          <SplitTracks
            split={observed.daySplit}
            emphasis={params.technology}
            total={Math.max(observed.daySplit.windMwh + observed.daySplit.solarMwh, 1e-9)}
          />
          <Text style={{ ...type.caption, color: colors.inkFaint, lineHeight: 17 }}>
            {copy.app.observed.splitNote}
          </Text>
        </>
      ) : null}
      {/*
        **The window and the cause are the cards' now, at the top of the screen.**

        They were added here first, and then the operator brief's five questions
        moved onto this screen as a row of cards — which say the same two things
        in the same words, above the fold. Two answers to one question is how a
        reader learns to distrust both, so this panel keeps what the cards
        summarise (the figure, its band and the fleet split) and stops repeating
        what they state.
      */}
    </Panel>
  );

  const profile = (
    <Panel style={{ gap: space.md }}>
      <Text style={{ ...type.caption, color: colors.inkFaint }}>{text.profileLabel}</Text>
      <ObservedProfile hours={observed.hours} emptyLabel={copy.app.observed.emptyDay} />
      <Text style={{ ...type.caption, color: colors.inkFaint }}>
        {`${text.peakLabel}: ${
          day.peakHour === null
            ? "—"
            : `${f.compact(day.peakHour.constrainedOffMwh)} MWh · ${f.hour(
                day.peakHour.hourLocal,
              )}`
        }`}
      </Text>
    </Panel>
  );

  /*
    The split, which is the last thing the product knows about a selected
    region that the console was not showing. `ObservedSplitPanel` is the
    Overview's own component — two settlements, never a division of one
    modelled expectation — and it fills the column the profile left half empty.
  */
  const window24h = fill(copy.app.observed.window24h, {
    hour: f.dateTime(observed.now.latestSettledHour),
  });

  /*
    The national total, across the top. The one figure on the screen that is
    about the whole country rather than the selection, and the sentence under it
    — "a sum of four measurements, and it is exact" — is a claim the product
    makes on purpose: observations sum, quantiles do not, which is why there is
    no national *band* beside it in the forecast state either.
  */
  /*
    **The headline follows the scope, and there is only ever one of it.**

    This used to be the national figure unconditionally, sitting above a rail
    that showed the selected region's — two large numbers with two bands, a few
    hundred pixels apart, differing because they are about different things and
    saying so only in their labels. A reader comparing them looks for the
    difference and finds a subject change.

    So the scope decides: `SIN Geral` is the four subsystems summed, `Por Região`
    is the region chosen. Both are figures the gateway publishes; neither is
    derived here. What the scope never does is *invent* a national band — the
    outlook publishes one or states why it cannot, and `NationalFigureBlock`
    already draws that distinction.
  */
  /*
    **One headline panel, and the scope says whose day it is about.**

    There used to be two: a national block above the map and the selected
    region's figure in the rail beside it — two large numbers with two bands, a
    few hundred pixels apart, differing because they are about different things
    and saying so only in their labels.

    The scope filter already draws that distinction, so the panel follows it:
    `SIN Geral` is the four subsystems, `Por Região` is the one chosen. Nothing
    is summed here. `NationalOutlook.band` is a *joint* band the gateway
    persists — quantiles over draws of the four day totals under one shared
    draw index — and is `null` with a stated reason where no national row was
    published. `NationalFigureBlock` draws that distinction and is reused rather
    than reimplemented, because the alternative is a second place that could get
    it wrong.

    The observed state keeps its own national panel below: it reads the last
    24 hours rather than the settled day, which is a different window and not a
    second rendering of this one.
  */
  const nationalPanel =
    forecast === null ? (
      <ObservedNationalPanel national={observed.now.national} window={window24h} />
    ) : null;

  const rail = (
    <Panel style={{ gap: space.sm }}>
      <Text style={{ ...type.caption, color: colors.inkFaint }}>{text.regionsLabel}</Text>
      {/*
        **The rail's window, said out loud.**

        The headline above reads the *settled day* and these four read the
        *last 24 hours* — two different windows, and in the observed state that
        makes them 0,0 MWh and 1 843 MWh for the same region, a few hundred
        pixels apart with nothing between them explaining it. Two honest
        numbers adjacent with no window on either is how a screen manufactures
        a contradiction out of correct data.
      */}
      <Text style={{ ...type.caption, color: colors.inkFaint, paddingBottom: space.xs }}>
        {forecast === null ? text.windowObserved : text.windowForecast}
      </Text>
      {regions.map((row) => (
        <RegionRow
          key={row.subsystem}
          code={row.code}
          name={row.name}
          value={row.value}
          unit="MWh"
          share={row.value / largest}
          selected={row.subsystem === params.subsystem}
          highlighted={row.subsystem === hovered}
          onPress={() => params.setParams({ subsystem: row.subsystem })}
          onHoverChange={(on) => setHovered(on ? row.subsystem : null)}
          trailing={row.chip}
          note={row.note}
        />
      ))}
      <Text style={{ ...type.caption, color: colors.inkFaint, paddingTop: space.xs }}>
        {text.pickHint}
      </Text>
    </Panel>
  );

  /*
    **The operator brief's five questions, at the top of the screen it is about.**

    They were built for the console and belong here: this is the screen an
    operator opens, and the five are the shape the brief asks the answer to take.
    Every figure in them is one this screen was already drawing further down —
    what changes is that a reader no longer has to assemble the answer from four
    panels.

    Only where there is a forecast. Four of the five are about tomorrow, and a
    settled day cannot answer them; the observed state keeps the panels below,
    which are about the day that happened.
  */
  const questions =
    selectedRow === null ? null : (
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.md }}>
        <QuestionCard
          icon={
            <ZapIcon
              size={14}
              color={riskColor(colors, (riskRow ?? selectedRow).riskClass).fg}
            />
          }
          question={copy.app.grid.q1}
          answer={copy.app.risk[(riskRow ?? selectedRow).riskClass]}
          detail={fill(copy.app.grid.q1Detail, {
            probability: f.percent((riskRow ?? selectedRow).occurrenceProbability),
            subsystem: subsystemMeta((riskRow ?? selectedRow).subsystem).onsDisplayName,
          })}
          tone={riskColor(colors, (riskRow ?? selectedRow).riskClass).fg}
        />
        <QuestionCard
          icon={<PieChartIcon size={14} color={colors.violet} />}
          question={copy.app.grid.q2}
          answer={f.compact(magnitudeMwh ?? selectedRow.dailyEnergy.p50)}
          unit="MWh"
          detail={
            magnitudeBand === null
              ? copy.app.grid.q2DetailExpected
              : copy.app.grid.q2Detail
          }
          footnote={
            magnitudeBand === null
              ? undefined
              : `P10 ${f.compact(magnitudeBand.p10)} · P90 ${f.compact(
                  magnitudeBand.p90,
                )}`
          }
        />
        {/*
          The window keeps the Overview's own notation — `0h–5h BRT` — rather
          than a clock range. It is the form the rest of this screen uses and the
          one the operator brief was answered in; the card is a new place for the
          sentence, not a new way of saying it.
        */}
        <QuestionCard
          icon={<ClockIcon size={14} color={colors.info} />}
          question={copy.app.grid.q3}
          answer={
            window === null
              ? copy.app.grid.noWindow
              : fill(copy.app.overview.windowRange, {
                  from: String(window.fromHour),
                  to: String(window.toHour),
                })
          }
          detail={
            window === null ? copy.app.overview.windowNone : copy.app.grid.q3Detail
          }
          footnote={
            window === null
              ? undefined
              : fill(copy.app.overview.windowPeak, {
                  peak: String(window.peakHour),
                  mwh: f.compact(window.peakMwh),
                })
          }
        />
        <QuestionCard
          icon={<SearchIcon size={14} color={colors.inkMuted} />}
          question={copy.app.grid.q4}
          answer={
            spokenReasons.length === 0
              ? copy.app.grid.noReason
              : spokenReasons.map((entry) => entry.reason).join(" · ")
          }
          detail={
            spokenReasons.length === 0
              ? copy.app.grid.noReasonDetail
              : fill(copy.app.grid.q4Detail, {
                  date: f.date(observed.hoursDate),
                  share: spokenReasons
                    .map((entry) => f.percent(entry.share, 0))
                    .join(" · "),
                })
          }
        />
        <QuestionCard
          icon={<MapIcon size={14} color={colors.inkMuted} />}
          question={copy.app.grid.q5}
          answer={
            scope === "region"
              ? subsystemMeta(params.subsystem).onsDisplayName
              : atRisk.length === 1 && atRisk[0] !== undefined
                ? subsystemMeta(atRisk[0].subsystem).onsDisplayName
                : atRisk.map((row) => subsystemMeta(row.subsystem).short).join(" · ")
          }
          detail={
            scope === "region"
              ? copy.app.grid.q5DetailRegion
              : atRisk.length === 1
                ? copy.app.grid.q5Detail
                : fill(copy.app.grid.q5DetailMany, {
                    count: String(atRisk.length),
                    risk: copy.app.risk[leaderRow?.riskClass ?? "low"],
                  })
          }
        />

        {/*
          **The caveats travel with the answers.**

          Two sentences the panel these cards replaced was carrying, and neither
          is decoration. The first says the window is the longest *run* and not
          the count — a reader acting on `0h–5h` while nine other hours also
          qualify is acting on a third of the day. The second is the line this
          product cannot drop: the model forecasts how much will be curtailed and
          never why, so the reason beside it is ONS's record of a settled day and
          not a prediction of cause.

          Full width under the row rather than inside a card, because a card is
          168 px and these are sentences.
        */}
        <View style={{ flexBasis: "100%", gap: 4 }}>
          {window !== null && window.hoursInDay > window.toHour - window.fromHour + 1 ? (
            <Text style={{ ...type.caption, color: colors.inkFaint, lineHeight: 17 }}>
              {fill(copy.app.overview.windowScattered, {
                hours: String(window.hoursInDay),
              })}
            </Text>
          ) : null}
          {/*
            The ONS passage behind the reason, where the corpus has one. It is a
            link and not a quotation: the claim is that a rule exists and says
            this, and the reader follows it to the document rather than trusting
            a sentence lifted out of it.
          */}
          {observed.evidence === null ? null : (
            <Link
              href={observed.evidence.url as never}
              target="_blank"
              style={{
                ...type.caption,
                color: colors.accent,
                ...(Platform.OS === "web" ? ({ cursor: "pointer" } as object) : null),
              }}
            >
              {fill(
                observed.evidence.page === null
                  ? copy.app.overview.causeEvidenceNoPage
                  : copy.app.overview.causeEvidence,
                {
                  document: observed.evidence.documentCode,
                  revision: observed.evidence.revision ?? "",
                  page: String(observed.evidence.page ?? ""),
                },
              )}
            </Link>
          )}
          {observed.dominantReason === null ? null : (
            <Text style={{ ...type.caption, color: colors.inkFaint, lineHeight: 17 }}>
              {copy.app.overview.causeNote}
            </Text>
          )}
        </View>
      </View>
    );

  return (
    /*
      One `View`, and it measures itself. `wide` is read from this element's own
      width rather than the window's, so the rails move beside the map when
      *this column* has room — which is the thing that must not be squeezed.
    */
    <View
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      style={{ gap: space.xl }}
    >
      {questions}
      {nationalPanel}
      {/*
        **Three columns on the five cards' grid.**

        With `c` the width of one card and `g` the gap,

            W = 5c + 4g            (the card row)
            W = c + g + m + g + c  (the three columns)  ⟹  m = 3c + 2g

        so the map is worth exactly three cards and the two gaps between them,
        and each rail is worth one. Expressed in flex: every column gets
        `flexBasis: 0` and a grow of 1 : 3 : 1, *except* that the map also takes
        a basis of two gaps — otherwise this row's own two gaps come out of the
        shared free space and the rails end up wider than a card.

        The gap is `space.md` and not `space.xl` because the arithmetic only
        closes when both rows use the same one. That is the cost of the
        alignment, and it is worth it: the card edges and the column edges are
        the strongest lines on the screen, and a few pixels of disagreement
        between them is the kind of thing a reader feels without seeing.
      */}
      <View
        style={{
          flexDirection: wide ? "row" : "column",
          alignItems: "stretch",
          gap: space.md,
        }}
      >
        {/*
        Left rail, then map, then right rail on a wide screen; map first when
        stacked. The map leads on a phone because it is the thing that makes
        the rest legible — a list of four numbers with no map above it is the
        Overview's rows without the Overview's map.
      */}
        {wide ? (
          <View
            style={{
              flexGrow: 1,
              flexShrink: 1,
              flexBasis: 0,
              minWidth: 0,
              gap: space.md,
            }}
          >
            {headline}
            {profile}
          </View>
        ) : null}

        <View
          style={{
            flexGrow: 3,
            flexShrink: 1,
            flexBasis: wide ? space.md * 2 : "auto",
            minWidth: 0,
            gap: space.lg,
          }}
        >
          <Panel style={{ gap: space.md, alignItems: "stretch" }}>
            {/*
              The same map the console draws, with the same scope pills and the
              same 2D/3D switch. It used to be a bare `SubsystemMap` here and a
              hand-wired globe there, which is how two screens of one product end
              up with two maps that behave differently. See `region-map.tsx`.

              It opens flat: the globe costs an ion account and a 22 MB payload,
              and this screen is a document with a map in it rather than a scene.
            */}
            <RegionMap
              paint={paint}
              scope={scope}
              onScope={setScope}
              selected={params.subsystem}
              hovered={hovered}
              onHoverChange={setHovered}
              onSelect={(code) => {
                params.setParams({ subsystem: code });
                setScope("region");
              }}
              run={params.run}
              runInert={runInert}
              onRun={(run) => params.setParams({ run })}
              defaultLayer="2d"
              // The point of the layout: a map with room to be looked at. 380 is
              // what it takes in a column beside four panels; here it is the
              // subject rather than a figure.
              flatMaxWidth={wide ? 760 : 440}
              minHeight={wide ? 520 : 380}
            />
            {/*
              The selection, named under the map that changes it. `/app` puts it
              in the same place and for the reason its own docstring gives: the
              selection moves from four places, and this is the element that
              speaks the new one to a screen reader.
            */}
            <SelectedRegion
              subsystem={params.subsystem}
              row={selectedRow}
              observed={
                forecast === null
                  ? (observedRows(observed.now.subsystems, SUBSYSTEM_DISPLAY_ORDER).find(
                      (row) => row.subsystem === params.subsystem,
                    ) ?? null)
                  : null
              }
              observedWindow={window24h}
              onExplain={() => onExplain(params.subsystem)}
            />
          </Panel>
          {wide ? null : headline}
          {wide ? null : rail}
          {wide ? null : profile}
        </View>

        {wide ? (
          <View style={{ flexGrow: 1, flexShrink: 1, flexBasis: 0, minWidth: 0 }}>
            {rail}
          </View>
        ) : null}
      </View>

      {/*
        The fan, full width and below the block, because it is an hourly series
        and an hourly series in a 300px rail is a smear. Absent rather than
        empty where nothing was published — the rule every other forecast panel
        follows.
      */}
      {forecast === null ? null : (
        <Panel style={{ gap: space.md }}>
          <Text style={{ ...type.caption, color: colors.inkFaint }}>
            {`${meta.onsDisplayName} · ${copy.app.overview.profileSubtitle}`}
          </Text>
          <FanChart
            hours={forecastHours(forecast.forecast)}
            thresholdMw={forecast.forecast.thresholdMw}
          />
        </Panel>
      )}
    </View>
  );
}
