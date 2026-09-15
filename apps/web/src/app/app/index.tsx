/**
 * Screen 1 — Visão da rede (IDEA.md §42), read from the **real** gateway.
 *
 * Two halves, and today only one of them answers.
 *
 * **The forecast half** — the map, the four rows, the hourly fan and the two
 * day bands — is `GET /v1/grid/outlook` and `GET /v1/forecast/day-ahead`. Both
 * refuse in production right now, because no artifact is promoted on either
 * serving lane and nothing has been published; `use-network.ts` documents the
 * exact state and the exact codes. When they refuse, these panels are
 * **absent** — not skeletons, not zeroed bands, not a flat line at zero — and
 * the screen says which clause refused, from the typed code, in the reader's
 * locale.
 *
 * **The observed half** — the settled grid across the four subsystems, the
 * selected subsystem's settled day, and its recent episodes — is
 * `GET /v1/grid/now`, `GET /v1/curtailment/hours` and
 * `GET /v1/curtailment/episodes`. None of them loads a model and all three
 * answer today. `docs/specs/api-surface.md` names exactly these three as what
 * the Overview shows when no artifact is promoted, and that is what it shows.
 *
 * **The observed half renders in both states, and stays observed in both.** It
 * is not a fallback that disappears when a forecast arrives: what the grid has
 * actually been doing is worth the same on a day that is forecast as on a day
 * that is not. It is drawn by different components from the forecast half for
 * the reason `lib/network.ts` gives — the failure being designed against is a
 * settled total in the place a forecast band was, under the label the band had.
 *
 * **What changed, and why the screen is no longer mostly refusal text.** Every
 * panel here used to be one of two things: forecast, and therefore absent; or
 * observed, and therefore present but confined to the bottom of the page. So
 * the state production is actually in — nothing promoted, and it has been for
 * weeks — rendered as a sentence, a second sentence, and three panels below the
 * fold. The map, the four rows, the 24-hour profile, the wind/solar split and
 * the two day figures were all withheld together, and a reader arriving at the
 * product's main screen found almost nothing to look at.
 *
 * The question that fixes it is asked **per panel**: *what can this panel
 * answer from data that needs no model at all?* For five of the six, the answer
 * is a real one, and it is the settled series this screen was already reading:
 *
 * | Panel | With a model | With none |
 * | --- | --- | --- |
 * | Map | risk class per subsystem, three bins | settled MWh per subsystem, one ramp |
 * | Rows | expectation + P10–P90 + peak band | settled MWh, split, one share bar |
 * | 24 h | P10–P90 fan for tomorrow | the settled day's hourly bars |
 * | Wind/solar | a division of one modelled expectation | two published settlements |
 * | Day total | joint band from the ensemble | the settled day's sum |
 * | Peak | peak **power** band, in MW | the largest settled hour, in MWh |
 *
 * The sixth thing — a P10/P50/P90 interval — has no model-free answer and is
 * not given one. Where the forecast card draws a band, the observed card says
 * in words that there is no band and why. **An observation is never dressed as
 * a forecast**: the two never share a component, a colour, a badge or a
 * sentence, and `test/observed-overview.test.ts` and
 * `e2e/app-observed-overview.spec.ts` hold that from both ends.
 */

