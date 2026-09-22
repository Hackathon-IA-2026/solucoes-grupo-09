/**
 * The forecast half of the Grid Overview.
 *
 * Extracted from the screen, which had grown to a thousand lines by being two
 * things at once: a route, and a library of the panels that route arranges.
 * Nothing here changed in the move. What the split buys is that the screen file
 * now reads as the *decision* it makes — settled or forecast, and in which
 * order — with the panels themselves one level down, where a reader who wants
 * the fan chart is not scrolling past the routing to reach it.
 *
 * Every panel in this file is drawn only when a model is promoted. Its
 * counterpart for the day that is not is `observed-panels.tsx`, and the two
 * are deliberately separate files for the reason `lib/network.ts` keeps
 * `OutlookRow` and `ObservedRow` separate types: a component written for one
 * must not be reachable with the other.
 */

import {
  CalendarDaysIcon,
  FadeIn,
  gradientBg,
  LayoutDashboardIcon,
  layout,
  MapIcon,
  Panel,
  PanelHeader,
  READOUT_WASH,
  space,
  useContainerWidth,
  usePalette,
} from "@wattsteer/ui";
import { useState } from "react";
import { Text, View } from "react-native";
import { NationalFigureBlock } from "@/components/app/overview/national-panel";
import { SelectedRegion } from "@/components/app/selected-region";
import { SubsystemRow } from "@/components/app/subsystem-row";
import { useAppParams } from "@/components/app/use-app-params";
import type { ForecastNetwork } from "@/components/app/use-network";
import { BandCard } from "@/components/charts/band-figure";
import { FanChart } from "@/components/charts/fan-chart";
import { RiskCaveat } from "@/components/charts/risk-class";
import { SubsystemMap } from "@/components/charts/subsystem-map";
import { useVoiceHighlight } from "@/components/voice/use-voice-agent";
import { useCopy, useFormat } from "@/i18n";
import { fill } from "@/i18n/format";
import { type SubsystemCode, subsystemMeta } from "@/lib/fixtures";
import { forecastHours, forecastRow, outlookRows } from "@/lib/network";

/**
 * Everything a promoted model pays for.
 *
 * Rendered only in the `read` state, and therefore not rendered at all today.
 * It is written in full rather than stubbed, because "these screens must light
 * up with no further edits" is only true if the code that lights up already
 * exists: the day a lane is promoted and a gate publishes, `use-network.ts`
 * returns `read` and this component is what appears.
 */
export function ForecastPanels({
  forecast,
  onSelect,
  onExplain,
  heroElsewhere = false,
}: {
  forecast: ForecastNetwork;
  onSelect: (subsystem: SubsystemCode) => void;
  onExplain: (subsystem: SubsystemCode) => void;
  /**
   * Whether the screen already drew the national figure, the map, the rows, the
   * selection and the fan above this stack.
   *
   * `OverviewHero` does, so these panels must not draw them twice. A prop
   * rather than a second component because the alternative is two near-copies
   * of this file, which is how the panels below would drift from the ones
   * above — and this stack has already lost panels twice to nobody noticing.
   */
  heroElsewhere?: boolean;
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
      {heroElsewhere ? null : (
        <FadeIn style={{ gap: space.md }}>
          {/* The landing's readout card: figure and subsystem list side by side,
              a rule, then the hourly fan — one object, not four panels. */}
          <Panel style={gradientBg(READOUT_WASH, colors.surface)}>
            <PanelHeader
              icon={<CalendarDaysIcon size={18} color={colors.inkMuted} />}
              title={copy.app.overview.nationalTitle}
              subtitle={copy.app.overview.nationalSubtitle}
            />

            <View
              style={{
                flexDirection: side ? "row" : "column",
                gap: space.lg,
                marginTop: space.lg,
              }}
            >
              <View style={{ flex: side ? 1 : undefined, gap: space.md }}>
                <NationalFigureBlock national={forecast.outlook.national} />
              </View>

              <View style={{ flex: side ? 1.15 : undefined, gap: space.md }}>
                <View
                  style={{
                    flexDirection: "row",
                    flexWrap: "wrap",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: space.sm,
                  }}
                >
                  <Text style={{ fontSize: 14, fontWeight: "600", color: colors.ink }}>
                    {copy.readout.subsystemsTitle}
                  </Text>
                  <Text style={{ fontSize: 12, color: colors.inkFaint }}>
                    {copy.readout.columnProbability}
                  </Text>
                </View>
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
                <Text style={{ fontSize: 11, lineHeight: 17, color: colors.inkFaint }}>
                  {copy.readout.additivityNote}
                </Text>
              </View>
            </View>

            <View
              style={{
                height: 1,
                backgroundColor: colors.border,
                marginVertical: space.lg,
              }}
            />

            <View style={{ gap: space.md }}>
              <PanelHeader
                icon={<LayoutDashboardIcon size={18} color={colors.inkMuted} />}
                title={meta.onsDisplayName}
                subtitle={copy.app.overview.profileSubtitle}
              />
              <FanChart
                hours={forecastHours(forecast.forecast)}
                thresholdMw={forecast.forecast.thresholdMw}
              />
            </View>
          </Panel>
        </FadeIn>
      )}

      {heroElsewhere ? (
        <FadeIn delay={70}>
          <RiskCaveat />
        </FadeIn>
      ) : (
        <FadeIn delay={70} style={{ gap: space.md }} onLayout={onOverviewLayout}>
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
          </View>
          <RiskCaveat />
        </FadeIn>
      )}

      {/*
        **The fleet split moved into the rail beside the map, on all four rows.**

        This card drew one subsystem's two scalars, full width, under a heading
        that repeated the day expectation already stated above it — while the
        rail a few hundred pixels away drew the same four regions with no split
        at all. A reader wanting "how much of NORDESTE is wind?" had to select
        NORDESTE to find out, one region at a time.

        The rail's bar is cut into the two fleets now and each row prints both
        figures, so the division is on screen for all four at once; the caveat
        this card carried travels with them, once, under the rows. See
        `region-rail.tsx` for why it is one segmented bar and not two.
      */}

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
