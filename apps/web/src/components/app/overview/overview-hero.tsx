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
import { Panel, space, type, usePalette } from "@wattsteer/ui";
import { useState } from "react";
import { Text, View } from "react-native";
import type { AppParams } from "@/components/app/params";
import { SelectedRegion } from "@/components/app/selected-region";
import type { ForecastNetwork, ObservedNetwork } from "@/components/app/use-network";
import { FanChart } from "@/components/charts/fan-chart";
import { ObservedProfile } from "@/components/charts/observed-profile";
import { RiskChip } from "@/components/charts/risk-class";
import { SubsystemMap } from "@/components/charts/subsystem-map";
import { SplitTracks } from "@/components/charts/technology-split";
import { useCopy, useFormat, useI18n } from "@/i18n";
import { fill } from "@/i18n/format";
import { criticalWindow } from "@/lib/critical-window";
import type { SubsystemCode } from "@/lib/fixtures";
import { subsystemMeta } from "@/lib/fixtures";
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
        chip: <RiskChip probability={row.occurrenceProbability} />,
      }))
    : observedRows(observed.now.subsystems, SUBSYSTEM_DISPLAY_ORDER).map((row) => ({
        code: subsystemMeta(row.subsystem).short,
        subsystem: row.subsystem,
        name: row.onsDisplayName,
        value: row.last24hMwh,
        chip: undefined,
      }));

  const largest = Math.max(...regions.map((row) => row.value), 1e-6);
  const national = regions.reduce((sum, row) => sum + row.value, 0);
  const mine = regions.find((row) => row.subsystem === observed.subsystem);
  const selectedRow = forecast === null ? null : forecastRow(forecast.forecast);

  /*
    The hours to act in. `null` where no hour of the day is more likely to
    curtail than not, which is an answer and not a gap — the card simply does
    not claim a window it does not have.
  */
  const window =
    forecast === null ? null : criticalWindow(forecastHours(forecast.forecast));

  const headline = (
    <Panel style={{ gap: space.lg }}>
      <HeroStat
        label={text.totalLabel}
        value={selectedRow === null ? day.totalMwh : selectedRow.dailyEnergy.p50}
        unit="MWh"
        note={selectedRow === null ? text.totalNoteObserved : text.totalNoteForecast}
        band={selectedRow?.dailyEnergy}
      />
      {selectedRow === null ? (
        <Text style={{ ...type.caption, color: colors.inkFaint }}>{text.noBand}</Text>
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
        **Question 4 of the operator brief, said rather than drawn.**

        The fan has carried these hours since the screen was built, and a reader
        could always find them by seeing where the band lifts off the axis.
        Reading a shape is work, and it is the same work every morning. This is
        the sentence.

        Only where there is a forecast: a settled day's window is a fact about
        yesterday and the question is about tomorrow. The observed state already
        says its largest hour in the profile beside this.
      */}
      {window === null ? null : (
        <View style={{ gap: 2 }}>
          <Text style={{ ...type.caption, color: colors.inkFaint }}>
            {copy.app.overview.windowLabel}
          </Text>
          <Text style={{ ...type.h3, color: colors.ink }}>
            {fill(copy.app.overview.windowRange, {
              from: String(window.fromHour),
              to: String(window.toHour),
            })}
          </Text>
          <Text style={{ ...type.caption, color: colors.inkMuted }}>
            {fill(copy.app.overview.windowPeak, {
              peak: String(window.peakHour),
              mwh: f.compact(window.peakMwh),
            })}
          </Text>
          {/*
            The count, and only when it disagrees with the range. A day whose
            qualifying hours are exactly the run needs no footnote; a day with
            nine scattered hours reported as a three-hour window does, or the
            summary is quietly standing in for the day.
          */}
          {window.hoursInDay > window.toHour - window.fromHour + 1 ? (
            <Text style={{ ...type.caption, color: colors.inkFaint, lineHeight: 17 }}>
              {fill(copy.app.overview.windowScattered, {
                hours: String(window.hoursInDay),
              })}
            </Text>
          ) : null}
        </View>
      )}
      {/*
        **Question 5, and the date is part of the answer.**

        The brief asks for a *likely* cause. There is no such model, so this is
        the reason ONS settled for the last published day, carrying that day's
        date. Without the date it would sit beside tomorrow's band and be read
        as a forecast of cause — which is the one reading the product cannot
        support and would not survive being asked about.
      */}
      {observed.dominantReason === null ? null : (
        <View style={{ gap: 2 }}>
          <Text style={{ ...type.caption, color: colors.inkFaint }}>
            {copy.app.overview.causeLabel}
          </Text>
          <Text style={{ ...type.label, color: colors.ink }}>
            {fill(copy.app.overview.causeSentence, {
              // The code, untranslated, exactly as Explicar renders it: REL, CNF,
              // ENE and PAR are ONS's vocabulary and a translated one would
              // match nothing an operator can look up.
              reason: observed.dominantReason.reason,
              share: f.percent(observed.dominantReason.share, 0),
              date: f.date(observed.hoursDate),
            })}
          </Text>
          <Text style={{ ...type.caption, color: colors.inkFaint, lineHeight: 17 }}>
            {copy.app.overview.causeNote}
          </Text>
        </View>
      )}
      <View
        style={{
          borderTopWidth: 1,
          borderTopColor: colors.border,
          paddingTop: space.md,
          gap: 4,
        }}
      >
        <Text style={{ ...type.caption, color: colors.inkFaint }}>
          {`${meta.onsDisplayName} · ${text.ofNational}`}
        </Text>
        <Text
          style={{
            ...type.h3,
            color: colors.ink,
            fontVariant: ["tabular-nums"],
          }}
        >
          {national <= 0 ? "—" : f.percent((mine?.value ?? 0) / national, 1)}
        </Text>
      </View>
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
  const nationalPanel =
    forecast === null ? (
      <ObservedNationalPanel national={observed.now.national} window={window24h} />
    ) : (
      <NationalFigureBlock national={forecast.outlook.national} />
    );

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
        />
      ))}
      <Text style={{ ...type.caption, color: colors.inkFaint, paddingTop: space.xs }}>
        {text.pickHint}
      </Text>
    </Panel>
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
      {nationalPanel}
      <View
        style={{
          flexDirection: wide ? "row" : "column",
          alignItems: "stretch",
          gap: space.xl,
        }}
      >
        {/*
        Left rail, then map, then right rail on a wide screen; map first when
        stacked. The map leads on a phone because it is the thing that makes
        the rest legible — a list of four numbers with no map above it is the
        Overview's rows without the Overview's map.
      */}
        {wide ? (
          <View style={{ flexBasis: 300, flexGrow: 1, flexShrink: 1, gap: space.xl }}>
            {headline}
            {profile}
          </View>
        ) : null}

        <View
          style={{
            flexBasis: wide ? 520 : "auto",
            flexGrow: 1.4,
            flexShrink: 1,
            gap: space.lg,
          }}
        >
          <Panel style={{ gap: space.md, alignItems: "stretch" }}>
            <SubsystemMap
              paint={paint}
              selected={params.subsystem}
              hovered={hovered}
              onHoverChange={setHovered}
              onSelect={(code) => params.setParams({ subsystem: code })}
              // The point of the layout: a map with room to be looked at. 380 is
              // what it takes in a column beside four panels; here it is the
              // subject rather than a figure.
              maxWidth={wide ? 680 : 440}
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
          <View style={{ flexBasis: 300, flexGrow: 1, flexShrink: 1 }}>{rail}</View>
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
