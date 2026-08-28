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
