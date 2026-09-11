import { PayloadRefusedError } from "../../errors.js";
import { parseDelimited, toRecord } from "../csv.js";
import {
  parseDecimal,
  resolveSubsystem,
  type SubsystemCode,
  trimmed,
} from "../normalise.js";
import { zonedWallClockToUtc } from "../time.js";
import type { DessemBalanceHalfHour, DessemBalanceParse, RejectedRow } from "../types.js";

/**
 * Adapter for ONS dataset 11, `balanco_dessem_detalhe` — the day-ahead
 * electro-energetic balance the DESSEM model produces, per subsystem, per
 * half hour.
 *
 * This is WattSteer's only *forward-looking* per-subsystem wind and solar
 * dispatch expectation, and the only ONS source in scope that is a `Forecast`
 * rather than an `Observation` at the file level: the file for reference day D
 * is created the evening of D−1. Three traps distinguish it from the adapters
 * it otherwise resembles, and each is defended below rather than commented on:
 *
 * 1. **`num_patamar` has no documented mapping to wall-clock time.** The
 *    research inferred it from one day's cross-check against the load API. This
 *    adapter therefore *asserts* the mapping on every file instead of trusting
 *    it — see `assertDaylightAlignment`.
 * 2. **The published header contradicts the data dictionary.** ONS's dictionary
 *    says `val_geracao_hidraulica` / `val_geracao_termica`; every file says
 *    `val_ger_hidraulica` / `val_ger_termica`. The file wins, and the
 *    dictionary spelling is not read at all — so if ONS ever "fixes" the file
 *    to match its own dictionary, this adapter fails loudly on a missing column
 *    rather than silently storing nulls for hydro and thermal.
 * 3. **Values are MW, not MWmed.** No `mwmedToMwh` here, deliberately.
 *
 * **CSV only, measured.** The Parquet rendition exists for every day and is
 * 16 634 bytes against the CSV's 17 236 for 2026-08-29 — a 3.5% saving on a
 * 17 kB file. That is not worth a second parse path, and specifically not worth
 * importing the INT96-materialised-as-instant hazard that the balanço adapter
 * had to defend against for `din_instante`.
 */

/**
 * A canonical row before its reference day's coverage is known.
 *
 * The rows are built one CSV line at a time and the day's coverage is only
 * established once the last line has been read, so the two facts cannot be
 * assembled in one pass. This is that intermediate value, and it exists so the
 * stamped fields cannot be forgotten: `DessemBalanceHalfHour` requires them and
 * a `DessemBalanceRow` is not one until `assessCoverage` has answered.
 */
type DessemBalanceRow = Omit<
  DessemBalanceHalfHour,
  "referenceDayPatamares" | "referenceDayHalfHours"
>;

/** ONS CKAN package id. Underscores, unlike most ONS slugs — read, never built. */
export const DESSEM_DETAIL_DATASET_SLUG = "balanco_dessem_detalhe";

/**
 * First reference day ONS published. There is nothing before it: the DESSEM
 * balances are by far the shortest series in scope, which is why the domain
 * model records them as an A/B rather than an assumption.
 */
export const DESSEM_COVERAGE_START = "2025-05-23";

/** One patamar is one half hour. */
export const PATAMAR_MINUTES = 30;

const MS_PER_MINUTE = 60_000;

/**
 * The local-hour window in which the grid's solar output must be positive, and
 * the window a partial day has to reach into to be readable at all.
 *
 * Named constants rather than literals in `assertDaylightAlignment`, because
 * `assessCoverage` has to ask a question *about* this window: a short day whose
 * patamares do not touch it carries no daylight signal, so the one thing that
 * pins the period index absolutely is absent and the file cannot say what its
 * own rows mean. Those days stay refused (data-platform 29).
 */
const MIDDAY_FROM_HOUR = 9;
const MIDDAY_TO_HOUR = 15;

/** The local hours in which photovoltaic output must be exactly zero. */
const NIGHT_TO_HOUR = 4;
const NIGHT_FROM_HOUR = 21;

/**
 * The patamares that fall inside the midday window, derived from it.
 *
 * Patamar *k* is the half hour **ending** 00:00 + k×30 min, so it starts at
 * local hour (k−1)/2: hour ≥ 9 is k ≥ 19 and hour < 15 is k ≤ 30. Derived
 * rather than written as 19…30 so that moving the window moves both the
 * assertion and the coverage rule together.
 */
