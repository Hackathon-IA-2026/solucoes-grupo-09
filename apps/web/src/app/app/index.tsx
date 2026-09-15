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
 */

import {
  ClockIcon,
  FadeIn,
  focusRing,
  LayoutDashboardIcon,
  layout,
  MapIcon,
  Panel,
  PanelHeader,
  PieChartIcon,
  radius,
  space,
  useContainerWidth,
  usePalette,
} from "@wattsteer/ui";
import { router } from "expo-router";
import Head from "expo-router/head";
import { type ReactNode, useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { AppShell, ScreenTitle } from "@/components/app/app-shell";
import { ForecastAbsent } from "@/components/app/forecast-absent";
import { ForecastStamp, HonestyNote, VintageBadge } from "@/components/app/honesty";
import { SelectedRegion } from "@/components/app/selected-region";
import { SubsystemRow } from "@/components/app/subsystem-row";
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
import { ObservedProfile } from "@/components/charts/observed-profile";
import { RiskCaveat } from "@/components/charts/risk-class";
import { SubsystemMap } from "@/components/charts/subsystem-map";
import { TechnologySplitPanel } from "@/components/charts/technology-split";
import { useVoiceHighlight } from "@/components/voice/use-voice-agent";
import { useCopy, useFormat } from "@/i18n";
import { fill } from "@/i18n/format";
import {
  SUBSYSTEM_DISPLAY_ORDER,
  type SubsystemCode,
  subsystemMeta,
} from "@/lib/fixtures";
import { forecastHours, forecastRow, nowRows, outlookRows } from "@/lib/network";

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
          lede={fill(copy.app.overview.lede, { date: f.date(params.date) })}
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
    forecast === null ? null : (
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
        The selection strip renders in **both** states, and this is the only
        place it can, because the map and the four rows live inside
        `ForecastPanels` and there is nothing promoted for them to draw. With
        no forecast a reader still picks a subsystem — from the chips in the
        chrome, or from the settled rows below — and still has to see which one
        they picked and why there are no numbers for it. `row` is `null` there
        and the strip says so rather than showing nothing.

        In the `read` state it sits under the map instead, inside
        `ForecastPanels`, because that is where the click that changes it
        happens. Same component, placed where the reader's eyes are in each
        state.
      */}
      {forecast === null ? (
        <SelectedRegion
          subsystem={params.subsystem}
          row={null}
          onExplain={() => explain(params.subsystem)}
        />
      ) : (
        <ForecastPanels forecast={forecast} onSelect={select} onExplain={explain} />
      )}

      <ObservedPanels
        observed={observed}
        subsystem={params.subsystem}
        onSelect={select}
      />

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
                forecasts={rows}
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
 * The settled grid. Three panels, no model behind any of them.
 *
 * Each names the day or the window it covers, because an observed figure whose
 * period is not stated is not comparable with anything — and, on a screen whose
 * other half is about *tomorrow*, a reader has to be able to tell at a glance
 * which of the two a number belongs to.
 */
function ObservedPanels({
  observed,
  subsystem,
  onSelect,
}: {
  observed: ObservedNetwork;
  subsystem: SubsystemCode;
  /**
   * The same selector the map and the forecast rows take.
   *
   * With nothing promoted the map and the four forecast rows are absent, and
   * these four settled rows are then the only per-subsystem list on the screen.
   * They already marked the selected one in bold and could not change it, which
   * is a list that shows a selection and refuses to take one — so the refusal
   * path had strictly less of the screen's own affordance than the success
   * path did.
   */
  onSelect: (subsystem: SubsystemCode) => void;
}) {
  const colors = usePalette();
  const copy = useCopy();
  const f = useFormat();
  const meta = subsystemMeta(subsystem);
  const rows = nowRows(observed.now.subsystems, SUBSYSTEM_DISPLAY_ORDER);

  return (
    <>
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
              <Pressable
                key={row.subsystem}
                accessibilityRole="button"
                accessibilityLabel={fill(copy.app.overview.rowFigure, {
                  subsystem: row.onsDisplayName,
                })}
                onPress={() => onSelect(row.subsystem)}
                style={(state) => {
                  const { focused = false, hovered = false } = state as {
                    focused?: boolean;
                    hovered?: boolean;
                  };
                  const isSelected = row.subsystem === subsystem;
                  return {
                    flexDirection: "row",
                    flexWrap: "wrap",
                    alignItems: "baseline",
                    gap: 8,
                    // The same accent-border mark the forecast row and the map
                    // region carry, so "this one" looks the same in all three
                    // places — including the state where the other two are not
                    // on the screen at all.
                    borderRadius: radius.md,
                    borderCurve: "continuous",
                    borderWidth: 1,
                    borderColor: isSelected ? colors.accent : "transparent",
                    backgroundColor: hovered ? colors.surfaceSunken : "transparent",
                    paddingHorizontal: 10,
                    paddingVertical: 6,
                    ...focusRing(focused, colors.focus),
                    ...(Platform.OS === "web" ? ({ cursor: "pointer" } as object) : null),
                  };
                }}
              >
                <Text
                  style={{
                    flexGrow: 1,
                    flexBasis: 160,
                    fontSize: 13,
                    fontWeight: row.subsystem === subsystem ? "700" : "500",
                    color: row.subsystem === subsystem ? colors.ink : colors.inkMuted,
                  }}
                >
                  {row.onsDisplayName}
                </Text>
                <Text
                  style={{
                    fontSize: 14,
                    fontWeight: "700",
                    fontVariant: ["tabular-nums"],
                    color: colors.ink,
                  }}
                >
                  {`${f.compact(row.last24hConstrainedOffMwh)} MWh`}
                </Text>
                <Text
                  style={{
                    flexBasis: "100%",
                    fontSize: 11,
                    color: colors.inkFaint,
                    fontVariant: ["tabular-nums"],
                  }}
                >
                  {fill(copy.app.overview.settledSplit, {
                    wind: f.compact(row.split.windMwh),
                    solar: f.compact(row.split.solarMwh),
                  })}
                </Text>
              </Pressable>
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

      <FadeIn delay={140}>
        <Panel>
          <PanelHeader
            icon={<LayoutDashboardIcon size={18} color={colors.inkMuted} />}
            title={fill(copy.app.overview.settledDayTitle, {
              subsystem: meta.onsDisplayName,
            })}
            subtitle={fill(copy.app.overview.settledDaySubtitle, {
              date: f.date(observed.hoursDate),
            })}
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
        </Panel>
      </FadeIn>

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
    </>
  );
}