import {
  ClockIcon,
  FadeIn,
  LayoutDashboardIcon,
  layout,
  MapIcon,
  Panel,
  PanelHeader,
  PieChartIcon,
  space,
  useContainerWidth,
  usePalette,
} from "@wattsteer/ui";
import { router } from "expo-router";
import Head from "expo-router/head";
import { type ReactNode, useState } from "react";
import { Text, View } from "react-native";
import { AppShell, ScreenTitle } from "@/components/app/app-shell";
import { ForecastAbsent } from "@/components/app/forecast-absent";
import {
  ForecastStamp,
  HonestyNote,
  ObservedBadge,
  ObservedStamp,
  VintageBadge,
} from "@/components/app/honesty";
import { SelectedRegion } from "@/components/app/selected-region";
import { ObservedSubsystemRow, SubsystemRow } from "@/components/app/subsystem-row";
import {
  gateProfileOf,
  sharedParams,
  useAppParams,
} from "@/components/app/use-app-params";
import {
  type ForecastNetwork,
  type ObservedNetwork,
  useNetwork,
} from "@/components/app/use-network";
import { BandCard } from "@/components/charts/band-figure";
import { EpisodeList } from "@/components/charts/episode-list";
import { FanChart } from "@/components/charts/fan-chart";
import {
  ObservedCard,
  ObservedEmptyCard,
  ObservedProfile,
} from "@/components/charts/observed-profile";
import { RiskCaveat } from "@/components/charts/risk-class";
import { SubsystemMap } from "@/components/charts/subsystem-map";
import {
  ObservedSplitPanel,
  TechnologySplitPanel,
} from "@/components/charts/technology-split";
import { useVoiceHighlight } from "@/components/voice/use-voice-agent";
import { useCopy, useFormat } from "@/i18n";
import { fill } from "@/i18n/format";
import {
  SUBSYSTEM_DISPLAY_ORDER,
  type SubsystemCode,
  subsystemMeta,
} from "@/lib/fixtures";
import {
  forecastHours,
  forecastRow,
  observedDay,
  observedRows,
  outlookRows,
} from "@/lib/network";