const MIDDAY_FIRST_PATAMAR = (MIDDAY_FROM_HOUR * 60) / PATAMAR_MINUTES + 1;
const MIDDAY_LAST_PATAMAR = (MIDDAY_TO_HOUR * 60) / PATAMAR_MINUTES;

/**
 * Columns this adapter requires, spelled as the **file** spells them.
 *
 * Read from every file on every ingest and reconciled against this list — ONS
 * has already been observed backfilling columns into closed months of another
 * dataset, so "the schema of a 2025 file" is not a thing that exists.
 */
const REQUIRED_COLUMNS = [
  "din_programacaodia",
  "num_patamar",
  "cod_subsistema",
  "val_demanda",
  "val_ger_hidraulica",
  "val_ger_pch",
  "val_ger_termica",
  "val_ger_pct",
  "val_ger_eolica",
  "val_ger_fotovoltaica",
  "val_ger_mmgd",
  "val_cons_elevatoria",
] as const;

/** The nine measures, and the column each is read from. */
const MEASURES = {
  demandMw: "val_demanda",
  hydroGenerationMw: "val_ger_hidraulica",
  smallHydroGenerationMw: "val_ger_pch",
  thermalGenerationMw: "val_ger_termica",
  smallThermalGenerationMw: "val_ger_pct",
  windGenerationMw: "val_ger_eolica",
  solarGenerationMw: "val_ger_fotovoltaica",
  mmgdGenerationMw: "val_ger_mmgd",
  pumpingConsumptionMw: "val_cons_elevatoria",
} as const;

type MeasureKey = keyof typeof MEASURES;

const REFERENCE_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

function assertColumns(columns: string[]): void {
  const present = new Set(columns);
  const missing = REQUIRED_COLUMNS.filter((column) => !present.has(column));
  if (missing.length > 0) {
    throw new PayloadRefusedError(
      "schema",
      `balanco_dessem_detalhe is missing required columns: ${missing.join(", ")}. ` +
        "The published header is authoritative over the data dictionary; a rename " +
        "here is a schema change, not a parse bug.",
    );
  }
}

/**
 * The UTC instant that a reference day's local civil midnight falls at, and the
 * number of half hours the day contains.
 *
 * Derived from the zone rather than fixed at 48 so that a day is measured, not
 * assumed: Brazil abolished DST in 2019 and every day in the DESSEM window is
 * 48 patamares long, but *that is a fact about the data*, and a hard-coded 48
 * would turn a future 46- or 50-patamar day into silently shifted timestamps
 * instead of a loud rejection.
 */
export function referenceDayAnchor(referenceDay: string): {
  midnightUtc: Date;
  halfHours: number;
} {
  const match = REFERENCE_DAY.exec(referenceDay);
  if (!match) {
    throw new PayloadRefusedError(
      "time_axis",
      `balanco_dessem_detalhe has an unreadable din_programacaodia: ${JSON.stringify(referenceDay)}`,
    );
  }
  const [, year, month, day] = match;
  const wall = {
    year: Number(year),
    month: Number(month),
    day: Number(day),
    hour: 0,
    minute: 0,
    second: 0,
  };
  const start = zonedWallClockToUtc(wall);
  const nextDay = new Date(Date.UTC(wall.year, wall.month - 1, wall.day + 1));
  const end = zonedWallClockToUtc({
    year: nextDay.getUTCFullYear(),
    month: nextDay.getUTCMonth() + 1,
    day: nextDay.getUTCDate(),
    hour: 0,
    minute: 0,
    second: 0,
  });
  // Neither boundary can be a DST gap or ambiguity in this zone — the
  // transitions never fell at midnight — but a silent guess at a boundary is
  // exactly the three-hour error this layer exists to refuse.
  if (start.kind !== "ok" || end.kind !== "ok") {
    throw new PayloadRefusedError(
      "time_axis",
      `Reference day ${referenceDay} does not start and end at an unambiguous local midnight`,
    );
  }
  const halfHours = Math.round(
    (end.instant.getTime() - start.instant.getTime()) / (PATAMAR_MINUTES * MS_PER_MINUTE),
  );
  return { midnightUtc: start.instant, halfHours };
}

