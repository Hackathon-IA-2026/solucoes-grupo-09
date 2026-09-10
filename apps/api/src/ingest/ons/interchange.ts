import { SUBSYSTEM_DECLARATION_ORDER } from "@wattsteer/core/domain";
import { UpstreamError } from "../../errors.js";
import { parseDelimited, toRecord } from "../csv.js";
import type { SubsystemCode } from "../normalise.js";
import { mwmedToMwh, parseDecimal, resolveSubsystem, trimmed } from "../normalise.js";
import { parseWallClock, zonedWallClockToUtc } from "../time.js";
import type {
  RejectedRow,
  RejectionReason,
  SubsystemExchangeHour,
  SubsystemExchangeParse,
} from "../types.js";

/**
 * Adapter for ONS dataset 9, `intercambio-nacional` — the directed power flows
 * between subsystems, hourly.
 *
 * Three findings shape this file, and only the first is in the research.
 *
 * 1. **`val_intercambioprogmwmed` was added in 2026 and was *not* backfilled.**
 *    Files from 2025 and earlier still carry six columns. This is the exact
 *    opposite of `dsc_restricao` in the constrained-off datasets, which ONS
 *    _did_ rewrite into already-closed months. So neither behaviour can be
 *    assumed: the header is read from every file on every ingest, the later
 *    column is not required, and its *presence* is reported separately from a
 *    value being empty.
 * 2. **The direction convention changed with it, silently.** Measured across the
 *    whole 2018 and 2026 files: 2018 publishes four fixed pairs (`N→NE`,
 *    `N→SE`, `NE→SE`, `SE→S`) and carries the direction in the **sign** — 11 719
 *    of 35 036 rows are negative. 2026 publishes eight pairs, every verified
 *    value is non-negative, and the *orientation of the row* flips when the flow
 *    reverses. Both encode the same physical quantity in a different basis, and
 *    a consumer that keyed on (origin, destination) would read two disjoint
 *    series across the break.
 *
 *    So orientation is normalised here, exactly as timezone and MWmed are: every
 *    row is stated over the link's canonical orientation — the two subsystems in
 *    `SUBSYSTEM_ORDER` — and a row published the other way round is flipped and
 *    its values negated. Nothing is lost; the direction is the sign, which is
 *    what the first 26 years of the dataset already did. `reorientedRows`
 *    reports how many were flipped, so the convention change stays visible.
 *
 *    Neither file ever carried a link in both orientations within one hour
 *    (measured: zero occurrences in 2018 and 2026). If one ever does, the second
 *    row is rejected as `duplicate_key` rather than silently dropped by the
 *    primary key.
 * 3. **The DST spring-forward hour is simply absent**, unlike
 *    `balanco-energia-subsistema`, which emits a placeholder row for it. 2018 has
 *    8 759 distinct hours and no row at all for `2018-11-04 00:00`. The
 *    fall-back hour is present exactly once, so it is still ambiguous and still
 *    rejected.
 *
 * `nom_subsistema_origem` / `_destino` carry a **leading space** in the 2026
 * file (`" NORTE"`) and none in 2000–2025 — one more reason the display names
 * are never a key. They are trimmed and read only to check they agree with the
 * code beside them.
 *
 * **CSV, not Parquet.** Parquet covers 2023 → 2026 only (4 files against the
 * CSV's 27), so CSV is the format that spans the history the forecaster needs.
 * Choosing the format that always exists over the one that is usually smaller
 * is the same call the constrained-off adapter makes.
 */

/** ONS CKAN package id for this dataset. */
export const INTERCHANGE_DATASET_SLUG = "intercambio-nacional";

/**
 * Formats to ask the catalogue for, in order. CSV first and Parquet not at all:
 * a Parquet-preferring select would silently ingest a different rendition for
 * 2023 → 2026 than for every earlier year.
 */
export const INTERCHANGE_FORMATS = ["CSV"] as const;

/** These rows are hourly, so MWmed converts to MWh over 60 minutes. */
const INTERVAL_MINUTES = 60;

/**
 * The canonical orientation basis: a link is stated from the earlier member of
 * this list to the later one. It is `SubsystemCode`'s own declaration order, so
 * the convention is anchored to the domain enum rather than to an alphabet.
 *
 * **Read from the published constant, and it must be the declaration one.** The
 * vocabulary carries two orders. `SUBSYSTEM_DISPLAY_ORDER` is `N, NE, SE, S`,
 * which puts `SE` before `S`; this basis has `S` before `SE`. Swapping them
 * reverses the stated orientation of every `S`–`SE` row, and since the
 * direction of a flow is carried in the *sign*, that silently negates a
 * production column. `apps/api/test/ons-interchange.test.ts` asserts the
 * `S`↔`SE` case directly for exactly this reason.
 */
const SUBSYSTEM_ORDER: readonly SubsystemCode[] = SUBSYSTEM_DECLARATION_ORDER;

/** Columns every vintage of this file has carried since 2000. */
const REQUIRED_COLUMNS = [
  "din_instante",
  "id_subsistema_origem",
  "id_subsistema_destino",
  "val_intercambiomwmed",
] as const;

/** Present from 2026 onward, and deliberately *not* backfilled by ONS. */
const PROGRAMMED_COLUMN = "val_intercambioprogmwmed";

function assertColumns(columns: string[]): void {
  const present = new Set(columns);
  const missing = REQUIRED_COLUMNS.filter((column) => !present.has(column));
  if (missing.length > 0) {
    throw new UpstreamError(
      `intercambio-nacional is missing required columns: ${missing.join(", ")}`,
    );
  }
}

/** Position of a subsystem in the canonical orientation basis. */
function rank(code: SubsystemCode): number {
  return SUBSYSTEM_ORDER.indexOf(code);
}