export default function GridOverviewScreen() {
  const colors = usePalette();
  const copy = useCopy();
  const f = useFormat();
  const params = useAppParams();
  const meta = subsystemMeta(params.subsystem);
  const state = useNetwork({
    subsystem: params.subsystem,
    targetDate: params.date,
    gateProfile: gateProfileOf(params.run),
  });
  /**
   * The screen's own sentence, which is not the same sentence in both states.
   *
   * The forecast lede promises "every figure is a P10/P50/P90 interval, not a
   * point" — true of the forecast panels and flatly false of the observed ones,
   * which are points and nothing but. A lede that describes the other state's
   * panels is the first line a reader meets, so it is the first thing that has
   * to be right.
   */
  const forecastPublished = state.status === "read";

  /**
   * **Selecting and navigating are two actions now, and they were one.**
   *
   * `select` used to be the `router.push` below. So a click on the map or on a
   * row carried two plausible meanings — "show me this region here" and "go
   * explain this region" — and silently did the second, which left the
   * four panels on this screen ("Perfil de 24 horas", "Eólica e solar",
   * "Energia cortada, dia inteiro", "Pico de potência horária") re-pointable
   * only from the menu at the top. A reader clicked a region expecting those
   * panels to change and was navigated away instead.
   *
   * `docs/plans/voice-copilot.md` §3.1 already drew exactly this line for the
   * agent: `highlight` "should **not** navigate. It should stay on Visão da
   * rede, light the NE on the map, and speak the band", while `explain` goes to
   * `/app/explain`. The mouse did not agree with the voice — the same gesture
   * the agent is forbidden to make by navigating was the only one a pointer
   * could make. **The two agree now**: a click selects, `highlight` emphasises,
   * and only a control with "Explicar" written on it navigates.
   *
   * Both are still defined once and handed to both affordances, which is what
   * the note that stood here was for, and still true.
   */
  const select = (subsystem: SubsystemCode) => params.setParams({ subsystem });

  /** The explicit affordance. Carries the rest of the selection with it. */
  const explain = (subsystem: SubsystemCode) =>
    router.push({
      pathname: "/app/explain" as never,
      params: { ...sharedParams(params), subsystem },
    });

  const frame = (right: ReactNode, body: ReactNode) => (
    <>
      <Head>
        <title>{copy.app.overview.metaTitle}</title>
        {/* `follow`, which the four `/app` screens and the 404 used to omit.
            The rest of the site already pairs the two — `/` and `/pitch` say
            `noindex,follow` — and for the same reason: the page should stay
            out of the index, but the links in its footer point at the landing
            page and the legal pages, and a bare `noindex` eventually has
            Google treat those links as `nofollow`. Nothing here is worth
            ranking; the pages it links to are. */}
        <meta name="robots" content="noindex,follow" />
      </Head>
      <AppShell>
        <ScreenTitle
          title={copy.app.overview.title}
          lede={
            forecastPublished
              ? fill(copy.app.overview.lede, { date: f.date(params.date) })
              : copy.app.overview.ledeObserved
          }
          right={right}
        />
        {body}
      </AppShell>
    </>
  );

  if (state.status === "reading") {
    return frame(
      null,
      <HonestyNote
        title={copy.app.overview.readingTitle}
        tone="neutral"
        points={[copy.app.overview.readingNote]}
      />,
    );
  }

  if (state.status === "refused") {
    // Even the settled grid did not answer. There is nothing on this screen
    // that does not depend on it, so there is nothing to draw but the sentence
    // — and a sentence is what a reader can act on, where an empty page is not.
    return frame(
      null,
      <HonestyNote
        title={copy.app.overview.refusedTitle}
        tone="warning"
        points={[copy.error[state.code], copy.app.overview.refusedNote]}
      />,
    );
  }

  const observed = state.observed;
  const forecast = state.status === "read" ? state.forecast : null;

  return frame(
    /*
      The header slot says which of the two claims the screen is making, before
      a single number is reached. It used to be empty whenever no forecast was
      published, which left the most prominent line on the page saying nothing
      in the state the product is actually in.
    */
    forecast === null ? (
      <ObservedStamp
        latestSettledHour={observed.now.latestSettledHour}
        lagHours={observed.now.lagHours}
      />
    ) : (
      <ForecastStamp
        origin={forecast.forecast.forecastOrigin}
        thresholdMw={forecast.forecast.thresholdMw}
      />
    ),
    <>
      {state.status === "observedOnly" ? (
        <ForecastAbsent
          code={state.code}
          title={copy.app.overview.absentTitle}
          note={copy.app.overview.absentNote}
        />
      ) : null}

      {/*
        Two stacks, never interleaved, and each one whole.

        `ForecastPanels` is everything a promoted model pays for, unchanged.
        `ObservedPanels` is the same six questions answered from settled data —
        map, rows, 24-hour profile, wind and solar, day total, largest hour —
        under the observed vocabulary throughout.

        In the `read` state the settled figures keep their own section at the
        bottom (`SettledPanels`), where they have always been: they are worth
        the same on a day that is forecast, and moving them next to the forecast
        panels is exactly the adjacency `lib/network.ts` refuses.
      */}
      {forecast === null ? (
        <ObservedPanels
          observed={observed}
          subsystem={params.subsystem}
          onSelect={select}
          onExplain={explain}
        />
      ) : (
        <>
          <ForecastPanels forecast={forecast} onSelect={select} onExplain={explain} />
          <SettledPanels
            observed={observed}
            subsystem={params.subsystem}
            onSelect={select}
          />
        </>
      )}

      <Text style={{ fontSize: 12, lineHeight: 19, color: colors.inkFaint }}>
        {fill(copy.app.overview.grainNote, { subsystem: meta.onsDisplayName })}
      </Text>
    </>,
  );
}

/**
 * Everything a promoted model pays for.
 *
 * Rendered only in the `read` state, and therefore not rendered at all today.
 * It is written in full rather than stubbed, because "these screens must light
 * up with no further edits" is only true if the code that lights up already
 * exists: the day a lane is promoted and a gate publishes, `use-network.ts`
 * returns `read` and this component is what appears.
 */