/**
 * The UTC start of the half hour `num_patamar` denotes.
 *
 * Patamar *k* is the half hour **ending** at 00:00 + k×30 min Brasília, so it
 * starts half an hour earlier — k = 1 is 00:00–00:30 local. This is the one
 * inference in the whole platform that ONS documents nowhere; it is applied
 * here and asserted in `assertDaylightAlignment`.
 */
export function patamarStart(midnightUtc: Date, patamar: number): Date {
  return new Date(
    midnightUtc.getTime() + (patamar - 1) * PATAMAR_MINUTES * MS_PER_MINUTE,
  );
}

/**
 * The daylight assertion — the inferred patamar mapping, checked against
 * physics on every single file.
 *
 * Solar output is the one quantity in this file whose wall-clock shape is known
 * a priori: it is exactly zero at night and large in the middle of the day. Any
 * offset in the mapping — an end/start relabelling, a UTC-versus-Brasília slip,
 * a 1-based/0-based change — walks the solar day into the night window and
 * fails here.
 *
 * **The two windows read different columns, and that asymmetry is the point.**
 * The night test reads `val_ger_fotovoltaica` alone, because photovoltaic
 * output is the only quantity in the file that *must* be exactly zero in
 * darkness. `val_ger_mmgd` is micro and mini distributed generation, which is
 * mostly rooftop PV but not only: it carries small hydro, biogas and
 * cogeneration that run after sunset. Summing the two and demanding zero
 * therefore asserted something about the data that was never true, and it
 * refused three otherwise complete days over it — 2025-10-18, 2025-12-03 and
 * 2025-12-24, each a full 48 patamares for all four subsystems, each with
 * `val_ger_fotovoltaica` exactly 0.000 through the whole evening and a lone
 * 3–6 MW MMGD blip at local 21:00 with zeros on both sides of it
 * (data-platform 25). Six megawatts is 0.03% of that day's 17 GW midday peak
 * and sits in no shifted solar profile: a shift that could produce it would
 * have moved the peak too, and the midday test would have collapsed. Dropping
 * MMGD from the night window makes this guard **sharper**, not looser — the
 * quantity removed was the only one that could satisfy it without the mapping
 * being wrong.
 *
 * The midday test keeps the sum, deliberately: there it is a floor, and a
 * floor that more terms can clear is the safe direction.
 *
 * Its known blind spot, stated rather than hidden: the solar day is nearly
 * symmetric about local noon, so a *reversed* patamar order would pass. Nothing
 * cheap catches that; the numeric cross-check against `/cargaprogramada` in
 * `test/ons-dessem-balance.test.ts` does, and it is asymmetric enough to.
 * Summing the four subsystems rather than checking each is deliberate too — a
 * subsystem with no modelled solar at all is a plausible future, a *grid* with
 * none is not.
 */
function assertDaylightAlignment(
  rows: readonly DessemBalanceRow[],
  referenceDay: string,
  midnightUtc: Date,
): void {
  const hourOf = (row: DessemBalanceRow): number =>
    (row.validTime.getTime() - midnightUtc.getTime()) / (60 * MS_PER_MINUTE);
  const solar = (row: DessemBalanceRow): number =>
    row.solarGenerationMw + row.mmgdGenerationMw;

  let nightMax = 0;
  let middayMax = 0;
  for (const row of rows) {
    const hour = hourOf(row);
    if (hour < NIGHT_TO_HOUR || hour >= NIGHT_FROM_HOUR) {
      // Photovoltaic only. MMGD is not a solar-only series and runs after dark.
      nightMax = Math.max(nightMax, row.solarGenerationMw);
    }
    if (hour >= MIDDAY_FROM_HOUR && hour < MIDDAY_TO_HOUR) {
      middayMax = Math.max(middayMax, solar(row));
    }
  }

  if (nightMax > 0) {
    throw new PayloadRefusedError(
      "time_axis",
      `Reference day ${referenceDay} has ${nightMax} MW of photovoltaic generation in local ` +
        "night hours: the num_patamar → wall-clock mapping this adapter infers " +
        "(patamar k = the half hour ending 00:00 + k×30 min Brasília) no longer holds.",
    );
  }
  if (middayMax <= 0) {
    throw new PayloadRefusedError(
      "time_axis",
      `Reference day ${referenceDay} has no solar generation in local midday hours: ` +
        "the num_patamar → wall-clock mapping this adapter infers no longer holds.",
    );
  }
}

