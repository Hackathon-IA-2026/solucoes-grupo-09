/**
 * Timezone normalisation for ONS timestamps.
 *
 * `din_instante` carries no timezone in any ONS dataset and is documented
 * nowhere; it was established empirically to be Brasília *local civil time* —
 * DST-aware before 2019, effectively fixed UTC−3 from 2019-02-17 onward
 * (`docs/research/ons-datasets.md` § Timezone). So it is parsed with the full
 * IANA zone rather than a fixed offset, and the two things a fixed offset
 * cannot express — a local time that never happened, and one that happened
 * twice — become explicit outcomes rather than a silent three-hour error.
 */

/** ONS's local civil time zone. Never a fixed offset — see the module note. */
export const ONS_TIME_ZONE = "America/Sao_Paulo";

/** A naive wall-clock reading, with no zone attached. */
export interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/**
 * The three things a local wall clock can mean. `gap` and `ambiguous` are the
 * DST transitions; ONS handles both lossily and differently per dataset, so the
 * adapter must decide what to do rather than be handed a plausible instant.
 */
export type ZonedInstant =
  | { kind: "ok"; instant: Date }
  | { kind: "gap" }
  | { kind: "ambiguous"; instants: [Date, Date] };

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/** The wall clock a given instant shows in `timeZone`, as a UTC-epoch reading. */
function wallClockEpoch(instant: number, timeZone: string): number {
  const parts = formatterFor(timeZone).formatToParts(new Date(instant));
  const read = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? "0");
  // Intl renders midnight as hour 24 in some engines; Date.UTC normalises it.
  return Date.UTC(
    read("year"),
    read("month") - 1,
    read("day"),
    read("hour"),
    read("minute"),
    read("second"),
  );
}

/**
 * The wall clock an instant shows in `timeZone`.
 *
 * The inverse of `zonedWallClockToUtc`, and unambiguous in the direction it
 * runs: every instant shows exactly one wall clock, where a wall clock may
 * name no instant or two. Exported because an adapter that has to say which
 * local civil day an instant belongs to — the ONS programme's reference day is
 * one — must not reach for a fixed −3 offset to find out.
 */
export function zonedWallClock(
  instant: Date,
  timeZone: string = ONS_TIME_ZONE,
): WallClock {
  const local = new Date(wallClockEpoch(instant.getTime(), timeZone));
  return {
    year: local.getUTCFullYear(),
    month: local.getUTCMonth() + 1,
    day: local.getUTCDate(),
    hour: local.getUTCHours(),
    minute: local.getUTCMinutes(),
    second: local.getUTCSeconds(),
  };
}

/** Zone offset in ms at a given instant (positive east of Greenwich). */
function offsetAt(instant: number, timeZone: string): number {
  return wallClockEpoch(instant, timeZone) - instant;
}

/**
 * Resolve a naive wall clock in `timeZone` to a UTC instant.
 *
 * Two candidate instants are tested — one using the offset in force a day
 * before the reading and one using the offset a day after it — because exactly
 * those two can render the requested wall clock. Neither matching means the
 * local time never existed (spring forward); both matching means it existed
 * twice (fall back). Probing a day either side rather than at the reading
 * itself is what makes the second candidate distinct across a transition.
 */
export function zonedWallClockToUtc(
  wall: WallClock,
  timeZone: string = ONS_TIME_ZONE,
): ZonedInstant {
  const naive = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute,
    wall.second,
  );
  const before = offsetAt(naive - MS_PER_DAY, timeZone);
  const after = offsetAt(naive + MS_PER_DAY, timeZone);
  const candidates = [...new Set([naive - before, naive - after])].filter(
    (candidate) => wallClockEpoch(candidate, timeZone) === naive,
  );

  if (candidates.length === 0) {
    return { kind: "gap" };
  }
  if (candidates.length === 1) {
    return { kind: "ok", instant: new Date(candidates[0] as number) };
  }
  const ordered = candidates.sort((a, b) => a - b);
  return {
    kind: "ambiguous",
    instants: [new Date(ordered[0] as number), new Date(ordered[1] as number)],
  };
}

const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;

