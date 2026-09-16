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

/** A column heading: small, faint, and never a number. */
function Heading({
  children,
  style,
  color,
}: {
  children: string;
  style?: object;
  color: string;
}) {
  return (
    <Text role="columnheader" style={[{ fontSize: 11, fontWeight: "600", color }, style]}>
      {children}
    </Text>
  );
}

/**
 * One cell. `tabular-nums` everywhere, including the period, which is dates.
 *
 * **`role="cell"` is not decoration here, it is what makes the row legal.** The
 * rows above declare `role="row"`, and a `row` whose children have no role is
 * an `aria-required-children` violation — axe rates it *critical*, WCAG 2 A,
 * and it fired three times on this panel: the header row was fine because
 * `Heading` already carried `columnheader`, and the three body rows announced
 * themselves as rows containing nothing a row may contain. A screen reader in
 * table mode finds no cells to move between.
 */
function Cell({
  children,
  style,
  color,
}: {
  children: string;
  style?: object;
  color: string;
}) {
  return (
    <Text
      role="cell"
      style={[
        { fontSize: 12, lineHeight: 20, color, fontVariant: ["tabular-nums"] },
        style,
      ]}
    >
      {children}
    </Text>
  );
}

export function EpisodeList({
  episodes,
  maxGapHours,
  title,
  subtitle,
  columns,
  note,
  empty,
}: {
  episodes: readonly CurtailmentEpisode[];
  maxGapHours: number;
  title: string;
  subtitle: string;
  /**
   * The four column headings.
   *
   * **This replaced a one-sentence row template**, and the reason is worth
   * keeping. Every episode printed as
   * `{from} → {to} · {hours} h · {mwh} MWh · pico {peak} MW · acima de {mw} MW,
   * lacunas ≤ {gap} h` — so a fortnight of episodes was a wall of identical
   * prose in which the two figures that actually differ between rows, the
   * energy and the peak, sat sixth and seventh in a sentence. Nothing could be
   * compared down a column because there were no columns.
   *
   * The threshold and the gap tolerance came off the rows entirely: they are
   * constants of the cut, identical on every line, and they are already printed
   * once in this panel's subtitle and once in its footnote. The docstring's
   * rule — that an episode is never shown beside a threshold it was not cut
   * with — is satisfied by the panel, which is where a per-panel constant
   * belongs, and repeating it per row was what made the list unreadable.
   */
  columns: { period: string; duration: string; energy: string; peak: string };
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
          {/*
            A table, and the numeric columns are right-aligned on
            `tabular-nums`. That pair is the whole of why a column can be
            scanned: equal-width digits put the units, tens and hundreds of
            every row on the same vertical, so the eye compares magnitudes
            without reading a single figure. Left-aligned or proportional and it
            is a list again, whatever the borders say.
          */}
          <View role="table" style={{ marginTop: space.lg, gap: space.xs }}>
            <View
              role="row"
              style={{
                flexDirection: "row",
                paddingBottom: space.xs,
                borderBottomWidth: 1,
                borderBottomColor: colors.border,
              }}
            >
              <Heading style={{ flex: 2.4 }} color={colors.inkFaint}>
                {columns.period}
              </Heading>
              <Heading style={{ flex: 1, textAlign: "right" }} color={colors.inkFaint}>
                {columns.duration}
              </Heading>
              <Heading style={{ flex: 1.2, textAlign: "right" }} color={colors.inkFaint}>
                {columns.energy}
              </Heading>
              <Heading style={{ flex: 1.1, textAlign: "right" }} color={colors.inkFaint}>
                {columns.peak}
              </Heading>
            </View>
            {episodes.map((episode) => (
              <View
                key={episode.startedAt}
                role="row"
                style={{ flexDirection: "row", alignItems: "baseline" }}
              >
                <Cell style={{ flex: 2.4 }} color={colors.ink}>
                  {`${f.dateTime(episode.startedAt)} → ${f.dateTime(episode.endedAt)}`}
                </Cell>
                <Cell style={{ flex: 1, textAlign: "right" }} color={colors.inkMuted}>
                  {`${f.number(episode.durationHours)} h`}
                </Cell>
                <Cell style={{ flex: 1.2, textAlign: "right" }} color={colors.ink}>
                  {`${f.compact(episode.totalMwh)} MWh`}
                </Cell>
                <Cell style={{ flex: 1.1, textAlign: "right" }} color={colors.inkMuted}>
                  {`${f.number(episode.peakMw)} MW`}
                </Cell>
              </View>
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
