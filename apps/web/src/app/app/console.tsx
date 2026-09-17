/**
 * The cinematic view: the map takes the window, the figures float over it, and
 * the day runs underneath.
 *
 * ## What it is for
 *
 * Every other screen is a **document** — a measured column of panels a reader
 * works down. This one is a **scene**. It answers one question, "where and when
 * did the grid curtail today", and it answers it by showing rather than by
 * listing: the four regions light by hour, and a reader scrubs or presses play.
 *
 * It is built on the SVG map the product already ships rather than on a 3D
 * globe, and that is a decision rather than a stage. A globe buys terrain,
 * altitude and thousands of entities; this has four polygons whose boundaries
 * are *electrical* and deliberately do not follow the geographic ones — the one
 * fact a satellite basemap would actively obscure. If the layout earns its keep
 * the map component can be swapped underneath it; the reverse, building the
 * dependency first and the layout after, buys a token and a 3 MB bundle before
 * anybody knows whether the screen works.
 *
 * ## Everything on it is measured
 *
 * There is no forecast here at all. The hour, the colour, the totals and the
 * peak are settled rows from `/v1/curtailment/hours`, and the scale compares
 * the four against the largest single-subsystem hour rather than against the
 * national total — the comparison the map exists for is between regions.
 *
 * A day with no curtailment says so. It does not render an empty scene and let
 * a reader conclude the data failed.
 */

import { SUBSYSTEM_DISPLAY_ORDER } from "@wattsteer/core";
import { layout, Panel, radius, space, type, usePalette } from "@wattsteer/ui";
import Head from "expo-router/head";
import { useState } from "react";
import { Platform, Text, View } from "react-native";
import { AppShell } from "@/components/app/app-shell";
import { DayTimeline } from "@/components/app/console/day-timeline";
import { useDayMatrix } from "@/components/app/console/use-day-matrix";
import { ReadingState } from "@/components/app/thinking-orb";
import { useAppParams } from "@/components/app/use-app-params";
import { SubsystemMap } from "@/components/charts/subsystem-map";
import { DOCK_WIDTH } from "@/components/voice/use-voice-agent";
import { useCopy, useFormat } from "@/i18n";
import type { SubsystemCode } from "@/lib/fixtures";
import { subsystemMeta } from "@/lib/fixtures";

/** `YYYY-MM-DD` plus `days`, via UTC so the arithmetic carries no zone. */
function shiftDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/**
 * Below this the panels stop floating and stack under the map.
 *
 * A panel over a map is only readable while there is map left beside it. On a
 * phone there is not: a floating card covers the thing it annotates, and the
 * reader loses both. Measured on the content column rather than the window,
 * like the hero's.
 */
const FLOAT_ABOVE = 900;

/** `BRAZIL_VIEWBOX.height / width`. The map is nearly square. */
const MAP_ASPECT = 972 / 1000;

/**
 * Room kept clear for the voice dock, which is `fixed` over this corner.
 *
 * `DOCK_WIDTH` plus its inset twice — the gap from the edge and the gap from
 * whatever it would otherwise sit on. Read from the dock's own constant rather
 * than guessed, so moving the dock moves this.
 */
const DOCK_CLEARANCE = DOCK_WIDTH + 40;

/**
 * Room under the page when the dock spans it.
 *
 * Below `DOCK_NARROW_BREAKPOINT` the dock takes both insets and becomes a bar,
 * so the clearance is vertical rather than horizontal.
 */
const DOCK_STACKED_CLEARANCE = 96;

