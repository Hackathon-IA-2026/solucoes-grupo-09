/**
 * **A mockup.** The four subsystems as one screen, with the map at the centre
 * and everything the product knows about the selected region arranged around
 * it. Reachable at `/app/console`, linked from nothing, and on its own branch.
 *
 * ## What it is trying to settle
 *
 * `/app` answers three questions down a single 13 000px scroll. That is honest
 * and it is also a lot of scrolling for a screen whose subject — four regions
 * of one grid — is small enough to fit in a glance. The reference dashboards
 * this is modelled on put a map in the middle and read everything else off the
 * edges, and the question worth answering is whether that shape suits a
 * product with **four** regions rather than four hundred cities.
 *
 * ## Where it departs from the reference, deliberately
 *
 * Those dashboards are beautiful and they are lying. Eight-digit readouts over
 * invented geography, glowing arcs between cities that have no relationship,
 * hexbins whose density means nothing. Every number on them is a single
 * confident figure.
 *
 * This product's whole claim is the opposite: a forecast is an interval and a
 * settlement is a measurement, and neither is ever dressed as the other. So
 * the console borrows the *layout* and none of the certainty. Every figure it
 * draws is drawn by a component the product already ships — `BandStrip` for an
 * interval, `ObservedProfile` for a settled day, `RiskChip` for a risk class —
 * and where there is no band it says why rather than drawing one.
 *
 * Two consequences worth seeing before judging the idea:
 *
 *  - **With nothing published it is mostly settled data**, because that is what
 *    production has. A console that only looks good with a forecast is a demo.
 *  - **Four regions is not a lot of marks.** The reference's density comes from
 *    hundreds of points; ours has four, so the map is larger and calmer and the
 *    rails carry the detail. Whether that reads as spacious or as empty is
 *    exactly what this is for.
 *
 * Nothing else imports this file, and the voice provider and briefing host are
 * untouched — it mounts under the same `/app` layout, so the dock and the
 * agent work here as they do everywhere else.
 */

import { SUBSYSTEM_DISPLAY_ORDER } from "@wattsteer/core";
import { layout, Panel, space, type, usePalette } from "@wattsteer/ui";
import Head from "expo-router/head";
import { useState } from "react";
import { Text, View } from "react-native";
import { AppShell, ScreenTitle } from "@/components/app/app-shell";
import { CONSOLE_COPY } from "@/components/app/console/console-copy";
import { ConsoleRegion, ConsoleStat } from "@/components/app/console/console-stat";
import { ForecastStamp, HonestyNote, ObservedStamp } from "@/components/app/honesty";
import { ReadingState } from "@/components/app/thinking-orb";
import { gateProfileOf, useAppParams } from "@/components/app/use-app-params";
import { useNetwork } from "@/components/app/use-network";
import { ObservedProfile } from "@/components/charts/observed-profile";
import { RiskChip } from "@/components/charts/risk-class";
import { SubsystemMap } from "@/components/charts/subsystem-map";
import { ObservedSplitPanel } from "@/components/charts/technology-split";
import { useCopy, useFormat, useI18n } from "@/i18n";
import type { SubsystemCode } from "@/lib/fixtures";
import { subsystemMeta } from "@/lib/fixtures";
import { forecastRow, observedDay, observedRows, outlookRows } from "@/lib/network";

/**
 * The width at which the rails move beside the map rather than under it.
 *
 * Read from the content column rather than the window: the shell centres its
 * page at `layout.page`, so a window query would put rails beside a map on a
 * 1200px viewport whose content column is 1160 and not on a 1100px one whose
 * column is the same. The map is the thing that must not be squeezed.
 */
const RAILS_BESIDE_MAP = 980;

export default function GridConsoleScreen() {
  const colors = usePalette();
  const copy = useCopy();
  const f = useFormat();
  const { locale } = useI18n();
  const params = useAppParams();
  const text = CONSOLE_COPY[locale === "en" ? "en" : "pt"];
  const state = useNetwork({
    subsystem: params.subsystem,
    targetDate: params.date,
    gateProfile: gateProfileOf(params.run),
  });
  const [hovered, setHovered] = useState<SubsystemCode | null>(null);
  const [width, setWidth] = useState(0);
  const wide = width >= RAILS_BESIDE_MAP;

  const frame = (right: React.ReactNode, body: React.ReactNode) => (
    <>
      <Head>
        <title>{`${text.title} — WattSteer`}</title>
        <meta name="robots" content="noindex,follow" />
      </Head>
      <AppShell>
        <View onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
          <ScreenTitle
            title={text.title}
            lede={state.status === "read" ? text.ledeForecast : text.ledeObserved}
            right={right}
          />
        </View>
        {body}
      </AppShell>
    </>
  );

  if (state.status === "reading") {
    return frame(null, <ReadingState title={copy.app.overview.readingTitle} />);
  }

  if (state.status === "refused") {
    return frame(
      null,
      <HonestyNote
        title={text.refusedTitle}
        tone="warning"
        points={[copy.error[state.code], copy.app.overview.refusedNote]}
      />,
    );
  }

  const observed = state.observed;
  const forecast = state.status === "read" ? state.forecast : null;
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

  const headline = (
    <Panel style={{ gap: space.lg }}>
      <ConsoleStat
        label={text.totalLabel}
        value={selectedRow === null ? day.totalMwh : selectedRow.dailyEnergy.p50}
        unit="MWh"
        note={selectedRow === null ? text.totalNoteObserved : text.totalNoteForecast}
        band={selectedRow?.dailyEnergy}
      />
      {selectedRow === null ? (
        <Text style={{ ...type.caption, color: colors.inkFaint }}>{text.noBand}</Text>
      ) : null}
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
  const split = (
    <ObservedSplitPanel
      split={observed.daySplit}
      // The settled day's two settlements, always — `daySplit` is that day's
      // wind and solar, not the rail's rolling 24 hours. Passing the rail's
      // window here would have put the wrong one under the right numbers.
      window={text.totalNoteObserved}
      emphasis={params.technology}
    />
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
        <ConsoleRegion
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

  return frame(
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
          {split}
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
        </Panel>
        {wide ? null : headline}
        {wide ? null : rail}
        {wide ? null : profile}
        {wide ? null : split}
      </View>

      {wide ? (
        <View style={{ flexBasis: 300, flexGrow: 1, flexShrink: 1 }}>{rail}</View>
      ) : null}
    </View>,
  );
}