function ForecastPanels({
  forecast,
  onSelect,
  onExplain,
}: {
  forecast: ForecastNetwork;
  onSelect: (subsystem: SubsystemCode) => void;
  onExplain: (subsystem: SubsystemCode) => void;
}) {
  const colors = usePalette();
  const copy = useCopy();
  const f = useFormat();
  const params = useAppParams();
  const meta = subsystemMeta(params.subsystem);
  const rows = outlookRows(forecast.outlook);
  const selected = forecastRow(forecast.forecast);
  const [overviewWidth, onOverviewLayout] = useContainerWidth();
  // One hover, two affordances — see `SubsystemMap`'s `hovered` prop.
  const [hovered, setHovered] = useState<SubsystemCode | null>(null);
  /**
   * The third end of the same affordance: the voice agent lights both.
   *
   * `subsystem-map.tsx` already lifted the highlight because *"hovering a
   * region lights its row and hovering a row lights its region"*. A `highlight`
   * tool call is a third source for that one value and not a new mechanism —
   * `docs/plans/voice-copilot.md` §3.1 says so, and it is what makes the demo's
   * first step work: the reader asks which region to worry about, and the
   * answer is the NE lighting up on the screen they are already on, with **no
   * navigation at all**.
   *
   * The pointer wins where there is one. A reader moving a mouse is making a
   * live choice; the agent's emphasis is an answer to a question they asked a
   * moment ago, and an answer that fought the pointer would read as the map
   * being stuck.
   */
  const spoken = useVoiceHighlight();
  const active = hovered ?? spoken;
  const side = overviewWidth >= layout.desktop;

  // One scale across all four rows, so "wider" and "bigger" mean what they look
  // like. Computed from the P90s, not the P50s.
  const domainMax = Math.max(...rows.map((each) => each.dailyEnergy.p90)) * 1.05;

  return (
    <>
      <FadeIn style={{ gap: space.md }} onLayout={onOverviewLayout}>
        {/*
          Map and rows side by side once there is room for both, stacked below
          that. `side` is measured against `layout.desktop` on the *container*
          rather than the viewport, so the pair reflows correctly inside
          whatever it is nested in.
        */}
        <View
          style={{
            flexDirection: side ? "row" : "column",
            alignItems: side ? "flex-start" : "stretch",
            gap: space.md,
          }}
        >
          <Panel style={side ? { width: 420 } : undefined}>
            <PanelHeader
              icon={<MapIcon size={18} color={colors.inkMuted} />}
              title={copy.app.overview.map.title}
              subtitle={copy.app.overview.map.subtitle}
            />
            <View style={{ marginTop: space.lg }}>
              <SubsystemMap
                paint={{ kind: "forecast", rows }}
                selected={params.subsystem}
                hovered={active}
                onHoverChange={setHovered}
                onSelect={onSelect}
              />
            </View>
            {/*
              Directly under the map graphic and above its own footnotes, and
              this is choice (3) of the ticket: something must visibly respond
              inside the viewport. The panels this selection re-points are below
              the fold on a laptop and far below it on a phone, so a click could
              otherwise produce no visible change at all — and placed after the
              boundary note and the attribution, the strip was itself at the
              edge of the fold at 1440, measured on the export.

              The alternative was to scroll the panel block into view on every
              selection. Rejected: this is a comparison screen, and scrolling
              takes the map — the thing a reader is comparing from — off the
              screen, so every comparison costs a scroll back. It is worse still
              on the keyboard, where an arrow key would fling the page. A strip
              in place costs no motion and leaves the next click where the last
              one was.
            */}
            <View style={{ marginTop: space.md }}>
              <SelectedRegion
                subsystem={params.subsystem}
                row={rows.find((row) => row.subsystem === params.subsystem) ?? null}
                onExplain={() => onExplain(params.subsystem)}
              />
            </View>

            <Text
              style={{
                fontSize: 11,
                color: colors.inkFaint,
                lineHeight: 17,
                marginTop: space.md,
              }}
            >
              {copy.app.overview.map.boundaryNote}
            </Text>
          </Panel>

          <View style={{ flex: side ? 1 : undefined, gap: space.md }}>
            {rows.map((row) => (
              <SubsystemRow
                key={row.subsystem}
                forecast={row}
                emphasis={params.technology}
                domainMax={domainMax}
                selected={row.subsystem === params.subsystem}
                highlighted={row.subsystem === active}
                onHoverChange={(on) => setHovered(on ? row.subsystem : null)}
                onPress={() => onSelect(row.subsystem)}
                onExplain={() => onExplain(row.subsystem)}
              />
            ))}
          </View>
        </View>
        <RiskCaveat />
      </FadeIn>

      <FadeIn delay={70}>
        <Panel>
          <PanelHeader
            icon={<LayoutDashboardIcon size={18} color={colors.inkMuted} />}
            title={meta.onsDisplayName}
            subtitle={copy.app.overview.profileSubtitle}
          />
          <View style={{ marginTop: space.lg }}>
            <FanChart
              hours={forecastHours(forecast.forecast)}
              thresholdMw={forecast.forecast.thresholdMw}
            />
          </View>
        </Panel>
      </FadeIn>

      <FadeIn delay={140}>
        <Panel>
          <PanelHeader
            icon={<PieChartIcon size={18} color={colors.inkMuted} />}
            title={copy.app.split.title}
            // Named. Every one of these four panels is about the selected
            // subsystem and only the profile panel said so — which is exactly
            // what let a selection change four panels invisibly.
            subtitle={fill(copy.app.split.subtitle, {
              subsystem: meta.onsDisplayName,
            })}
          />
          <View style={{ marginTop: space.lg }}>
            <TechnologySplitPanel
              split={selected.split}
              expectedMwh={selected.dayExpectedMwh}
              emphasis={params.technology}
            />
          </View>
        </Panel>
      </FadeIn>

      <FadeIn
        delay={210}
        style={{ flexDirection: "row", flexWrap: "wrap", gap: space.lg }}
      >
        <BandCard
          label={fill(copy.app.overview.dailyEnergy, {
            subsystem: meta.onsDisplayName,
          })}
          band={selected.dailyEnergy}
          unit="MWh"
          footnote={copy.app.overview.dailyEnergyNote}
        />
        <BandCard
          label={fill(copy.app.overview.peakPower, {
            subsystem: meta.onsDisplayName,
          })}
          band={selected.peakPower}
          unit="MW"
          tone="violet"
          footnote={fill(copy.app.overview.peakPowerNote, {
            mw: f.number(forecast.forecast.thresholdMw),
          })}
        />
      </FadeIn>
    </>
  );
}