/** Parse ONS's `YYYY-MM-DD HH:MM:SS` wall clock. Null when it is not one. */
export function parseWallClock(value: string): WallClock | null {
  const match = TIMESTAMP.exec(value.trim());
  if (!match) {
    return null;
  }
  const [, year, month, day, hour, minute, second] = match;
  return {
    year: Number(year),
    month: Number(month),
    day: Number(day),
    hour: Number(hour),
    minute: Number(minute),
    second: Number(second ?? "0"),
  };
}

/**
 * Read a Parquet `din_instante` back as the wall clock it actually is.
 *
 * The Parquet files store `din_instante` as INT96, which every reader
 * materialises as an epoch instant — so the same wall clock that the CSV gives
 * as a naive string arrives here as a `Date` whose *UTC* fields are the
 * Brasília reading. Treating that Date as an instant is a silent three-hour
 * error, which is exactly this project's characteristic failure mode, so the
 * conversion is done in one place and tested against both formats.
 */
export function wallClockFromNaiveDate(value: Date): WallClock {
  return {
    year: value.getUTCFullYear(),
    month: value.getUTCMonth() + 1,
    day: value.getUTCDate(),
    hour: value.getUTCHours(),
    minute: value.getUTCMinutes(),
    second: value.getUTCSeconds(),
  };
}

/** Whole minutes between two instants — the source interval length. */
export function minutesBetween(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / MS_PER_MINUTE);
}

/**
 * The interval one *local calendar day* actually occupied, as a UTC instant and
 * a length.
 *
 * Two things make this more than `midnight, 1440`:
 *
 * - **Midnight does not always exist.** Brazil moved its clocks at 00:00, so on
 *   a spring-forward day the local day begins at 01:00. `carga-energia` still
 *   publishes a row for `2018-11-04`, and rejecting it as a DST gap would throw
 *   away a real day of load for four subsystems.
 * - **The day is not always 24 hours long**, and a mean power is only energy
 *   once multiplied by the duration it is a mean over. ONS agrees: the four
 *   `2018-11-04` values are means over 46 half-hours rather than 48, visible in
 *   their repeating decimals (`4838.64947826`).
 *
 * Null only when neither midnight nor the hour after it exists, which no real
 * zone does; it is returned rather than thrown so the caller rejects a row
 * instead of failing a whole file.
 */
export interface LocalDay {
  /** First instant of the local day, UTC. */
  start: Date;
  /** Length of the local day in minutes — 1380, 1440 or 1500. */
  minutes: number;
  /** True when local midnight never happened and the day starts an hour late. */
  midnightSkipped: boolean;
}

/** Resolve a local calendar date to the interval it actually occupied. */
export function localDayInterval(
  wall: Pick<WallClock, "year" | "month" | "day">,
  timeZone: string = ONS_TIME_ZONE,
): LocalDay | null {
  const startOf = (
    date: Pick<WallClock, "year" | "month" | "day">,
  ): { instant: Date; midnightSkipped: boolean } | null => {
    const base = { ...date, minute: 0, second: 0 };
    for (const hour of [0, 1]) {
      const zoned = zonedWallClockToUtc({ ...base, hour }, timeZone);
      if (zoned.kind === "ok") {
        return { instant: zoned.instant, midnightSkipped: hour !== 0 };
      }
      if (zoned.kind === "ambiguous") {
        // The local day began twice; the earlier occurrence is its start.
        return { instant: zoned.instants[0], midnightSkipped: hour !== 0 };
      }
    }
    return null;
  };

  const start = startOf(wall);
  if (!start) {
    return null;
  }
  // Date.UTC normalises a day past the end of the month, so no calendar
  // arithmetic is written here.
  const nextDay = new Date(Date.UTC(wall.year, wall.month - 1, wall.day + 1));
  const next = startOf({
    year: nextDay.getUTCFullYear(),
    month: nextDay.getUTCMonth() + 1,
    day: nextDay.getUTCDate(),
  });
  if (!next) {
    return null;
  }

  return {
    start: start.instant,
    minutes: minutesBetween(start.instant, next.instant),
    midnightSkipped: start.midnightSkipped,
  };
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Parse ONS's date-only `din_instante`. Null when it is not one. */
export function parseCalendarDate(
  value: string,
): Pick<WallClock, "year" | "month" | "day"> | null {
  const match = DATE_ONLY.exec(value.trim());
  if (!match) {
    return null;
  }
  const [, year, month, day] = match;
  return { year: Number(year), month: Number(month), day: Number(day) };
}