/**
 * How much of the reference day ONS published, and whether that is readable.
 *
 * Every subsystem present must carry a *contiguous* run of patamares, the runs
 * must agree to within the one half hour at the edge that a partly-written
 * patamar produces, and the run every subsystem shares must reach the midday
 * window. A whole day is the normal answer and the only one this adapter used
 * to accept; a short one is now admitted with its shortfall stated, and the
 * shapes a short file can still take that are unreadable are refused as
 * `coverage`.
 *
 * **Why a short day is admitted at all.** The comment here used to say a short
 * day is "a day whose period index may mean something other than what this
 * adapter assumes". Data-platform 25 read all 34 short days ONS has published
 * and that is not what they are: every one is a *contiguous* run — 23 a prefix
 * starting at patamar 1, 11 a suffix ending at patamar 48, never a day with
 * interior holes — and on 29 of the 34 the solar profile sits exactly where
 * `assertDaylightAlignment` requires, with a 12–22 GW midday peak and nothing
 * at all at night. The index is absolute and the file proves it. A contiguous
 * run with no interior hole is a **truncation**, not a file with gaps, and that
 * is the whole reason it can be read: patamar *k* means the same half hour
 * whether the file stops at 46 or at 48.
 *
 * **The last patamar of a truncated file can be half written, and data-platform
 * 29 measured that it usually is.** 25 recorded these days as short in *every*
 * subsystem; read per subsystem, 11 of the 34 are ragged by exactly one half
 * hour — N and NE stop at 26 where S and SE carry a 27th (2025-07-19), and the
 * same ±1 on ten other days. That extra row is not a forecast half hour. On
 * all 21 of them demand, hydro and thermal continue smoothly (0.97–1.14× the
 * previous half hour) while **small hydro collapses to 0.00–0.16×, small
 * thermal to 0.00–0.29× and wind to 0.00–0.14×** — every time, on eleven
 * different days. `val_ger_pch` cannot fall 90% in thirty minutes while demand
 * holds; those measures were simply never filled in.
 *
 * So the day is the run every subsystem shares, and the ragged rows are
 * **rejected** — `incomplete_patamar`, counted in `rowsRejected` where an
 * operator can see them — rather than stored. Storing them would put a
 * reference day in the table that is 26 half hours in two subsystems and 27 in
 * the other two, which is a shape no day-level column can state without lying
 * to half the rows, and it would feed a fabricated near-zero wind half hour to
 * the one series this dataset exists for.
 *
 * **Why it took a schema change rather than a loosened assertion.** A
 * 46-patamar day written into `dessem_balance_half_hour` used to be
 * indistinguishable from a 48-patamar one: there was no column for "this
 * reference day was published two half hours short", so
 * `canonical_day_ahead_balance` would answer 46 rows for it and every consumer
 * that divides by a day would be quietly wrong — `feature_rows` computes
 * `dessem_residual_load_min_of_day` and `dessem_residual_load_rank_in_day`
 * over the whole day, and on a 21-patamar day those are a minimum and a rank
 * over ten hours wearing a day's name. So the count now travels with the rows
 * (`reference_day_patamares`, beside the civil day's own length) and the
 * canonical read answers whole days unless a caller asks for partial ones
 * (data-platform 29).
 *
 * **The three refusals that remain, all `coverage`:**
 *
 * 1. **An interior hole.** Never observed in 470 published days. It is not a
 *    truncation, so nothing establishes that the patamares on either side of
 *    the hole mean what they say, and "a day with a hole in it" is a different
 *    upstream event from "a publication cut short".
 * 2. **Subsystems that disagree by more than the ragged edge.** One half hour
 *    at an end is a half-written patamar, measured above. Four is not: a file
 *    whose subsystems stop hours apart came from more than one run, and
 *    keeping the shared run would be discarding whole subsystems' half hours
 *    on a guess about why they differ.
 * 3. **A run that never reaches midday.** Five of the 34 are too short to
 *    contain a daylight signal at all — 2025-08-09 (42…48), 2025-08-16 (1…13),
 *    2025-08-27 (32…48), 2025-09-03 (45…48) and 2026-01-09 (44…48), each one
 *    uniform across all four subsystems. Nothing in those files pins the
 *    period index, so admitting them would be admitting rows whose *meaning*
 *    is a guess, which is the one thing this layer exists to refuse. They keep
 *    `coverage` as their reason and the refusal says why.
 */

