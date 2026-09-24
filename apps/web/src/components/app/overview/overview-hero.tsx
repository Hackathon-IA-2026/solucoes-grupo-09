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

import { latestTargetDate } from "@wattsteer/core";
import {
  ArrowRightIcon,
  Panel,
  PillButton,
  radius,
  space,
  type,
  usePalette,
} from "@wattsteer/ui";
import { useState } from "react";
import { Text, View } from "react-native";
import { PanelTitle } from "@/components/app/figures/rail-panels";
import { useCoverage } from "@/components/app/figures/use-coverage";
import { useLadder } from "@/components/app/figures/use-ladder";
import { RegionMap } from "@/components/app/map/region-map";
import type { Scope } from "@/components/app/map/scope-bar";
import { EpisodesPanel } from "@/components/app/overview/settled-panels";
import type { AppParams } from "@/components/app/params";
import { SelectedRegion } from "@/components/app/selected-region";
import { gateProfileOf } from "@/components/app/use-app-params";
import { useGridContext } from "@/components/app/use-grid-context";
import type { ForecastNetwork, ObservedNetwork } from "@/components/app/use-network";
import { useRunLanes } from "@/components/app/use-run-lanes";
import { BandCard } from "@/components/charts/band-figure";
import { FanChart } from "@/components/charts/fan-chart";
import {
  ObservedCard,
  ObservedEmptyCard,
  ObservedProfile,
} from "@/components/charts/observed-profile";
import { useCopy, useFormat } from "@/i18n";
import { fill } from "@/i18n/format";
import {
  SUBSYSTEM_DISPLAY_ORDER,
  type SubsystemCode,
  subsystemMeta,
} from "@/lib/fixtures";
import { forecastHours, observedRows } from "@/lib/network";
import { HeadlinePanel } from "./headline-panel";
import { heroFigures } from "./hero-figures";
import { ObservedNationalPanel } from "./national-panel";
import { PlanVsActualPanel } from "./plan-vs-actual-panel";
import { QuestionRow, SettledQuestionRow } from "./question-row";
import { RailSummary } from "./rail-summary";
import { RegionRail } from "./region-rail-panel";
import { RiskLegend } from "./risk-legend";
import { SettledPanels } from "./settled-panels";

/**
 * The width at which the rails move beside the map rather than under it.
 *
 * Measured on the content column rather than the window: the shell centres its
 * page, so a window query would put rails beside a map on a 1200px viewport
 * whose column is 1160 and not on a 1100px one whose column is the same. The
 * map is the thing that must not be squeezed.
 */
const RAILS_BESIDE_MAP = 980;

/**
 * Where the 24-hour profile fits *over* the map instead of under it.
 *
 * The flat map is capped at `flatMaxWidth` and centred in its column, so a
 * narrower column moves the drawing left rather than shrinking it — and the
 * card sits in the bottom-left corner, which is where Sul ends up. Measured at
 * 1280, the suite's desktop width: the map draws about 530 px from x≈300, Sul
 * spans 521–650, and a 300 px card spans 300–600. They overlap by 79 px across
 * the region's whole head, and `app-overview-selection.spec.ts` reports it as
 * "subtree intercepts pointer events" on the press that selects it.
 *
 * Narrowing the card does not fix it — 340 and 300 both collide — because the
 * map shrinks with the column while the card does not. So the overlay is a
 * *wide* arrangement, and below this the fan is the full-width panel under the
 * block, which is exactly where it lives on a phone and for the same reason.
 * The two branches are exclusive by construction.
 */
const FAN_OVER_MAP = 1400;