/**
 * The settled grid, in the place the forecast panels occupy when there is one.
 *
 * Six panels, no model behind any of them, and every one of them naming the day
 * or the window it covers — an observed figure whose period is not stated is
 * not comparable with anything, and this screen holds two windows at once: the
 * four-subsystem view is the **last 24 h to the latest settled hour**, which is
 * what `GET /v1/grid/now` publishes, and the deep panels are the **last settled
 * civil day**, which is what `GET /v1/curtailment/hours` was asked for. Both are
 * stated; neither is inferred from the other.
 *
 * **Why the selected region's own figures come from a different window than the
 * map's.** There is exactly one observed read that covers all four subsystems,
 * and exactly one that covers a subsystem hour by hour. Forcing them onto one
 * window would mean either summing the four civil days out of four separate
 * requests — three more round trips for a number the gateway already
 * publishes — or drawing the map from a window the route does not offer. Two
 * honest windows, each labelled, beats one invented one.
 */
function ObservedPanels({
  observed,
  subsystem,
  onSelect,
  onExplain,
}: {
  observed: ObservedNetwork;
  subsystem: SubsystemCode;
  onSelect: (subsystem: SubsystemCode) => void;
  onExplain: (subsystem: SubsystemCode) => void;
}) {
  const colors = usePalette();
  const copy = useCopy();
  const f = useFormat();
  const meta = subsystemMeta(subsystem);
  const params = useAppParams();
  const rows = observedRows(observed.now.subsystems, SUBSYSTEM_DISPLAY_ORDER);
  const day = observedDay(observed.hours);
  const [overviewWidth, onOverviewLayout] = useContainerWidth();
  // The same one-hover-two-affordances arrangement the forecast stack has, for
  // the same reason: hovering a region lights its row and hovering a row lights
  // its region, and the voice agent's `highlight` is a third source for the
  // same value. Losing it in the state production is actually in would mean the
  // agent's first demo step lit nothing.
  const [hovered, setHovered] = useState<SubsystemCode | null>(null);
  const spoken = useVoiceHighlight();
  const active = hovered ?? spoken;
  const side = overviewWidth >= layout.desktop;
  // One scale across all four rows and the map's ramp, so a region's colour and
  // its row's bar are the same statement made twice.
  const domainMax = Math.max(...rows.map((row) => row.last24hMwh), 0);
  const window24h = fill(copy.app.observed.window24h, {
    hour: f.dateTime(observed.now.latestSettledHour),
  });
  const windowDay = fill(copy.app.observed.windowDay, {
    date: f.date(observed.hoursDate),
  });
  const selectedRow = rows.find((row) => row.subsystem === subsystem) ?? null;

  return (
    <>
      <FadeIn style={{ gap: space.md }} onLayout={onOverviewLayout}>
        <View
          style={{
            flexDirection: side ? "row" : "column",
            alignItems: side ? "flex-start" : "stretch",
            gap: space.md,
          }}
        >
          <Panel style={side ? { width: 420 } : undefined}>
            <PanelHeader
              icon={<MapIcon size={18} color={colors.inkMuted} />}
              title={copy.app.overview.map.titleObserved}
              subtitle={copy.app.overview.map.subtitleObserved}
              right={<ObservedBadge />}
            />
            <View style={{ marginTop: space.lg }}>
              <SubsystemMap
                paint={{ kind: "observed", rows }}
                selected={subsystem}
                hovered={active}
                onHoverChange={setHovered}
                onSelect={onSelect}
              />
            </View>
            <Text
              style={{
                marginTop: space.sm,
                fontSize: 11,
                color: colors.info,
                textAlign: "center",
                fontVariant: ["tabular-nums"],
              }}
            >
              {window24h}
            </Text>

            <View style={{ marginTop: space.md }}>
              <SelectedRegion
                subsystem={subsystem}
                row={null}
                observed={selectedRow}
                observedWindow={window24h}
                onExplain={() => onExplain(subsystem)}
              />
            </View>

            <Text
              style={{
                fontSize: 11,
                color: colors.inkFaint,
                lineHeight: 17,
                marginTop: space.md,
              }}
            >
              {copy.app.overview.map.boundaryNote}
            </Text>
          </Panel>

          <View style={{ flex: side ? 1 : undefined, gap: space.md }}>
            {rows.map((row) => (
              <ObservedSubsystemRow
                key={row.subsystem}
                observed={row}
                domainMax={domainMax}
                selected={row.subsystem === subsystem}
                highlighted={row.subsystem === active}
                onHoverChange={(on) => setHovered(on ? row.subsystem : null)}
                onPress={() => onSelect(row.subsystem)}
                onExplain={() => onExplain(row.subsystem)}
              />
            ))}
            <Text
              style={{
                fontSize: 11,
                lineHeight: 18,
                color: colors.inkFaint,
              }}
            >
              {fill(copy.app.overview.settledNationalNote, {
                mwh: f.compact(observed.now.national.last24hConstrainedOffMwh),
              })}
            </Text>
            <View style={{ alignSelf: "flex-start" }}>
              <VintageBadge fidelity={observed.now.vintageFidelity} />
            </View>
          </View>
        </View>
      </FadeIn>

      <SettledDayPanel observed={observed} subsystem={subsystem} bandAbsent={true} />

      <FadeIn delay={140}>
        <Panel>
          <PanelHeader
            icon={<PieChartIcon size={18} color={colors.inkMuted} />}
            title={copy.app.observed.splitTitle}
            subtitle={fill(copy.app.observed.splitSubtitle, {
              subsystem: meta.onsDisplayName,
            })}
            right={<ObservedBadge />}
          />
          <View style={{ marginTop: space.lg }}>
            <ObservedSplitPanel
              split={observed.daySplit}
              emphasis={params.technology}
              window={windowDay}
            />
          </View>
        </Panel>
      </FadeIn>

      {/*
        The two day figures. Where the forecast stack draws two `BandCard`s,
        this draws two `ObservedCard`s — no strip, no quantile labels, and a
        footnote in each saying that the interval is the part a model would
        have supplied. The peak card is an **energy** in MWh, not a power in
        MW: see `observedDay` in `lib/network.ts`.

        `peakHour === null` is the day that settled with no curtailment in it,
        which is a different sentence from a zero and gets a different card.
      */}
      <FadeIn
        delay={210}
        style={{ flexDirection: "row", flexWrap: "wrap", gap: space.lg }}
      >
        {day.peakHour === null ? (
          <>
            <ObservedEmptyCard
              label={fill(copy.app.observed.dayTotal, {
                subsystem: meta.onsDisplayName,
              })}
            />
            <ObservedEmptyCard
              label={fill(copy.app.observed.peakHour, {
                subsystem: meta.onsDisplayName,
              })}
            />
          </>
        ) : (
          <>
            <ObservedCard
              label={fill(copy.app.observed.dayTotal, {
                subsystem: meta.onsDisplayName,
              })}
              value={day.totalMwh}
              unit="MWh"
              window={windowDay}
              footnote={copy.app.observed.dayTotalNote}
            />
            <ObservedCard
              label={fill(copy.app.observed.peakHour, {
                subsystem: meta.onsDisplayName,
              })}
              value={day.peakHour.constrainedOffMwh}
              unit="MWh"
              window={fill(copy.app.observed.peakHourWindow, {
                hour: f.number(day.peakHour.hourLocal),
                date: f.date(observed.hoursDate),
              })}
              footnote={copy.app.observed.peakHourNote}
            />
          </>
        )}
      </FadeIn>

      <EpisodesPanel observed={observed} />
    </>
  );
}

