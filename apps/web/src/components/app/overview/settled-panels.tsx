/**
 * The settled section that sits *below* a forecast, and the panels both stacks
 * share.
 *
 * `SettledPanels` is the bottom of the screen on a day that has a forecast:
 * settled figures are worth the same whether or not a model is promoted, and
 * they keep their own section rather than being interleaved with the forecast
 * panels — the adjacency `lib/network.ts` refuses, because a settled number
 * beside a forecast one under a shared heading is how an observation gets read
 * as a prediction.
 *
 * `EpisodesPanel` is exported because `observed-panels.tsx` draws it too.
 *
 * `SettledDayPanel` used to be exported beside it, for the same reason, and is
 * gone: the hourly bars it drew were the same `<ObservedProfile>` the hero
 * already had beside the map, so the page carried one chart twice in both
 * stacks. The hero's copy kept the position and took this panel's furniture —
 * the observed badge, the date and the zero-versus-absent note — rather than
 * the duplicate being left where fewer readers scroll.
 */

import {
  ClockIcon,
  FadeIn,
  LayersIcon,
  Panel,
  PanelHeader,
  Sheet,
  space,
  usePalette,
} from "@wattsteer/ui";
import { useState } from "react";
import { Text, View } from "react-native";
import { VintageBadge } from "@/components/app/honesty";
import type { Scope } from "@/components/app/map/scope-bar";
import { ObservedSubsystemRow } from "@/components/app/subsystem-row";
import type { ObservedNetwork } from "@/components/app/use-network";
import { EpisodeList } from "@/components/charts/episode-list";
import { useCopy, useFormat } from "@/i18n";
import { fill } from "@/i18n/format";
import {
  SUBSYSTEM_DISPLAY_ORDER,
  type SubsystemCode,
  subsystemMeta,
} from "@/lib/fixtures";
import { observedRows } from "@/lib/network";

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
export function SettledPanels({
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
    /*
      **The settled four alone, and the episode list is the hero's now.**

      They were two columns here for one commit. The episode list moved under
      `Planejado × Realizado` in the centre column, at that column's full
      width, because it is a five-column table a reader scans across — and
      keeping half a row here would have left this panel beside a gap.
    */
    <SettledSubsystemsPanel
      observed={observed}
      subsystem={subsystem}
      onSelect={onSelect}
    />
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
 * A fortnight of episodes, following the map's scope like everything else.
 *
 * **The list is filtered, never aggregated, and that distinction is why this
 * panel may answer `SIN Geral` at all.** An episode is a measured run of
 * settled hours in one subsystem; choosing which rows to draw is a selection,
 * and four subsystems' runs sitting in one list is a concatenation. Neither
 * invents a figure, which is exactly what a national *band* would have done —
 * see `honesty.md`. The gateway reads all four in one query and this picks.
 *
 * Half the width, because at full width a five-column table of a dozen rows
 * left two thirds of the line empty and pushed everything after it a screen
 * further down. The rest of the fortnight is behind `Ver todos`, in a sheet:
 * the card spends its height on what is recent and the whole list is one press
 * away, rather than the panel deciding for the reader that the fourteenth
 * episode is not worth having.
 */
export function EpisodesPanel({
  observed,
  scope,
  subsystem,
}: {
  observed: ObservedNetwork;
  /** `sin` draws all four; `region` draws the selected one. The map's filter. */
  scope: Scope;
  subsystem: SubsystemCode;
}) {
  const colors = usePalette();
  const copy = useCopy();
  const f = useFormat();
  const [open, setOpen] = useState(false);
  const read = observed.episodes;

  /*
    **A refusal, and not the empty sentence.**

    `read === null` is the episodes route having refused — the screen goes on
    without it, which is the point of catching it — and rendering the list with
    no rows would print "no hour in this window went above the threshold",
    which is a finding about the grid stated from a measurement nobody has.
    Those are the two states `honesty.md` says an empty list must be told
    apart into, and this is the one that says so.
  */
  if (read === null) {
    return (
      <FadeIn delay={210}>
        <Panel>
          <PanelHeader
            icon={<LayersIcon size={18} color={colors.inkMuted} />}
            title={copy.app.overview.episodesTitle}
            subtitle={copy.app.overview.episodesRefusedSubtitle}
          />
          <Text
            style={{
              marginTop: space.lg,
              fontSize: 12,
              lineHeight: 19,
              color: colors.inkMuted,
            }}
          >
            {copy.app.overview.episodesRefused}
          </Text>
        </Panel>
      </FadeIn>
    );
  }
  /*
    How many rows the card spends its height on. Four fits beside the day
    panels without the section growing a scroll of its own, and the rest are
    not dropped: the control beside the heading states the whole count and
    opens the whole list. Local, because a `.tsx` exports components and
    nothing else (ADR-0002) and this is nobody else's number.
  */
  const onTheCard = 4;

  /*
    The filter leans on `subsystem` being on every row, which is optional on the
    wire and which this route always stamps — `database-curtailment.test.ts`
    holds it, in both directions, against a fixture that puts an episode in S at
    an hour NE also has. It matters because the failure would be quiet: rows
    missing the field would drop out here and the panel would say no hour went
    above the threshold, which is a finding about the grid rather than about a
    missing key.
  */
  const all =
    scope === "sin"
      ? read.episodes
      : read.episodes.filter((episode) => episode.subsystem === subsystem);
  /*
    Newest first here, and chronological on the wire. The order is a rendering
    decision — the gateway sorts ascending because the Time Machine reads a day
    forwards — and "Episódios recentes" is a claim about recency that a list
    starting a fortnight ago does not make.

    A `reverse()` would have done it, and did, wrongly: the gateway's order is
    `started_at, subsystem`, so reversing the whole list also reversed the
    subsystem tiebreak and four regions that started the same hour came out
    S, SE, NE, N — the display order backwards, on the one screen that prints
    those four codes everywhere else north to south. Only the time is reversed.
  */
  const episodes = [...all].sort((a, b) =>
    a.startedAt === b.startedAt
      ? SUBSYSTEM_DISPLAY_ORDER.indexOf(a.subsystem as SubsystemCode) -
        SUBSYSTEM_DISPLAY_ORDER.indexOf(b.subsystem as SubsystemCode)
      : b.startedAt.localeCompare(a.startedAt),
  );

  const window = {
    from: f.date(read.from.slice(0, 10)),
    to: f.date(read.to.slice(0, 10)),
    mw: f.number(read.thresholdMw),
  };
  const subtitle =
    scope === "sin"
      ? fill(copy.app.overview.episodesSubtitleAll, window)
      : fill(copy.app.overview.episodesSubtitle, {
          ...window,
          subsystem: subsystemMeta(subsystem).onsDisplayName,
        });
  // "no hour went above the threshold **in this subsystem**" is a different
  // finding from "in any of the four", and the panel that can be either has to
  // say which it is.
  const empty =
    scope === "sin"
      ? copy.app.overview.episodesEmptyAll
      : copy.app.overview.episodesEmpty;
  /*
    The region column exists only where the list is about more than one. In the
    region scope every row would carry the same three letters, which is a column
    that costs width and states nothing — the same argument that keeps the date
    off the Time Machine's copy of this table.
  */
  const columns =
    scope === "sin"
      ? copy.app.overview.episodeColumns
      : { ...copy.app.overview.episodeColumns, region: undefined };

  return (
    <FadeIn delay={210}>
      {/*
        No width of its own: the two-column row in `SettledPanels` owns it. It
        carried `maxWidth: layout.page / 2` for one commit, which is a
        half-width card alone in a vertical stack — half a card, not half a
        layout, with the other half empty beside it.
      */}
      <EpisodeList
        episodes={episodes}
        maxGapHours={read.maxGapHours}
        title={copy.app.overview.episodesTitle}
        subtitle={subtitle}
        columns={columns}
        note={copy.app.overview.episodeNote}
        empty={empty}
        limit={onTheCard}
        onSeeAll={episodes.length > onTheCard ? () => setOpen(true) : undefined}
        seeAllLabel={
          episodes.length > onTheCard
            ? fill(copy.app.overview.episodesSeeAll, {
                count: f.number(episodes.length),
              })
            : undefined
        }
      />

      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title={copy.app.overview.episodesTitle}
        lede={subtitle}
        closeLabel={copy.app.shell.closeSheet}
      >
        {/*
          The same component, uncapped, with no control and no heading of its
          own — `Sheet` has already stated both, as the dialog's name and its
          lede. A second spelling of this table would be a second place the
          threshold could stop being printed, which is the argument
          `episode-list.tsx` opens with.
        */}
        <EpisodeList
          bare={true}
          episodes={episodes}
          maxGapHours={read.maxGapHours}
          title={copy.app.overview.episodesTitle}
          subtitle={subtitle}
          columns={columns}
          note={copy.app.overview.episodeNote}
          empty={empty}
        />
      </Sheet>
    </FadeIn>
  );
}