/**
 * The shape of a short day, in one clause appended to its refusal.
 *
 * Which patamares are missing is the whole difference between "ONS published
 * part of a day" and "ONS published a day with a hole in it", and only the
 * first has ever been observed. Saying which, in the refusal itself, is what
 * stops the next census from having to re-download 470 files to find out.
 */
function describeRun(patamares: Set<number>, halfHours: number): string {
  const sorted = [...patamares].sort((a, b) => a - b);
  const first = sorted[0] as number;
  const last = sorted[sorted.length - 1] as number;
  const contiguous = last - first + 1 === sorted.length;
  if (!contiguous) {
    return `The patamares present are not one contiguous run (${first}…${last}, ${sorted.length} of ${halfHours}), so the file is not a truncated publication.`;
  }
  if (first === 1) {
    return `The patamares present are the contiguous prefix 1…${last}: a publication cut short, not a shifted index.`;
  }
  if (last === halfHours) {
    return `The patamares present are the contiguous suffix ${first}…${halfHours}: a publication that starts partway through the day, not a shifted index.`;
  }
  return `The patamares present are the contiguous run ${first}…${last}, touching neither end of the day.`;
}

/** The inclusive bounds of a set of patamares, and whether it has a hole. */
function runOf(patamares: Set<number>): {
  first: number;
  last: number;
  contiguous: boolean;
} {
  const sorted = [...patamares].sort((a, b) => a - b);
  const first = sorted[0] as number;
  const last = sorted[sorted.length - 1] as number;
  return { first, last, contiguous: last - first + 1 === sorted.length };
}

/**
 * The largest ragged edge a half-written patamar can explain.
 *
 * One. ONS writes a patamar as four subsystem rows and the last one of a
 * truncated file can be written for some of them and not others; every one of
 * the 11 ragged days measured in data-platform 29 is ragged by exactly this
 * much. Two hours of disagreement is a different event and is refused.
 */
const MAX_RAGGED_EDGE = 1;

/**
 * The run of patamares every subsystem carries, and how long it is.
 *
 * Throws `coverage` for the shapes above. Rows outside `first…last` are the
 * caller's to reject — this function only says where the day is.
 */
