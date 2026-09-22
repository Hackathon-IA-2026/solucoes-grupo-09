/**
 * The settled half of the Grid Overview: the whole screen, with no model behind
 * any of it.
 *
 * The counterpart of `forecast-panels.tsx`, drawn in the place those panels
 * occupy on a day nothing is promoted. Six questions, answered from settled
 * data — map, rows, 24-hour profile, wind and solar, day total, largest hour —
 * under the observed vocabulary throughout, every one of them naming the window
 * it covers.
 *
 * It shares `EpisodesPanel` with `settled-panels.tsx`
 * rather than restating them: those two panels are about settled data in both
 * stacks and say the same thing in both.
 */

import {
  FadeIn,
  layout,
  MapIcon,
  Panel,
  PanelHeader,
  space,
  useContainerWidth,
  usePalette,
} from "@wattsteer/ui";
import { useState } from "react";
import { Text, View } from "react-native";
import { ObservedBadge, VintageBadge } from "@/components/app/honesty";
import { ObservedNationalPanel } from "@/components/app/overview/national-panel";
import { SelectedRegion } from "@/components/app/selected-region";
import { ObservedSubsystemRow } from "@/components/app/subsystem-row";
import type { ObservedNetwork } from "@/components/app/use-network";
import { SubsystemMap } from "@/components/charts/subsystem-map";
import { useVoiceHighlight } from "@/components/voice/use-voice-agent";
import { useCopy, useFormat } from "@/i18n";
import { fill } from "@/i18n/format";
import {
  SUBSYSTEM_DISPLAY_ORDER,
  type SubsystemCode,
  subsystemMeta,
} from "@/lib/fixtures";
import { observedDay, observedRows } from "@/lib/network";

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
export function ObservedPanels({
  observed,
  subsystem,
  onSelect,
  onExplain,
  heroElsewhere = false,
}: {
  observed: ObservedNetwork;
  subsystem: SubsystemCode;
  onSelect: (subsystem: SubsystemCode) => void;
  onExplain: (subsystem: SubsystemCode) => void;
  /**
   * Whether the screen already drew the national figure, the map, the rows and
   * the selection above this stack.
   *
   * `OverviewHero` does, so these panels must not draw them twice. It is a prop
   * rather than a split component because the alternative — two near-copies of
   * this file — is how the panels below would drift from the ones above, and
   * this stack has already lost panels twice to somebody not noticing.
   */
  heroElsewhere?: boolean;
}) {
  const colors = usePalette();
  const copy = useCopy();
  const f = useFormat();
  /*
    Labelled from the data, not from the selection. `observed.subsystem` is the
    subsystem this response was requested for; `params.subsystem` is wherever
    the reader has clicked since. They are the same except during a re-read —
    and during a re-read this panel is showing the previous subsystem's figures,
    so it has to say the previous subsystem's name. See `ObservedNetwork`.
  */
  const _meta = subsystemMeta(observed.subsystem as SubsystemCode);
  const rows = observedRows(observed.now.subsystems, SUBSYSTEM_DISPLAY_ORDER);
  const _day = observedDay(observed.hours);
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
  const selectedRow = rows.find((row) => row.subsystem === subsystem) ?? null;

  return (
    <>
      {heroElsewhere ? null : (
        <FadeIn style={{ gap: space.md }}>
          <ObservedNationalPanel national={observed.now.national} window={window24h} />
        </FadeIn>
      )}

      {heroElsewhere ? null : (
        <FadeIn delay={70} style={{ gap: space.md }} onLayout={onOverviewLayout}>
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
                  /*
                    **No `onExplain` here, and axe says why.**

                    The row is already a button — "NORDESTE: selecionar" — so an
                    Explain button inside it is a control nested in a control:
                    `nested-interactive`, a WCAG 2 A violation, live in the exact
                    state production has been in for weeks. `accessibility.spec.ts`
                    believed it covered this screen and audited only the state with
                    a forecast, which is the one path where this prop was already
                    absent.

                    Deleting it is also what `ObservedSubsystemRow`'s own docstring
                    asks for — "two Explain controls for the same region, in two
                    lists, would be one too many" — and `SelectedRegion` above is
                    the other one. One fix, two defects.
                  */
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
      )}

      {/*
        The settled fleet split is in the rail beside the map now, on all four
        rows rather than on the selected one — see `forecast-panels.tsx` for the
        argument and `region-rail.tsx` for the drawing. What this card said that
        the rail must not lose is that these two numbers are *two measurements*
        and not a division of one: that sentence is `observed.splitNote`, and it
        is the note the rail prints under its rows in this state.
      */}

      {/*
        The two day figures. Where the forecast stack draws two `BandCard`s,
        this draws two `ObservedCard`s — no strip, no quantile labels, and a
        footnote in each saying that the interval is the part a model would
        have supplied. The peak card is an **energy** in MWh, not a power in
        MW: see `observedDay` in `lib/network.ts`.

        `peakHour === null` is the day that settled with no curtailment in it,
        which is a different sentence from a zero and gets a different card.
      */}
      {/*
        **The day's two figures and the episode list are the hero's now.**

        Both were here, at the bottom of the page. The two figures are about the
        selected region's settled day — the same day the hero's profile draws
        hour by hour — so they sit under it, in the column that already holds
        the day. The episode list went under `Planejado × Realizado`, at the
        centre column's full width, because both are tables a reader scans
        across and a half-width column takes that away.

        Nothing is lost by their absence here: this stack renders only with
        `heroElsewhere`, which is what the prop is for.
      */}
    </>
  );
}
