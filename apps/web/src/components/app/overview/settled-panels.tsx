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
  LayoutDashboardIcon,
  Panel,
  PanelHeader,
  space,
  usePalette,
} from "@wattsteer/ui";
import { Text, View } from "react-native";
import { ObservedBadge, VintageBadge } from "@/components/app/honesty";
import { ObservedSubsystemRow } from "@/components/app/subsystem-row";
import type { ObservedNetwork } from "@/components/app/use-network";
import { EpisodeList } from "@/components/charts/episode-list";
import { ObservedProfile } from "@/components/charts/observed-profile";
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
    <>
      <SettledSubsystemsPanel
        observed={observed}
        subsystem={subsystem}
        onSelect={onSelect}
      />
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

/** A fortnight of episodes, with the parameters that defined them. */
export function EpisodesPanel({ observed }: { observed: ObservedNetwork }) {
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
        columns={copy.app.overview.episodeColumns}
        note={copy.app.overview.episodeNote}
        empty={copy.app.overview.episodesEmpty}
      />
    </FadeIn>
  );
}