function assessCoverage(
  seen: Map<SubsystemCode, Set<number>>,
  referenceDay: string,
  halfHours: number,
): { first: number; last: number; patamares: number } {
  if (seen.size === 0) {
    throw new PayloadRefusedError(
      "coverage",
      `Reference day ${referenceDay} carries no subsystem rows`,
    );
  }

  const runs: { subsystem: SubsystemCode; first: number; last: number }[] = [];
  for (const [subsystem, patamares] of seen) {
    const run = runOf(patamares);
    if (!run.contiguous) {
      throw new PayloadRefusedError(
        "coverage",
        `Reference day ${referenceDay} has ${patamares.size} patamares for subsystem ` +
          `${subsystem}; the local civil day is ${halfHours} half hours long. ` +
          `${describeRun(patamares, halfHours)} A truncated publication is readable — ` +
          "patamar k means the same half hour whether the file stops early or not — " +
          "but a day with an interior hole is a different upstream event, and nothing " +
          "in it establishes what the patamares on either side of the hole mean.",
      );
    }
    runs.push({ subsystem, first: run.first, last: run.last });
  }

  // The day is what every subsystem agrees on. Each run is contiguous, so the
  // intersection of contiguous runs sharing a point is contiguous too.
  const first = Math.max(...runs.map((run) => run.first));
  const last = Math.min(...runs.map((run) => run.last));
  const startSpread = first - Math.min(...runs.map((run) => run.first));
  const endSpread = Math.max(...runs.map((run) => run.last)) - last;

  if (startSpread > MAX_RAGGED_EDGE || endSpread > MAX_RAGGED_EDGE) {
    const widest = runs.reduce((a, b) => (b.last - b.first > a.last - a.first ? b : a));
    const narrowest = runs.reduce((a, b) =>
      b.last - b.first < a.last - a.first ? b : a,
    );
    throw new PayloadRefusedError(
      "coverage",
      `Reference day ${referenceDay} disagrees between subsystems by more than one ` +
        `half hour: ${widest.subsystem} carries patamares ${widest.first}…${widest.last} ` +
        `where ${narrowest.subsystem} carries ${narrowest.first}…${narrowest.last}. One ` +
        "half hour at an end is a patamar ONS wrote for some subsystems and not others " +
        "and is dropped as a fragment (data-platform 29); a wider disagreement is a " +
        "file assembled from more than one run, and reading only the shared part would " +
        "be discarding whole subsystems' half hours on a guess about why they differ.",
    );
  }
  if (last < first) {
    throw new PayloadRefusedError(
      "coverage",
      `Reference day ${referenceDay} has no patamar that every subsystem carries`,
    );
  }

  const count = last - first + 1;
  if (count === halfHours) {
    return { first, last, patamares: count };
  }

  // The one thing that pins the period index is the solar profile, and a run
  // that never reaches midday does not contain one. `assertDaylightAlignment`
  // would refuse such a day for `time_axis`, which is the wrong name for it:
  // the axis is not known to be wrong, it is unknowable from this file.
  if (last < MIDDAY_FIRST_PATAMAR || first > MIDDAY_LAST_PATAMAR) {
    const shared = new Set(
      Array.from({ length: count }, (_unused, index) => first + index),
    );
    throw new PayloadRefusedError(
      "coverage",
      `Reference day ${referenceDay} has ${count} patamares in every subsystem; ` +
        `the local civil day is ${halfHours} half hours long. ` +
        `${describeRun(shared, halfHours)} ` +
        "A partial day is admissible only if it reaches the midday window " +
        `(patamares ${MIDDAY_FIRST_PATAMAR}…${MIDDAY_LAST_PATAMAR}), where the solar ` +
        "profile pins the num_patamar → wall-clock mapping absolutely. This run does " +
        "not, so nothing in the file says what its own rows mean: the values are " +
        "readable but the half hours they belong to would be a guess.",
    );
  }

  return { first, last, patamares: count };
}

/**
 * Parse one reference day's CSV.
 *
 * Row-level defects (an unknown subsystem, a blank measure) are rejected with a
 * reason, as everywhere else. Defects that would make the *time axis* a guess —
 * more than one reference day in a file, a patamar outside the day, a day with
 * an interior hole or one too short to pin its own index, a solar profile that
 * does not sit in daylight — throw, because there is no honest partial answer
 * to them.
 *
 * A day that is merely *short* is not one of those. It returns with
 * `patamaresPerSubsystem` below `halfHoursInCivilDay` and every row stamped
 * with both, so that what is missing is stated rather than implied
 * (data-platform 29).
 */
