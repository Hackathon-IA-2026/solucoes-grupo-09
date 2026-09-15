/**
 * A run of hours above the threshold, listed.
 *
 * Lifted out of the Time Machine when the Overview needed the same list for a
 * different window: an episode is a read-time view over settled hours, it needs
 * no model, and it is one of the three things `docs/specs/api-surface.md` says
 * the Overview shows when no artifact is promoted. Two spellings of the same
 * list would be two places the threshold could stop being printed.
 *
 * **Every episode carries the parameters that produced it**, and the row prints
 * them. The domain model requires it and the reason is not pedantry: an episode
 * is the run of hours above `threshold_mw` joined across gaps of at most
 * `max_gap_hours`, so both numbers are part of what "an episode" *is*. A list
 * rendered beside a threshold it was not cut with is a list of different
 * things under one name.
 *
 * The words are the caller's. Two screens ask the same question of different
 * windows — one past day on the Time Machine, the last fortnight on the
 * Overview — and a component that owned the subtitle would say "this day" on a
 * panel covering fourteen of them.
 */

import type { CurtailmentEpisode } from "@wattsteer/core/api";
import { LayersIcon, Panel, PanelHeader, space, usePalette } from "@wattsteer/ui";
import { Text, View } from "react-native";
import { useFormat } from "@/i18n";
import { fill } from "@/i18n/format";

export function EpisodeList({
  episodes,
  maxGapHours,
  title,
  subtitle,
  row,
  note,
  empty,
}: {
  episodes: readonly CurtailmentEpisode[];
  maxGapHours: number;
  title: string;
  subtitle: string;
  /** The row template, with `{from} {to} {hours} {mwh} {peak} {mw} {gap}`. */
  row: string;
  /** The footnote template, with `{gap}`. */
  note: string;
  /**
   * What to say when the window held no episode.
   *
   * A sentence and not an empty panel: "no hour in this window went above the
   * threshold" is a finding about the grid, and a panel that renders nothing
   * cannot be told apart from one whose request failed.
   */
  empty: string;
}) {
  const colors = usePalette();
  const f = useFormat();
  return (
    <Panel>
      <PanelHeader
        icon={<LayersIcon size={18} color={colors.inkMuted} />}
        title={title}
        subtitle={subtitle}
      />
      {episodes.length === 0 ? (
        <Text
          style={{
            marginTop: space.lg,
            fontSize: 12,
            lineHeight: 19,
            color: colors.inkMuted,
          }}
        >
          {empty}
        </Text>
      ) : (
        <>
          <View style={{ marginTop: space.lg, gap: space.sm }}>
            {episodes.map((episode) => (
              <Text
                key={episode.startedAt}
                style={{
                  fontSize: 12,
                  lineHeight: 19,
                  color: colors.inkMuted,
                  fontVariant: ["tabular-nums"],
                }}
              >
                {fill(row, {
                  from: f.dateTime(episode.startedAt),
                  to: f.dateTime(episode.endedAt),
                  hours: f.number(episode.durationHours),
                  mwh: f.compact(episode.totalMwh),
                  peak: f.number(episode.peakMw),
                  mw: f.number(episode.thresholdMw),
                  gap: f.number(episode.maxGapHours),
                })}
              </Text>
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
            {fill(note, { gap: f.number(maxGapHours) })}
          </Text>
        </>
      )}
    </Panel>
  );
}