/** Turn one source row into a canonical row, or into the reason it cannot be. */
function normaliseRow(
  row: Record<string, string>,
  rowNumber: number,
  hasProgrammed: boolean,
): { row: SubsystemExchangeHour; reoriented: boolean } | { rejected: RejectedRow } {
  const reject = (reason: RejectionReason, detail: string) => ({
    rejected: { reason, rowNumber, detail },
  });

  const origin = resolveSubsystem(row.id_subsistema_origem ?? "");
  if (origin.kind !== "subsystem") {
    // This dataset carries no SIN aggregate and no Itaipu node, so anything
    // unresolved is unknown rather than filtered.
    return reject(
      "unknown_subsystem",
      `id_subsistema_origem=${JSON.stringify(row.id_subsistema_origem ?? null)}`,
    );
  }
  const destination = resolveSubsystem(row.id_subsistema_destino ?? "");
  if (destination.kind !== "subsystem") {
    return reject(
      "unknown_subsystem",
      `id_subsistema_destino=${JSON.stringify(row.id_subsistema_destino ?? null)}`,
    );
  }
  if (origin.code === destination.code) {
    // A link from a subsystem to itself is not a flow. Never observed; rejected
    // rather than stored as a self-loop that no consumer could interpret.
    return reject("self_directed_exchange", `both ends are ${origin.code}`);
  }

  const wall = parseWallClock(row.din_instante ?? "");
  if (!wall) {
    return reject(
      "unparsable_timestamp",
      `din_instante=${JSON.stringify(row.din_instante ?? null)}`,
    );
  }
  // `din_instante` is documented here as "início do período de agregação" — the
  // one dataset in scope that states the convention — so it already matches
  // WattSteer's start-of-interval canon and only the zone is resolved.
  const zoned = zonedWallClockToUtc(wall);
  if (zoned.kind === "gap") {
    return reject("dst_gap", `din_instante=${row.din_instante} never occurred locally`);
  }
  if (zoned.kind === "ambiguous") {
    // ONS publishes the duplicated local hour once and does not say which of the
    // two it is. Rejecting is the honest answer, as it is for the balanço.
    return reject(
      "dst_ambiguous",
      `din_instante=${row.din_instante} occurred twice locally`,
    );
  }

  const verified = parseDecimal(row.val_intercambiomwmed);
  if (verified === null) {
    return reject("empty_value", "val_intercambiomwmed is present but empty");
  }
  if (Number.isNaN(verified)) {
    return reject(
      "unparsable_value",
      `val_intercambiomwmed=${JSON.stringify(row.val_intercambiomwmed)}`,
    );
  }

  // Absent column and empty cell both land on null here; the file-level
  // `hasProgrammedColumn` is what keeps "ONS had not invented this column yet"
  // distinct from "ONS published no programmed value for this hour".
  let programmed: number | null = null;
  if (hasProgrammed) {
    const value = parseDecimal(row[PROGRAMMED_COLUMN]);
    if (value !== null && Number.isNaN(value)) {
      return reject(
        "unparsable_value",
        `${PROGRAMMED_COLUMN}=${JSON.stringify(row[PROGRAMMED_COLUMN])}`,
      );
    }
    programmed = value;
  }

  const reoriented = rank(origin.code) > rank(destination.code);
  const sign = reoriented ? -1 : 1;
  const [fromSubsystem, toSubsystem] = reoriented
    ? [destination.code, origin.code]
    : [origin.code, destination.code];

  return {
    reoriented,
    row: {
      fromSubsystem,
      toSubsystem,
      validTime: zoned.instant,
      verifiedExchangeMwh: mwmedToMwh(sign * verified, INTERVAL_MINUTES),
      programmedExchangeMwh:
        programmed === null ? null : mwmedToMwh(sign * programmed, INTERVAL_MINUTES),
    },
  };
}

const businessKey = (row: SubsystemExchangeHour): string =>
  `${row.fromSubsystem}|${row.toSubsystem}|${row.validTime.toISOString()}`;

/** Parse one yearly `INTERCAMBIO_NACIONAL_<YYYY>.csv`. */
export function parseInterchangeCsv(text: string): SubsystemExchangeParse {
  const { columns: rawColumns, rows: cells } = parseDelimited(text);
  if (rawColumns.length === 0) {
    throw new UpstreamError("intercambio-nacional file is empty");
  }
  const columns = rawColumns.map(trimmed);
  assertColumns(columns);
  const hasProgrammedColumn = columns.includes(PROGRAMMED_COLUMN);

  const rows: SubsystemExchangeHour[] = [];
  const rejected: RejectedRow[] = [];
  const seen = new Map<string, number>();
  let reorientedRows = 0;

  cells.forEach((cell, index) => {
    const rowNumber = index + 1;
    const outcome = normaliseRow(toRecord(columns, cell), rowNumber, hasProgrammedColumn);
    if ("rejected" in outcome) {
      rejected.push(outcome.rejected);
      return;
    }

    const key = businessKey(outcome.row);
    const first = seen.get(key);
    if (first !== undefined) {
      // Two rows for one link and hour — the mirrored-pair case, which would
      // otherwise be swallowed by `onConflictDoNothing` on the primary key.
      rejected.push({
        reason: "duplicate_key",
        rowNumber,
        detail: `${outcome.row.fromSubsystem}→${outcome.row.toSubsystem} at ${outcome.row.validTime.toISOString()} already given on row ${first}`,
      });
      return;
    }

    seen.set(key, rowNumber);
    if (outcome.reoriented) {
      reorientedRows += 1;
    }
    rows.push(outcome.row);
  });

  return { rows, rejected, columns, hasProgrammedColumn, reorientedRows };
}
