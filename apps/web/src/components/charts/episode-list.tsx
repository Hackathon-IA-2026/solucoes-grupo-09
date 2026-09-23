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
import {
  ArrowRightIcon,
  focusRing,
  LayersIcon,
  Panel,
  PanelHeader,
  space,
  type,
  usePalette,
} from "@wattsteer/ui";
import { Platform, Pressable, Text, View } from "react-native";
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
  limit,
  onSeeAll,
  seeAllLabel,
  bare = false,
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
  columns: {
    /**
     * The civil day, as its own column.
     *
     * Present only where the window spans more than one — the Overview's
     * fortnight. The Time Machine's episodes are all the day the screen is
     * about, and a column repeating one date on every row is a column that
     * costs width and states nothing.
     *
     * Where it is present, `period` is the **hours** rather than two full
     * instants, and the duration column is dropped — which is only honest
     * because the second hour is the last hour *inside* the episode rather
     * than the wire's exclusive `ended_at`. See {@link lastHourIn}: printed
     * raw, `23:00–02:00` read as four hours for a three-hour run.
     */
    date?: string;
    period: string;
    duration: string;
    /**
     * Which subsystem the run happened in.
     *
     * Present only where the list is not about one. An episode is a run of
     * hours in a single subsystem, so a list covering four is four subsystems'
     * runs interleaved and every row has to say which — the envelope cannot,
     * because it is not about one either.
     */
    region?: string;
    energy: string;
    peak: string;
  };
  /**
   * Caps the rows drawn, with the rest behind `onSeeAll`.
   *
   * The list itself is not truncated — `episodes` is whole, the count in the
   * control is the whole of it, and what the cap changes is how many rows this
   * card spends its height on. A panel that silently dropped rows would be the
   * absence rule broken in the quietest possible way.
   */
  limit?: number;
  /** Opens the whole list. Without it there is no control and no cap. */
  onSeeAll?: () => void;
  seeAllLabel?: string;
  /**
   * Draws the table without the panel's own heading.
   *
   * For the sheet: `Sheet` states the title as the dialog's name and the
   * subtitle as its lede, and the panel inside it was stating both again — two
   * headings 24px apart, and three announcements of one name to a screen
   * reader (the dialog, the scroll region, and the panel's own `h3`).
   *
   * The strings are still required, because the caller that hides the heading
   * is the one that already rendered it, and a component that took them as
   * optional would let a caller drop them from both places at once.
   */
  bare?: boolean;
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
  /*
    The cap applies only where there is somewhere for the rest to go. A `limit`
    with no `onSeeAll` would be a panel quietly dropping rows, which is the
    absence rule broken in the quietest possible way.
  */
  const drawn =
    limit === undefined || onSeeAll === undefined ? episodes : episodes.slice(0, limit);
  return (
    <Panel>
      {bare ? null : (
        <PanelHeader
          icon={<LayersIcon size={18} color={colors.inkMuted} />}
          title={title}
          subtitle={subtitle}
          right={
            onSeeAll === undefined || seeAllLabel === undefined ? undefined : (
              <SeeAll label={seeAllLabel} onPress={onSeeAll} />
            )
          }
        />
      )}
      {episodes.length === 0 ? (
        <Text
          style={{
            marginTop: bare ? 0 : space.lg,
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
          <View role="table" style={{ marginTop: bare ? 0 : space.lg, gap: space.xs }}>
            <View
              role="row"
              style={{
                flexDirection: "row",
                paddingBottom: space.xs,
                borderBottomWidth: 1,
                borderBottomColor: colors.border,
              }}
            >
              {columns.date === undefined ? null : (
                <Heading style={{ flex: 1.1 }} color={colors.inkFaint}>
                  {columns.date}
                </Heading>
              )}
              <Heading
                style={{ flex: columns.date === undefined ? 2.4 : 1.4 }}
                color={colors.inkFaint}
              >
                {columns.period}
              </Heading>
              {columns.region === undefined ? null : (
                <Heading style={{ flex: 0.9 }} color={colors.inkFaint}>
                  {columns.region}
                </Heading>
              )}
              {columns.date === undefined ? (
                <Heading style={{ flex: 1, textAlign: "right" }} color={colors.inkFaint}>
                  {columns.duration}
                </Heading>
              ) : null}
              <Heading style={{ flex: 1.2, textAlign: "right" }} color={colors.inkFaint}>
                {columns.energy}
              </Heading>
              <Heading style={{ flex: 1.1, textAlign: "right" }} color={colors.inkFaint}>
                {columns.peak}
              </Heading>
            </View>
            {drawn.map((episode) => (
              <View
                key={`${episode.subsystem ?? ""}${episode.startedAt}`}
                role="row"
                style={{ flexDirection: "row", alignItems: "baseline" }}
              >
                {columns.date === undefined ? null : (
                  <Cell style={{ flex: 1.1 }} color={colors.ink}>
                    {/*
                      `dateShort`, without the year: this column repeats a date
                      on every row of a fortnight, and four of those characters
                      are the same on all of them. `format.ts` calls it "a date
                      without its year, for a run of days inside one".
                    */}
                    {f.dateShort(brasilia(episode.startedAt).date)}
                  </Cell>
                )}
                <Cell
                  style={{ flex: columns.date === undefined ? 2.4 : 1.4 }}
                  color={columns.date === undefined ? colors.ink : colors.inkMuted}
                >
                  {columns.date === undefined
                    ? `${f.dateTime(episode.startedAt)} → ${f.dateTime(episode.endedAt)}`
                    : `${f.hour(brasilia(episode.startedAt).hour)}–${f.hour(
                        brasilia(lastHourIn(episode.endedAt)).hour,
                      )}`}
                </Cell>
                {columns.region === undefined ? null : (
                  <Cell style={{ flex: 0.9 }} color={colors.inkMuted}>
                    {/*
                      An empty string and not a dash: `subsystem` is optional on
                      the wire, and the only caller that asks for this column is
                      the one whose route stamps it on every row. A dash here
                      would be inventing an absence the schema does not describe.
                    */}
                    {episode.subsystem ?? ""}
                  </Cell>
                )}
                {columns.date === undefined ? (
                  <Cell style={{ flex: 1, textAlign: "right" }} color={colors.inkMuted}>
                    {`${f.number(episode.durationHours)} h`}
                  </Cell>
                ) : null}
                <Cell style={{ flex: 1.2, textAlign: "right" }} color={colors.ink}>
                  {`${f.compact(episode.totalMwh)} MWh`}
                </Cell>
                <Cell style={{ flex: 1.1, textAlign: "right" }} color={colors.inkMuted}>
                  {`${f.number(episode.peakMw)} MW`}
                </Cell>
              </View>
            ))}
          </View>
          {/* An empty note is a screen that carries its footnote elsewhere. */}
          {note === "" ? null : (
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
          )}
        </>
      )}
    </Panel>
  );
}

/**
 * A UTC instant as the **Brasília** civil day and hour it fell in.
 *
 * Both together, from one formatter, because splitting them is how they came
 * apart: the date column was `startedAt.slice(0, 10)` — the *UTC* calendar day
 * — beside an hour converted to São Paulo. An episode starting 22:00 BRT on
 * 9 September rendered as `10 de set. · 22:00`, a date and a wall clock that
 * never co-occurred, and every episode starting 21:00–23:00 BRT was off by a
 * day. `api-routes.md` names this exact mistake: a UTC day is the wrong day by
 * three hours every day of the year.
 *
 * By zone name rather than by a fixed offset: Brazil has abolished daylight
 * saving and could reinstate it, and `-03:00` would be wrong the day it did.
 */
function brasilia(instant: string): { date: string; hour: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
  }).formatToParts(new Date(instant));
  const of = (kind: string) => parts.find((part) => part.type === kind)?.value ?? "";
  return {
    date: `${of("year")}-${of("month")}-${of("day")}`,
    // `en-CA` with `hour12: false` is the h23 cycle, so midnight is 0 and never
    // 24. Checked rather than assumed: `en-US` gives 24 here.
    hour: Number(of("hour")),
  };
}