export function OverviewHero({
  observed,
  forecast,
  scope,
  onScope,
  params,
  onExplain,
  onWhy,
  whyOpen,
  onWhatToDo,
}: {
  observed: ObservedNetwork;
  forecast: ForecastNetwork | null;
  /** Whether the map is narrowed to the selection, owned by the screen. */
  scope: Scope;
  onScope: (scope: Scope) => void;
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
  /**
   * The "Por quê?" card's toggle, which raises Explicar over the page.
   *
   * A second way into the same section as `onExplain`, and deliberately not a
   * replacement for it: `onExplain` names a region and travels down the page to
   * a heading, which is what a control labelled "Explicar NORDESTE" promises.
   * This one stays where the reader is.
   */
  onWhy?: () => void;
  whyOpen?: boolean;
  /**
   * Raises Mitigar over the page from the strip under the map — the same
   * container decision `onWhy` makes for Explicar, passed straight through to
   * `SelectedRegion`, which is where the control is.
   */
  onWhatToDo?: () => void;
  /** The live selection, with its writer — the map and the rail set it. */
  params: AppParams & {
    setParams: (next: Partial<AppParams>) => void;
  };
}) {
  const colors = usePalette();
  const copy = useCopy();
  const f = useFormat();
  const text = copy.app.grid.hero;
  const [hovered, setHovered] = useState<SubsystemCode | null>(null);
  /*
    **The scope moved up to the screen, and it used to live here.**

    It says whether the map is narrowed to the selected region or showing the
    whole grid, and for as long as only this component read it, local state was
    right. The episode list at the bottom of the page follows the same filter
    now — it is the map's filter, and every other figure on the screen obeys it
    — so the one fact has one owner, in `app/index.tsx`, rather than a second
    copy down there that could disagree with the pills.

    The deep-link initialisation went with it, and had to change shape on the
    way: it read `params.subsystemFromUrl`, a value `use-app-params.ts`
    deliberately withholds on the first client render, and got away with it only
    because this component mounts after the gateway has answered. The screen
    mounts immediately, so up there it is an effect that corrects once — which
    is what the note here always said it would have to become.
  */
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
  /*
    The measured gain over the baseline an operator would use without the model.
    Same card as the coverage above — read once, see `use-model-card.ts`.
  */
  const ladder = useLadder(gateProfileOf(params.run));
  /*
    Keyed on the selection, like every other read on this screen: the programme
    and the settlement are both per subsystem-day, so changing either axis is a
    different question and not a filter over one answer.
  */
  const gridContext = useGridContext(params.subsystem, params.date);
  const [width, setWidth] = useState(0);
  const wide = width >= RAILS_BESIDE_MAP;
  /* Whether the fan can sit on the map without covering a region. */
  const fanOverMap = width >= FAN_OVER_MAP;

  const meta = subsystemMeta(observed.subsystem as SubsystemCode);
  /*
    Everything this screen computes, in one named calculation.

    It was a dozen derivations inline here, each forking on whether a forecast
    was published and on which scope the map is in — which is what took this
    component to 82 on Biome's complexity rule and kept it at 37 after three
    panels had been split out. The panels were never the problem. See
    `hero-figures.tsx`.
  */
  const {
    day,
    paint,
    regions,
    largest,
    selectedRow,
    leaderRow,
    atRisk,
    magnitudeMwh,
    magnitudeBand,
    riskRow,
    spokenReasons,
    window,
    worstRisk,
    settled,
  } = heroFigures({ observed, forecast, scope, f });

  /*
    ONS's plan for the day against what the grid did. The one panel here whose
    two series are both ONS's — see `plan-vs-actual-panel.tsx` for why that is
    worth a panel of its own, and `use-grid-context.ts` for why an empty answer
    is the ordinary case rather than a refusal.
  */
  const planned = <PlanVsActualPanel state={gridContext} subsystem={params.subsystem} />;

  const headline = (
    <HeadlinePanel
      scope={scope}
      selectedRow={selectedRow}
      outlook={forecast?.outlook ?? null}
      observedTotalMwh={day.totalMwh}
      coverage={coverage}
      ladder={ladder}
      text={text}
    />
  );

  /*
    The settled day's hours, and the **only** copy of them on the page.

    This chart was drawn twice: here, and again at the bottom as
    `SettledDayPanel` — the same `<ObservedProfile hours={observed.hours} />`
    under a different heading, in both the forecast and the observed stacks. The
    bottom one was the honest version and this one was the visible one, so the
    two were merged rather than one being deleted: this keeps the position, and
    takes the furniture that made the other one safe to read.

    Which furniture, and why each piece:

    - **The observed badge.** This panel sits in a column headed by tomorrow's
      forecast. `honesty.md` asks every observed figure to say it is settled,
      and a chart that does not is one a reader may take for a prediction.
    - **The date.** "Hora a hora" of *which* day? These bars are a past day's,
      beside a forecast for the next one, and the answer was on the panel that
      went.
    - **The zero note.** A missing bar is an hour ONS has not settled, not an
      hour that settled at zero. That is `honesty.md`'s "an absence is a claim"
      at hour grain, and nothing else on this screen says it.

    Labelled from `observed.subsystem` rather than from the selection: during a
    re-read this panel still shows the previous subsystem's figures, so it has
    to say the previous subsystem's name. That reasoning is `SettledDayPanel`'s
    own, kept with the thing it was about.
  */
  const profile = (
    <Panel style={{ gap: space.md }}>
      {/*
        `PanelTitle`, not `PanelHeader`, and no icon.

        This card sits directly under `headline`, in the same column and at the
        same width, and that card heads itself with `PanelTitle` — `type.label`
        over `type.caption`. `PanelHeader` is the wider vocabulary: an icon, a
        larger title, room for a badge on the right. Two cards a gap apart
        wearing two different heading scales reads as two kinds of card, and
        these are the same kind.

        No badge either. The subtitle already says *observado* beside the date,
        and a card naming its own claim twice in one header stops reading as a
        claim — the same argument that took the badge out of the settled
        split's total.
      */}
      <PanelTitle
        title={text.profileLabel}
        note={fill(copy.app.overview.settledDaySubtitle, {
          date: f.date(observed.hoursDate),
        })}
      />
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
      <Text style={{ fontSize: 11, lineHeight: 18, color: colors.inkFaint }}>
        {copy.app.overview.settledDayNote}
      </Text>
      {settled === null ? null : (
        // Only where there is no forecast, which is what `bandAbsent` meant on
        // the panel this replaced. It answers a question the observed state
        // provokes and the forecast state does not: why these bars carry no
        // P10–P90. Printing it beside a published band would be answering a
        // question nobody asked.
        <Text style={{ fontSize: 11, lineHeight: 18, color: colors.inkFaint }}>
          {copy.app.observed.noFan}
        </Text>
      )}
    </Panel>
  );

  /*
    The window the observed rows cover, named. Every panel that draws
    `last_24h_*` states it, because the settled day beside it is a different
    window and two honest numbers with no window on either read as a
    contradiction.
  */
  /*
    **The settled day's two figures, in the column the day already occupies.**

    They were at the bottom of the observed stack, a page below the map, beside
    the episode list. Both are about the *selected region's settled day* — the
    same day `profile` draws hour by hour directly above them — so the column
    that already holds the headline and the profile is where they belong, and a
    reader comparing the total with the shape it came from no longer scrolls
    between them.

    Only where there is no forecast. With one on the screen this slot holds
    `forecastFigures` instead — the same two questions in the forecast
    vocabulary, as bands — and two cards a few hundred pixels apart saying "the
    day" in the two vocabularies at once is the adjacency `lib/network.ts`
    refuses; see `honesty.md`.

    `peakHour === null` is the day that settled with no curtailment in it, which
    is a different sentence from a zero and gets a different card.
  */
  const windowDay = fill(copy.app.observed.windowDay, {
    date: f.date(observed.hoursDate),
  });
  /*
    **The pair is two variables rather than one fragment, since 24/09.**

    They are still the same two questions in the same vocabulary and they are
    still mutually exclusive with the forecast pair. What changed is that the
    wide layout puts them in *different columns* — the energy under the map with
    the plan, the peak under the four rows it is the peak of — so a fragment
    holding both could not be placed. See the grid below for the measurement
    that asked for it.
  */
  const dayEnergyFigure =
    forecast === null ? (
      day.peakHour === null ? (
        <ObservedEmptyCard
          label={fill(copy.app.observed.dayTotal, { subsystem: meta.onsDisplayName })}
        />
      ) : (
        <ObservedCard
          label={fill(copy.app.observed.dayTotal, { subsystem: meta.onsDisplayName })}
          value={day.totalMwh}
          unit="MWh"
          window={windowDay}
          footnote={copy.app.observed.dayTotalNote}
        />
      )
    ) : null;

  const dayPeakFigure =
    forecast === null ? (
      day.peakHour === null ? (
        <ObservedEmptyCard
          label={fill(copy.app.observed.peakHour, { subsystem: meta.onsDisplayName })}
        />
      ) : (
        <ObservedCard
          label={fill(copy.app.observed.peakHour, { subsystem: meta.onsDisplayName })}
          value={day.peakHour.constrainedOffMwh}
          unit="MWh"
          window={fill(copy.app.observed.peakHourWindow, {
            hour: f.number(day.peakHour.hourLocal),
            date: f.date(observed.hoursDate),
          })}
          footnote={copy.app.observed.peakHourNote}
        />
      )
    ) : null;

  /*
    **The forecast day's two figures, in the same slot the settled pair takes.**

    They were the last thing on the page, two `BandCard`s at the bottom of
    `ForecastPanels`, a full scroll below the map that names the region they
    are about. The settled pair had already moved up under the profile for that
    reason; leaving these where they were would have meant the same claim
    living in two places depending on whether a model happened to be promoted,
    which teaches a reader that the position of a number means nothing.

    Gated on `selectedRow` rather than on `forecast` alone because both are
    needed — the band comes from the selected row and the peak's footnote from
    the run's threshold — and because `selectedRow` is `null` exactly when
    `forecast` is, so this pair and `dayFigures` above are mutually exclusive by
    construction. Never both: a P10-P90 and a settled megawatt-hour a few
    hundred pixels apart, both labelled "the day", is the adjacency
    `lib/network.ts` keeps its two row types apart to prevent — see
    `honesty.md` on the two vocabularies.
  */
  const forecastEnergyFigure =
    forecast === null || selectedRow === null ? null : (
      <BandCard
        label={fill(copy.app.overview.dailyEnergy, {
          subsystem: meta.onsDisplayName,
        })}
        band={selectedRow.dailyEnergy}
        unit="MWh"
        footnote={copy.app.overview.dailyEnergyNote}
      />
    );

  const forecastPeakFigure =
    forecast === null || selectedRow === null ? null : (
      <BandCard
        label={fill(copy.app.overview.peakPower, {
          subsystem: meta.onsDisplayName,
        })}
        band={selectedRow.peakPower}
        unit="MW"
        tone="violet"
        footnote={fill(copy.app.overview.peakPowerNote, {
          mw: f.number(forecast.forecast.thresholdMw),
        })}
      />
    );

  /*
    The day's energy and the day's peak, whichever vocabulary answers them.
    Exactly one of each pair is ever non-null — `selectedRow` is `null` exactly
    when `forecast` is — so these two carry the question rather than the state,
    and the layout below places a *question* rather than a branch.
  */
  const energyFigure = dayEnergyFigure ?? forecastEnergyFigure;
  const peakFigure = dayPeakFigure ?? forecastPeakFigure;

  const window24h = fill(copy.app.observed.window24h, {
    date: f.date(observed.day.date),
  });

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
  const nationalPanel = (
    <ObservedNationalPanel national={observed.day.national} window={window24h} />
  );

  /*
    **The settled four, drawn here rather than at the foot of the page.**

    `app/index.tsx` rendered `SettledPanels` after `ForecastPanels` — a whole
    screen below the map that names the regions it is about — and it is the
    observed half of the four the rail forecasts. It belongs where a reader can
    put the two side by side, which is the band under this block.

    `null` in the settled state, where `ObservedPanels` already draws these
    rows: that is the same condition `index.tsx` was applying by rendering this
    only in the forecast branch.
  */
  const settledFour =
    forecast === null ? null : (
      <SettledPanels
        observed={observed}
        subsystem={params.subsystem}
        onSelect={(code) => params.setParams({ subsystem: code })}
      />
    );

  /*
    The four subsystems beside the map, in their own component. Same split as
    the two panels above it; see `region-rail-panel.tsx`.
  */
  const rail = (
    <RegionRail
      regions={regions}
      largest={largest}
      selected={params.subsystem}
      hovered={hovered}
      onSelect={(code) => params.setParams({ subsystem: code })}
      onHoverChange={setHovered}
      emphasis={params.technology}
      text={{
        regionsLabel: text.regionsLabel,
        windowLabel: forecast === null ? text.windowObserved : text.windowForecast,
      }}
      /*
        The sum, under its four parts, and only where the four are a forecast.
        In the settled state the same addition is the observed national panel's,
        with its own window — rendering both would put one total on the page
        twice under two windows, which is the contradiction the rail's own
        window sentence exists to stop.
      */
      summary={
        forecast === null || magnitudeMwh === null ? undefined : (
          <RailSummary totalMwh={magnitudeMwh} band={magnitudeBand} riskRow={riskRow} />
        )
      }
    />
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
  /*
    The five cards, in their own component. The branching inside them — every
    field switching on the scope, the risk row and how many reasons the day had
    — had taken this function to a cognitive complexity of 82. It has a name and
    a boundary now; see `question-row.tsx`.
  */
  /*
    **The row answers in both states, and it used to answer in one.**

    It was gated on `selectedRow`, so every day before its gate struck — which
    is every evening, and fifteen hours out of twenty-four on production — the
    five cards vanished and the screen lost the thing it is laid out around.
    The comment that stood here said four of the five are about tomorrow. That
    was wrong about three of them: how much was curtailed, in which hour and
    where are measurements, and this page already draws all three in the panels
    below. `settled` is the same five answers in the observed vocabulary.
  */
  const questions =
    settled === null ? (
      selectedRow === null || magnitudeMwh === null ? null : (
        <QuestionRow
          scope={scope}
          selectedSubsystem={params.subsystem}
          risk={riskRow ?? selectedRow}
          magnitudeMwh={magnitudeMwh}
          magnitudeBand={magnitudeBand}
          window={window}
          reasons={spokenReasons}
          reasonDate={observed.hoursDate}
          evidence={observed.evidence}
          atRisk={atRisk}
          worstRisk={worstRisk}
          causeNote={copy.app.overview.causeNote}
          onWhy={onWhy}
          whyOpen={whyOpen}
        />
      )
    ) : (
      <SettledQuestionRow
        settled={settled}
        reasons={spokenReasons}
        reasonDate={observed.hoursDate}
        evidence={observed.evidence}
        causeNote={copy.app.overview.causeNote}
        onWhy={onWhy}
        whyOpen={whyOpen}
      />
    );

  return (
    /*
      One `View`, and it measures itself. `wide` is read from this element's own
      width rather than the window's, so the rails move beside the map when
      *this column* has room — which is the thing that must not be squeezed.
    */
    <View
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      /*
        `space.md`, matching the gap between the three columns below. It was
        `space.xl`: 24 px above and below the card row while the grid it sits on
        is 12 apart, which read as the cards belonging to a different page from
        the panels they summarise.
      */
      style={{ gap: space.md }}
    >
      {questions}
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

        **The right rail is worth one and a half since the summary moved in.**
        `region-rail.tsx` records what one card cost it in measurements: at
        234 px of row the name used 105 and the chip could not fit beside the
        figure; at 206 px `NORDESTE` and `SUDESTE/CENTRO-OESTE` both rendered
        as three letters and an ellipsis, two of four regions reading
        identically. The rail now carries a thumbnail, the reading, an interval
        and two fleet figures, and a column sized for a caption cannot hold
        them. The map gives up the half card: it is 2.5 : 1 against the rail
        rather than 3 : 1, which at 1440 is about 40 px off a map that had
        560 to spend.

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
            {/*
              **The settled national total leads this column.**

              It was third, under the profile, on the argument that a total
              should follow the hours it is the sum of. It is first now: this
              is the one figure on the screen that is *measured* rather than
              modelled, and a column that opens with it says what the grid did
              before it says what we expect. The forecast sum still sits with
              the four rows it adds up, on the other side of the map, so each
              total is still beside its own parts.
            */}
            {nationalPanel}
            {headline}
            {profile}
          </View>
        ) : null}

        <View
          style={{
            flexGrow: 2.5,
            flexShrink: 1,
            flexBasis: wide ? space.md * 2 : "auto",
            minWidth: 0,
            /*
              `space.md`, like every other gap in this hero. It was `space.lg`,
              which is only visible where this column's children stack against
              something else's: the question cards sit 12 apart and the whole
              column under them sat 16, and on a phone — where the rails fall
              into this column too — that 16 ran the length of the screen under
              a 12. One gap, or the card edges and the column edges stop
              agreeing, which is what the comment above this grid is about.
            */
            gap: space.md,
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
              onScope={onScope}
              selected={params.subsystem}
              hovered={hovered}
              onHoverChange={setHovered}
              onSelect={(code) => {
                params.setParams({ subsystem: code });
                onScope("region");
              }}
              run={params.run}
              runInert={runInert}
              onRun={(run) => params.setParams({ run })}
              /*
                The day, and the whole screen follows it: the forecast half
                already took `targetDate`, and `GET /v1/grid/day` gave the
                observed half the same axis, so there is no panel left that
                reads a window the reader did not choose.

                `latestTargetDate` is the ceiling rather than a constant —
                `params.ts` uses the same function for the default, so the two
                cannot drift into a control that offers a day the screen would
                not open on.
              */
              date={params.date}
              latestDate={latestTargetDate(new Date())}
              onDate={(date) => params.setParams({ date })}
              /*
                The colour key, top-right. The four regions are painted by risk
                class and nothing on this screen said which red meant what — a
                choropleth with no key is a picture rather than a reading. Only
                where the paint is a forecast: in the settled state the regions
                carry measured energy, and a *risk* key over them would name a
                classification that is not what is drawn.
              */
              legend={forecast === null ? undefined : <RiskLegend />}
              defaultLayer="2d"
              // The point of the layout: a map with room to be looked at. 380 is
              // what it takes in a column beside four panels; here it is the
              // subject rather than a figure.
              flatMaxWidth={wide ? 560 : 440}
              minHeight={wide ? 520 : 380}
              /*
                The 24-hour profile, in the map's free corner.

                **Only where it fits.** At `wide` the card has 520px of map to
                sit over and the fan gets 340 of the card's width; below that
                the map is 380 tall in a column barely wider than the card
                would be, so the overlay would *be* the map. The narrow layout
                keeps the full-width panel underneath, which is where this
                lived for both until now.

                The width is the known cost, stated where it is paid: the panel
                below gives the same 24 hours the whole page, and the comment
                on it calls an hourly series in a 300px rail a smear. This is
                that trade, taken deliberately — the fan here is the map's
                caption, and the reader who wants to read an hour still taps it.

                340 rather than 300 because width is what buys height here: the
                fan is drawn at its viewBox's aspect, so 324px of card interior
                is 132px of chart. Asking for the height instead — this passed
                `height={150}` — letterboxed it to 164px wide inside 284, with
                ~60px dead on either side.
              */
              /*
                **The two controls, in the corner, and the card they came from
                is gone.**

                `SelectedRegion` sat under the map and said four things: which
                region is selected, its risk chip, the expected energy with its
                P10–P90, and a paragraph explaining that the panels below are
                about it. Three of those four are already on the screen — the
                rail names the region and carries the chip, and the five
                question cards above state the expectation and the interval —
                so what the card uniquely had was the two buttons.

                They move onto the map, which is the thing they act on. The
                wrapper keeps `testID="selected-region"` and the live region:
                the selection changes from four places, and this is still the
                one element that speaks the new one to a screen reader. Losing
                that with the card would have been an accessibility regression
                nobody asked for.

                A row of two pills rather than a card, because the corner is
                over Sul: the fan's own comment records a 340px card at this
                corner eating the click that selects that region, caught by
                `app-overview-selection.spec.ts` as "subtree intercepts pointer
                events". `box-none` on the slot means only the pills themselves
                take a press, and two pills are a fraction of what a card was.

                **In both states, and the first cut gated this on a forecast
                existing.** That gate was written after
                `app-overview-selection.spec.ts` caught the observed state
                losing "Nenhum número de previsão", and the conclusion drawn
                from it was wrong: the card's three claims are all on the
                screen already. The rail beside the map prints each region's
                settled figure with its `eólica X · solar Y` split and heads
                the four with "Últimas 24 h liquidadas, por subsistema" — that
                is the figure, the split and the window. And the absence is
                `ForecastAbsent`'s, at page level, under "Sem previsão para
                este dia", where it is one claim about the day rather than one
                per selected region.

                What the card had that nothing else does is the two controls.
                In the forecast state the expectation and its P10–P90 are on
                two of the five question cards above; in the observed state
                there is no expectation to state at all.
              */
              controls={
                wide ? (
                  <View
                    testID="selected-region"
                    accessibilityLiveRegion="polite"
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      gap: space.sm,
                    }}
                  >
                    {/*
                      **The name is the button's, and the pill beside it is
                      gone.**

                      It was a second copy of the same word a centimetre from
                      "Explicar NORDESTE", which is the redundancy `copy.md`
                      calls a caveat read once and then never again — except
                      this one was a *label*, so it read as two controls where
                      there is one thing selected.

                      The two properties it carried are kept rather than
                      dropped. The live region still announces the change,
                      because the button's own label changes with the selection
                      and the wrapper above is what speaks; and
                      `selected-region-name` moves onto this wrapper, whose text
                      is `Explicar NORDESTE` — which is what the nine
                      assertions reading it actually check, an unanchored
                      `/NORDESTE/` against the element that names the selection.
                    */}
                    <View testID="selected-region-name">
                      <PillButton
                        testID="selected-region-explain"
                        label={fill(copy.app.overview.rowExplainLabel, {
                          subsystem: meta.onsDisplayName,
                        })}
                        onPress={() => onExplain(params.subsystem)}
                        primary={true}
                        icon={<ArrowRightIcon size={16} color={colors.onAccent} />}
                      />
                    </View>
                    {onWhatToDo === undefined ? null : (
                      <PillButton
                        testID="selected-region-mitigate"
                        label={copy.app.overview.selectedMitigateLabel}
                        onPress={onWhatToDo}
                      />
                    )}
                  </View>
                ) : undefined
              }
              overlay={
                fanOverMap && forecast !== null ? (
                  <View
                    /*
                      Pressable again, in the corner that leaves the map alone.

                      This was `pointerEvents="none"` for one evening, because
                      at bottom-**right** the card sat over Sul and ate the
                      click that selects it — `app-overview-selection.spec.ts`
                      caught it as "subtree intercepts pointer events", and
                      giving the chart's gesture up was the quick way to give
                      the map its clicks back. It also took away the hour
                      readout, which is the thing the card is *for*.

                      Bottom-left costs nothing: measured at the 1280 viewport
                      the suite uses, the right corner overlapped Sul by 64px
                      across its centre, and this corner is over the map's
                      empty south-west. So the chart keeps its press strip and
                      the map keeps every region — the trade was a position,
                      not a feature.
                    */
                    style={{
                      /*
                        **300, and it was 340 until the rail took half a card.**

                        The flat map is capped at `flatMaxWidth` and centred in
                        its column, so narrowing the column moves the drawing
                        *left* rather than shrinking it. Measured at the 1280
                        the suite runs: the column went 725 → 604, the map
                        stayed 560, and its left inset went 82 → 22 — which
                        slid Sul from about 418 px to 358 px, onto a card whose
                        right edge was 352. `app-overview-selection.spec.ts`
                        caught it exactly as this corner's comment predicts:
                        "subtree intercepts pointer events", 56 retries, on the
                        press that selects that region.

                        So the card gives back the 40 px rather than the map
                        giving back the width. The cost is the one this file
                        already names — the fan is drawn at its viewBox's
                        aspect, so 40 px of width is about 16 px of height —
                        and it is the cheaper side of the trade: a chart a
                        little shorter against a region that cannot be clicked.
                      */
                      width: 300,
                      gap: 4,
                      padding: space.sm,
                      borderRadius: radius.lg,
                      borderCurve: "continuous",
                      borderWidth: 1,
                      borderColor: colors.border,
                      // Translucent over both layers: the flat map is on the
                      // page's surface and the globe is near-black, so a solid
                      // fill would be wrong against one of them.
                      backgroundColor: colors.surface,
                      opacity: 0.96,
                    }}
                  >
                    <Text style={{ ...type.caption, color: colors.inkFaint }}>
                      {`${meta.onsDisplayName} · ${copy.app.overview.profileSubtitle}`}
                    </Text>
                    <FanChart
                      hours={forecastHours(forecast.forecast)}
                      thresholdMw={forecast.forecast.thresholdMw}
                    />
                  </View>
                ) : undefined
              }
            />
          </Panel>
          {/*
            **The strip is the narrow layout's, and nothing else's.**

            Two pills laid over a 320px map would cover most of a region and
            eat the press that selects it — the failure the fan chart's comment
            above records from this very corner — so the phone keeps the card,
            where there is room under the map for it.

            It is the only case. `e2e/app-overview-selection.spec.ts` asserts
            exactly one `selected-region` in the DOM in either state, which is
            what stops these two becoming both.
          */}
          {wide ? null : (
            <SelectedRegion
              subsystem={params.subsystem}
              row={selectedRow}
              observed={
                forecast === null
                  ? (observedRows(observed.day.subsystems, SUBSYSTEM_DISPLAY_ORDER).find(
                      (row) => row.subsystem === params.subsystem,
                    ) ?? null)
                  : null
              }
              observedWindow={window24h}
              onExplain={() => onExplain(params.subsystem)}
              onWhatToDo={onWhatToDo}
            />
          )}
          {/*
            **Plan against outcome sits in the centre column, under the map.**

            The three columns are an alert, a context and a decision — the left
            rail is what *we* forecast, the right is the four regions, and the
            middle is what the grid is. ONS's programme against ONS's
            settlement is the most context-shaped thing on the screen: it is the
            only panel where neither series is ours, and it is about the same
            day the map is painted for. It sat in the right rail, beside the
            regions, where it read as a fourth region.
          */}
          {/*
            **Under the map, at the map's width.**

            The three columns stretch to the tallest and the map's ended 465 px
            short of it: measured on production at 1246, the map column closed
            at y≈890 against a rail at 1265 and a left column at 1355, so the
            middle of the page was a white block with content down both sides.

            The plan is the panel that belongs there on its own terms — the one
            panel whose two series are both ONS's, about the same day the map is
            painted for, and a table that wants the map's width rather than a
            third of it. The day's energy follows it because it is about that
            day too; the day's *peak* goes to the rail instead, and the comment
            there says why.
          */}
          {planned}
          {wide ? energyFigure : null}
          {/*
            **And the episodes under it, at the same width.**

            The two panels are the same kind of claim at two spans: what ONS
            planned against what it settled for this day, and the runs of hours
            the last fortnight actually formed. Both are the centre column's
            full width because both are tables a reader scans across, which is
            the thing a half-width column takes away.
          */}
          {wide ? null : (
            <EpisodesPanel
              observed={observed}
              scope={scope}
              subsystem={params.subsystem}
            />
          )}
          {wide ? null : headline}
          {wide ? null : nationalPanel}
          {wide ? null : rail}
          {wide ? null : profile}
          {/*
            The day's two figures follow the profile on a phone exactly as they
            follow it in the left column, because they are about the day that
            chart draws. Leaving them out of this branch dropped them off the
            screen entirely at 390px — `app-observed-overview.spec.ts` caught it
            on the run, looking for "Energia cortada liquidada, dia inteiro".

            Both pairs, for the same reason and with the same exclusivity: the
            forecast state's two bands would otherwise be on the wide layout and
            nowhere else, and `app-overview-selection.spec.ts` looks for
            "Energia cortada, dia inteiro" on the rendered page.
          */}
          {wide ? null : energyFigure}
          {wide ? null : peakFigure}
          {/*
            The settled four, on a phone. They are in the foot band on a wide
            screen and were at the foot of the page before that; leaving them
            out of this branch dropped them off the narrow screen entirely,
            which `app-observed-overview.spec.ts` caught on the run looking for
            "Liquidado nos quatro subsistemas".
          */}
          {wide ? null : settledFour}
        </View>

        {wide ? (
          <View
            style={{
              // One and a half cards — see the arithmetic above.
              flexGrow: 1.5,
              flexShrink: 1,
              flexBasis: 0,
              minWidth: 0,
              gap: space.md,
            }}
          >
            {/*
              **The national total sits on top of the four it is the sum of.**

              It was a full-width band across the page, above the three columns,
              carrying one number and a paragraph. That is the widest element on
              the screen spent on a figure that is *literally the rail below it,
              added up*: `NationalNow.derived` is `sum_of_four`, the rail's four
              rows are the same `last24hConstrainedOffMwh` per subsystem over
              the same window, and 1.940 + 181,3k + 43,6k + 1.808 is the 228,6k
              it printed.

              So it goes where its parts are. A reader can now check the
              addition by looking down, which is the strongest thing this panel
              can say about itself — and the page gets its full width back for
              the three columns that actually need it.
            */}
            {rail}
            {/*
              **The day's peak, under the four rows it is the peak of.**

              The energy figure went under the map with the plan and this one
              did not follow it, because putting both there made the map column
              the tallest instead of the shortest — 1500 px against a rail at
              1170, which is the same void moved rather than closed. Splitting
              the pair puts each card in the column it argues with and leaves
              the three within about a card of each other.
            */}
            {peakFigure}
          </View>
        ) : null}
      </View>

      {/*
        **The three tables, across the foot of the block.**

        The same kind of thing at three spans, and they were stacked one under
        another in the centre column: the runs of hours the fortnight formed,
        ONS's programme against ONS's settlement for this day, and the four
        subsystems as ONS has settled them. Each is a table a reader scans
        *across*, so stacking them spent the page's height on the axis none of
        them needed — and the third was at the foot of the whole page, a scroll
        past everything, where it was a section nobody reached.

        `wide` only, and the stack above keeps them below that: a five-column
        table is already at its limit in the centre column at 900 px, and three
        side by side there would be three smears. The two branches are
        exclusive by construction.
      */}
      {wide ? (
        <View style={{ flexDirection: "row", alignItems: "stretch", gap: space.md }}>
          <View style={{ flexGrow: 1, flexShrink: 1, flexBasis: 0, minWidth: 0 }}>
            <EpisodesPanel
              observed={observed}
              scope={scope}
              subsystem={params.subsystem}
            />
          </View>

          {/*
            The settled four. Absent in the settled state rather than drawn
            twice: `ObservedPanels` already carries these rows there, and this
            is the forecast state's copy of them — which is exactly the split
            `app/index.tsx` was making when it rendered `SettledPanels` beside
            `ForecastPanels` and nowhere else.
          */}
          {settledFour === null ? null : (
            <View style={{ flexGrow: 1, flexShrink: 1, flexBasis: 0, minWidth: 0 }}>
              {settledFour}
            </View>
          )}
        </View>
      ) : null}

      {/*
        The fan, full width and below the block, because it is an hourly series
        and an hourly series in a 300px rail is a smear. Absent rather than
        empty where nothing was published — the rule every other forecast panel
        follows.

        **Narrow only, since 21/09.** On a wide screen the same fan is drawn in
        the map's bottom-right corner instead — see the `overlay` handed to
        `RegionMap` above, which also records what that costs. Rendering both
        would put one chart on the page twice.
      */}
      {forecast === null || fanOverMap ? null : (
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