/**
 * The settled grid **beside a published forecast**, which is where it has
 * always lived and where it stays.
 *
 * Three panels rather than six: with a forecast on the screen the map, the
 * rows, the day total and the largest hour are all answered above in the
 * forecast's own language, and repeating them in the observed one would put two
 * numbers for the same-sounding quantity on one page — an invitation to read
 * one as a correction of the other. What remains is what the forecast half does
 * not say at all: what the four subsystems have settled, what the last settled
 * day looked like hour by hour, and which episodes ran.
 */
function SettledPanels({
  observed,
  subsystem,
  onSelect,
}: {
  observed: ObservedNetwork;
  subsystem: SubsystemCode;
  /**
   * The same selector the map and the forecast rows take.
   *
   * These four settled rows are a per-subsystem list like any other on this
   * screen, and a list that marks a selection and refuses to take one is an
   * affordance withheld for no reason.
   */
  onSelect: (subsystem: SubsystemCode) => void;
}) {
  return (
    <>
      <SettledSubsystemsPanel
        observed={observed}
        subsystem={subsystem}
        onSelect={onSelect}
      />
      <SettledDayPanel observed={observed} subsystem={subsystem} bandAbsent={false} />
      <EpisodesPanel observed={observed} />
    </>
  );
}

/** The four subsystems as ONS has settled them, and a selector. */
function SettledSubsystemsPanel({
  observed,
  subsystem,
  onSelect,
}: {
  observed: ObservedNetwork;
  subsystem: SubsystemCode;
  onSelect: (subsystem: SubsystemCode) => void;
}) {
  const colors = usePalette();
  const copy = useCopy();
  const f = useFormat();
  const rows = observedRows(observed.now.subsystems, SUBSYSTEM_DISPLAY_ORDER);
  const domainMax = Math.max(...rows.map((row) => row.last24hMwh), 0);

  return (
    <FadeIn delay={70}>
      <Panel>
        <PanelHeader
          icon={<ClockIcon size={18} color={colors.inkMuted} />}
          title={copy.app.overview.settledTitle}
          subtitle={fill(copy.app.overview.settledSubtitle, {
            hour: f.dateTime(observed.now.latestSettledHour),
            lag: f.number(observed.now.lagHours),
          })}
          right={<VintageBadge fidelity={observed.now.vintageFidelity} />}
        />
        <View style={{ marginTop: space.lg, gap: space.sm }}>
          {rows.map((row) => (
            <ObservedSubsystemRow
              key={row.subsystem}
              observed={row}
              domainMax={domainMax}
              selected={row.subsystem === subsystem}
              onPress={() => onSelect(row.subsystem)}
            />
          ))}
        </View>
        <Text
          style={{
            marginTop: space.md,
            fontSize: 11,
            lineHeight: 18,
            color: colors.inkFaint,
          }}
        >
          {fill(copy.app.overview.settledNationalNote, {
            mwh: f.compact(observed.now.national.last24hConstrainedOffMwh),
          })}
        </Text>
      </Panel>
    </FadeIn>
  );
}