/**
 * The **last hour inside** the episode, which is not the one the wire carries.
 *
 * `ended_at` is documented as exclusive — "the valid_time of the first hour
 * below threshold" — so a three-hour run at 23:00, 00:00 and 01:00 ends at
 * 02:00. Printed raw beside an inclusive-looking en dash it read `23:00–02:00`:
 * four hours, in a column headed "Período", with the duration column gone from
 * this variant so nothing on the row could contradict it. And it was only
 * sometimes wrong — a one-hour episode read correctly — which is worse than
 * being wrong consistently.
 *
 * One hour back makes the range mean what its punctuation says. A one-hour
 * episode then reads `14:00–14:00`, which is honest and is what an inclusive
 * range of one looks like.
 */
function lastHourIn(endedAt: string): string {
  return new Date(new Date(endedAt).getTime() - 3_600_000).toISOString();
}

/**
 * The control that opens the whole list.
 *
 * A `Pressable` with the product's focus ring rather than a `Link`: what it
 * opens is a sheet in this document, not a route, and a link that goes nowhere
 * is the thing `question-cards.tsx` argues against on the same screen.
 */
function SeeAll({ label, onPress }: { label: string; onPress: () => void }) {
  const colors = usePalette();
  return (
    <Pressable
      accessibilityRole="button"
      aria-haspopup="dialog"
      onPress={onPress}
      style={(state) => {
        const { focused = false } = state as { focused?: boolean };
        return {
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          paddingVertical: 2,
          paddingHorizontal: 4,
          borderRadius: 6,
          ...focusRing(focused, colors.focus, 2),
          ...(Platform.OS === "web" ? ({ cursor: "pointer" } as object) : null),
        };
      }}
    >
      <Text style={{ ...type.caption, fontWeight: "600", color: colors.accent }}>
        {label}
      </Text>
      <ArrowRightIcon size={14} color={colors.accent} />
    </Pressable>
  );
}