export default function GridConsoleScreen() {
  const colors = usePalette();
  const copy = useCopy();
  const f = useFormat();
  const params = useAppParams();
  /*
    Two days back from the **selected** target day, which is the offset
    `use-network.ts` uses and the reason it gives: ONS publishes the restriction
    detail a day or more behind, so asking about yesterday returns an empty
    table and an empty table reads as "nothing was curtailed", which is a claim.

    Derived rather than computed from `new Date()`, so this screen is looking at
    the same day as every other one — a console on a different day from the
    Overview beside it is two products.
  */
  const date = shiftDays(params.date, -2);
  const matrix = useDayMatrix(date);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [hovered, setHovered] = useState<SubsystemCode | null>(null);
  const [width, setWidth] = useState(0);
  /*
    The map is bounded by **height** as well as width, and only the second is
    obvious. Brazil's viewBox is 1000 × 972, so a map given 760px of width takes
    739 of height — which at 1000px of viewport put the timeline 75px below the
    fold, on the screen whose whole point is that the timeline is under the map.
    A cinematic layout that scrolls is a dashboard with extra steps.
  */
  const [stageHeight, setStageHeight] = useState(0);
  const floating = width >= FLOAT_ABOVE;

  const frame = (body: React.ReactNode) => (
    <>
      <Head>
        <title>{copy.app.console.metaTitle}</title>
        <meta name="robots" content="noindex,follow" />
      </Head>
      <AppShell bleed={true}>
        <View
          onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
          // `minHeight: 0` so this can be smaller than its content: a flex
          // child's default floor is its content size, which is what lets a map
          // push a timeline off the bottom of the box meant to contain both.
          style={{
            flex: 1,
            minHeight: 0,
            padding: space.lg,
            gap: space.lg,
            /*
              Room under the last panel for the dock, which goes full width at
              this size and would otherwise sit on the timeline's play control —
              the one target on the screen a reader reaches for first.
            */
            paddingBottom: floating ? space.lg : DOCK_STACKED_CLEARANCE,
          }}
        >
          {body}
        </View>
      </AppShell>
    </>
  );

  if (matrix.status === "reading") {
    return frame(<ReadingState title={copy.app.console.readingTitle} />);
  }
  if (matrix.status === "refused") {
    return frame(
      <Text style={{ ...type.body, color: colors.inkMuted, textAlign: "center" }}>
        {copy.app.console.refusedTitle}
      </Text>,
    );
  }
  if (matrix.hours.length === 0) {
    // A measurement, not a missing number — the distinction this product makes
    // everywhere and the one a blank scene would destroy.
    return frame(
      <Text style={{ ...type.body, color: colors.inkMuted, textAlign: "center" }}>
        {copy.app.console.emptyDay}
      </Text>,
    );
  }

  const hour = matrix.hours[Math.min(index, matrix.hours.length - 1)];
  const rows = SUBSYSTEM_DISPLAY_ORDER.map((code) => ({
    subsystem: code,
    onsDisplayName: subsystemMeta(code).onsDisplayName,
    last24hMwh: hour?.mwh[code] ?? 0,
    /*
      The split is not carried here and is not invented. `/v1/curtailment/hours`
      publishes at (subsystem, technology, hour) and `observedHours` sums the
      technologies to draw one series — recovering a division from a sum would
      be a ratio nobody measured. The map paints on the total, which is the
      number this screen is about.
    */
    split: { windMwh: 0, solarMwh: 0 },
  }));

  /*
    `observed` paint and never `forecast`. Every figure on this screen is a
    settled row, and the observed ramp is the vocabulary the product uses for
    exactly that — cyan means measured, and it is the same cyan the badge is.
  */
  const paint = { kind: "observed", rows } as const;

  const national = (
    <FloatingCard>
      <Text style={{ ...type.caption, color: colors.inkFaint }}>
        {copy.app.console.nationalLabel}
      </Text>
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: 6 }}>
        <Text
          style={{
            ...type.hero,
            color: colors.ink,
            fontVariant: ["tabular-nums"],
            letterSpacing: -1,
          }}
        >
          {f.compact(hour?.totalMwh ?? 0)}
        </Text>
        <Text style={{ ...type.label, color: colors.inkMuted }}>MWh</Text>
      </View>
      <Text
        style={{ ...type.caption, color: colors.info, fontVariant: ["tabular-nums"] }}
      >
        {`${f.date(matrix.date)} · ${f.hour(hour?.hourLocal ?? 0)}`}
      </Text>
    </FloatingCard>
  );

  const regions = (
    <FloatingCard>
      <Text style={{ ...type.caption, color: colors.inkFaint }}>
        {copy.app.console.hourLabel}
      </Text>
      {rows.map((row) => {
        const selected = row.subsystem === params.subsystem;
        const share = matrix.peakMwh <= 0 ? 0 : row.last24hMwh / matrix.peakMwh;
        return (
          <View key={row.subsystem} style={{ gap: 4, paddingVertical: 4 }}>
            <View
              style={{
                flexDirection: "row",
                justifyContent: "space-between",
                gap: space.sm,
              }}
            >
              <Text
                style={{
                  ...type.caption,
                  color: selected ? colors.accent : colors.inkMuted,
                }}
                numberOfLines={1}
              >
                {subsystemMeta(row.subsystem).short}
              </Text>
              <Text
                style={{
                  ...type.label,
                  color: colors.ink,
                  fontVariant: ["tabular-nums"],
                }}
              >
                {`${f.compact(row.last24hMwh)} MWh`}
              </Text>
            </View>
            <View
              style={{
                height: 3,
                borderRadius: radius.pill,
                backgroundColor: colors.surfaceSunken,
                overflow: "hidden",
              }}
            >
              <View
                style={{
                  width: `${Math.max(1, Math.min(100, share * 100))}%`,
                  height: "100%",
                  backgroundColor: selected ? colors.accent : colors.info,
                }}
              />
            </View>
          </View>
        );
      })}
      <Text style={{ ...type.caption, color: colors.inkFaint, lineHeight: 16 }}>
        {copy.app.console.scaleNote}
      </Text>
    </FloatingCard>
  );

  return frame(
    <>
      <View style={floating ? { flex: 1, minHeight: 0 } : undefined}>
        {/*
          The map fills what is left after the timeline, and the cards sit on
          top of it where there is room. `pointerEvents="box-none"` on the
          overlay so a card catches its own presses and the map keeps every
          other pixel — including the keyboard walk across the four regions,
          which is the one interaction an overlay is most likely to eat.
        */}
        <View
          onLayout={(event) => setStageHeight(event.nativeEvent.layout.height)}
          style={{ flex: 1, alignItems: "center", justifyContent: "center" }}
        >
          <SubsystemMap
            paint={paint}
            selected={params.subsystem}
            hovered={hovered}
            onHoverChange={setHovered}
            onSelect={(code) => params.setParams({ subsystem: code })}
            // The smaller of what the column allows and what the stage's
            // height allows, converted through the viewBox's aspect. `0` while
            // unmeasured falls back to the width budget, so the first frame is
            // a map rather than nothing.
            /*
              Height-bounded **only where the screen is a stage**.

              Floating, the map shares one viewport with a timeline and must
              leave room for it. Stacked, the cards are below the map rather
              than over it and the page scrolls like every other one — and
              applying the cap there made the map 103px wide at 390×844, a
              thumbnail of the thing the screen is about. A constraint that is
              right in one layout is not automatically right in the other.
            */
            maxWidth={
              floating
                ? Math.round(
                    Math.min(
                      760,
                      stageHeight > 0
                        ? stageHeight / MAP_ASPECT
                        : Number.POSITIVE_INFINITY,
                    ),
                  )
                : 420
            }
          />
        </View>

        {floating ? (
          <View
            pointerEvents="box-none"
            style={{
              ...(Platform.OS === "web" ? ({ position: "absolute" } as object) : null),
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              flexDirection: "row",
              alignItems: "flex-start",
              justifyContent: "space-between",
              gap: space.lg,
            }}
          >
            <View style={{ maxWidth: 280 }}>{national}</View>
            <View style={{ maxWidth: 260 }}>{regions}</View>
          </View>
        ) : null}
      </View>

      {floating ? null : (
        <View style={{ gap: space.md }}>
          {national}
          {regions}
        </View>
      )}

      {/*
        **The dock sits over this corner, so this corner is given up.**

        `VoiceDock` is `position: fixed` at the bottom right with a 20px inset,
        and it is not moving: it is the product's entry point to voice and it
        belongs where a reader expects a dock. What moves is the timeline, which
        stops short of it — measured at 1600px the last two hours of the day
        were under "Pergunte ao WattSteer", which is the worst possible pair of
        hours to lose on a screen about when the grid curtailed.

        Only where it floats. Stacked, the dock is over the page's end rather
        than over this panel.
      */}
      <View
        style={{
          width: "100%",
          maxWidth: layout.page,
          alignSelf: "center",
          paddingRight: floating ? DOCK_CLEARANCE : 0,
        }}
      >
        <Panel>
          <DayTimeline
            hours={matrix.hours}
            index={index}
            onIndex={setIndex}
            playing={playing}
            onPlaying={setPlaying}
          />
        </Panel>
      </View>
    </>,
  );
}

/**
 * A card that reads over a map.
 *
 * Heavier than `Panel`: a panel sits on the canvas and borrows its contrast
 * from it, and this one sits on a shape that changes colour under it. The fill
 * is near-opaque for that reason rather than for taste — a translucent card
 * over a region that has just gone bright is a card whose text drops below
 * contrast on exactly the hour a reader is watching.
 */
function FloatingCard({ children }: { children: React.ReactNode }) {
  const colors = usePalette();
  return (
    <View
      style={{
        gap: 6,
        padding: space.md,
        borderRadius: radius.lg,
        borderCurve: "continuous",
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.surface,
        ...(Platform.OS === "web"
          ? ({
              backdropFilter: "blur(12px)",
              boxShadow: "0 8px 30px rgba(0,0,0,0.45)",
            } as object)
          : null),
      }}
    >
      {children}
    </View>
  );
}