export function parseDessemBalanceCsv(text: string): DessemBalanceParse {
  const table = parseDelimited(text);
  const columns = table.columns.map(trimmed);
  if (columns.length === 0) {
    throw new PayloadRefusedError("schema", "balanco_dessem_detalhe CSV is empty");
  }
  assertColumns(columns);

  const days = new Set<string>();
  const source = table.rows.map((cells) => toRecord(columns, cells));
  for (const record of source) {
    days.add(trimmed(record.din_programacaodia ?? ""));
  }
  if (days.size !== 1) {
    throw new PayloadRefusedError(
      "coverage",
      `balanco_dessem_detalhe file covers ${days.size} reference days (${[...days].join(", ")}); ` +
        "these files are split per reference day and must carry exactly one",
    );
  }
  const referenceDay = [...days][0] as string;
  const { midnightUtc, halfHours } = referenceDayAnchor(referenceDay);

  /**
   * Every readable row with the patamar and file line it came from.
   *
   * Staged rather than appended straight to the answer because a row's fate
   * depends on the *file*: a patamar the other subsystems do not carry is a
   * fragment, and that cannot be known until the last line has been read.
   */
  const staged: { patamar: number; rowNumber: number; row: DessemBalanceRow }[] = [];
  const rejected: RejectedRow[] = [];
  const seen = new Map<SubsystemCode, Set<number>>();
  let aggregateRowsFiltered = 0;

  source.forEach((record, index) => {
    const rowNumber = index + 1;
    const reject = (reason: RejectedRow["reason"], detail: string): void => {
      rejected.push({ reason, rowNumber, detail });
    };

    const subsystem = resolveSubsystem(record.cod_subsistema ?? "");
    if (subsystem.kind === "aggregate") {
      // No DESSEM file observed carries `SIN`, but the filter is the platform's
      // boundary rule and a file that started to would double-count without it.
      aggregateRowsFiltered += 1;
      return;
    }
    if (subsystem.kind === "unknown") {
      reject("unknown_subsystem", `cod_subsistema=${JSON.stringify(subsystem.raw)}`);
      return;
    }

    const patamar = Number(trimmed(record.num_patamar ?? ""));
    if (!Number.isInteger(patamar) || patamar < 1 || patamar > halfHours) {
      throw new PayloadRefusedError(
        "time_axis",
        `Reference day ${referenceDay} carries num_patamar=${JSON.stringify(record.num_patamar ?? null)}, ` +
          `outside the ${halfHours} half hours of the local civil day`,
      );
    }
    const patamares = seen.get(subsystem.code) ?? new Set<number>();
    if (patamares.has(patamar)) {
      throw new PayloadRefusedError(
        "coverage",
        `Reference day ${referenceDay} repeats patamar ${patamar} for subsystem ${subsystem.code}`,
      );
    }
    patamares.add(patamar);
    seen.set(subsystem.code, patamares);

    const measures = {} as Record<MeasureKey, number>;
    let failed = false;
    for (const [key, column] of Object.entries(MEASURES) as [MeasureKey, string][]) {
      const value = parseDecimal(record[column]);
      if (value === null) {
        reject("empty_value", `${column} is present but empty`);
        failed = true;
        break;
      }
      if (Number.isNaN(value)) {
        reject("unparsable_value", `${column}=${JSON.stringify(record[column])}`);
        failed = true;
        break;
      }
      // No MWmed conversion: DESSEM publishes MW. Applying the conversion the
      // other adapters apply would halve every half-hourly value.
      measures[key] = value;
    }
    if (failed) {
      return;
    }

    staged.push({
      patamar,
      rowNumber,
      row: {
        subsystem: subsystem.code,
        validTime: patamarStart(midnightUtc, patamar),
        referenceDay,
        ...measures,
      },
    });
  });

  const day = assessCoverage(seen, referenceDay, halfHours);
  const patamaresPerSubsystem = day.patamares;

  // The ragged edge, dropped with a reason. Measured on all 21 such rows in
  // the published history: demand, hydro and thermal continue while small
  // hydro, small thermal and wind collapse to near zero, so this is a patamar
  // ONS began writing and did not finish, not a half hour it forecast.
  const rows: DessemBalanceRow[] = [];
  for (const entry of staged) {
    if (entry.patamar < day.first || entry.patamar > day.last) {
      rejected.push({
        reason: "incomplete_patamar",
        rowNumber: entry.rowNumber,
        detail:
          `num_patamar=${entry.patamar} is carried by subsystem ${entry.row.subsystem} ` +
          `and not by every subsystem; reference day ${referenceDay} is the run ` +
          `${day.first}…${day.last}`,
      });
      continue;
    }
    rows.push(entry.row);
  }

  assertDaylightAlignment(rows, referenceDay, midnightUtc);

  return {
    // The day's coverage travels on every row of it, because that is where the
    // table keeps it and where a read has to be able to see it. One write is
    // one reference day, so the three numbers agree by construction and
    // `writeDessemBalance` refuses a batch where they do not.
    rows: rows.map((row) => ({
      ...row,
      referenceDayPatamares: patamaresPerSubsystem,
      referenceDayHalfHours: halfHours,
    })),
    rejected,
    columns,
    referenceDay,
    patamaresPerSubsystem,
    halfHoursInCivilDay: halfHours,
    complete: patamaresPerSubsystem === halfHours,
    aggregateRowsFiltered,
  };
}