/**
 * The selected subsystem's last settled day, hour by hour.
 *
 * `bandAbsent` is the one difference between its two appearances. Standing in
 * for the forecast's 24-hour fan, it owes the reader the sentence the fan's
 * absence would otherwise leave implicit: there is no P10–P90 ribbon here and
 * there cannot be, because a ribbon is a model's output and these are settled
 * hours. Beside a published fan, that sentence would be answering a question
 * nobody has.
 */
function SettledDayPanel({
  observed,
  subsystem,
  bandAbsent,
}: {
  observed: ObservedNetwork;
  subsystem: SubsystemCode;
  bandAbsent: boolean;
}) {
  const colors = usePalette();
  const copy = useCopy();
  const f = useFormat();
  const meta = subsystemMeta(subsystem);

  return (
    <FadeIn delay={70}>
      <Panel>
        <PanelHeader
          icon={<LayoutDashboardIcon size={18} color={colors.inkMuted} />}
          title={fill(copy.app.overview.settledDayTitle, {
            subsystem: meta.onsDisplayName,
          })}
          subtitle={fill(copy.app.overview.settledDaySubtitle, {
            date: f.date(observed.hoursDate),
          })}
          right={<ObservedBadge />}
        />
        <View style={{ marginTop: space.lg }}>
          <ObservedProfile
            hours={observed.hours}
            emptyLabel={copy.app.overview.settledDayEmpty}
          />
        </View>
        <Text
          style={{
            marginTop: space.md,
            fontSize: 11,
            lineHeight: 18,
            color: colors.inkFaint,
          }}
        >
          {copy.app.overview.settledDayNote}
        </Text>
        {bandAbsent ? (
          <Text
            style={{
              marginTop: space.sm,
              fontSize: 11,
              lineHeight: 18,
              color: colors.inkFaint,
            }}
          >
            {copy.app.observed.noFan}
          </Text>
        ) : null}
      </Panel>
    </FadeIn>
  );
}

/** A fortnight of episodes, with the parameters that defined them. */
function EpisodesPanel({ observed }: { observed: ObservedNetwork }) {
  const copy = useCopy();
  const f = useFormat();
  return (
    <FadeIn delay={210}>
      <EpisodeList
        episodes={observed.episodes.episodes}
        maxGapHours={observed.episodes.maxGapHours}
        title={copy.app.overview.episodesTitle}
        subtitle={fill(copy.app.overview.episodesSubtitle, {
          from: f.date(observed.episodes.from.slice(0, 10)),
          to: f.date(observed.episodes.to.slice(0, 10)),
          mw: f.number(observed.episodes.thresholdMw),
        })}
        row={copy.app.overview.episodeRow}
        note={copy.app.overview.episodeNote}
        empty={copy.app.overview.episodesEmpty}
      />
    </FadeIn>
  );
}
