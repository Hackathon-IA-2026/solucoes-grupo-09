import { PayloadRefusedError } from "../../errors.js";
import { trimmed } from "../normalise.js";
import { referenceDayAnchor } from "./dessem-balance.js";

/**
 * What the three day-ahead **programme** datasets share — `programacao_diaria`,
 * `programacao_x_previsao` and `programacao_fluxo_controlado`.
 *
 * All three are daily-split files whose `num_patamar` counts 1..48 half-hour
 * stages of the reference day, and all three are written together by the same
 * ONS process the evening before. Keeping the convention here, once, is what
 * stops the three adapters drifting on the one thing a silent error in would
 * shift every value by half an hour.
 *
 * **The patamar convention, and how it was established.** Not documented by ONS;
 * measured on 2026-09-18. `programacao_diaria` summed over wind and solar
 * correlates with `balanco_dessem_geral`'s `val_geracao_renovavel` best at
 * **lag 0** in all four subsystems (r = 0.930 / 0.997 / 0.99991 / 0.99989,
 * against 0.77–0.985 at ±1), and `programacao_x_previsao` matches
 * `programacao_diaria` index for index. `balanco_dessem_geral` is the dataset
 * whose patamar dictionary was verified against an independent series
 * (`patamar.ts`), so these three inherit it: patamar *k* labels the half hour
 * that **ends** at 00:00 + k×30 min Brasília, and `patamarStart` gives its UTC
 * start. It is an inference from one day and a neighbour's dictionary, and says
 * so; the per-file check that would enforce it is the same one
 * `dessem-general.ts` records as unwritten.
 */

/**
 * The hour of the evening before, Brasília, at which a programme file is stamped
 * as published: **23:00 on D−1**.
 *
 * Not the file's `Last-Modified`, which was measured on 21 files across the whole
 * history and cannot be trusted as a publication instant here: the file for
 * 2024-10-01 is stamped 01:08 *on the reference day itself* — after the first
 * half hour it programmes has begun, which the `published_at < valid_time` table
 * constraint forbids — and `programacao_x_previsao` for 2024-12-25 was rewritten
 * on 2025-02-13, seven weeks after the day it describes. A stamp taken from the
 * fetch has the same fault for every backfilled row.
 *
 * Nor 15:00, which is what `programmePublishedAt` in `load.ts` claims for the
 * carga programme: these files were measured landing between 18:16 and 22:47
 * BRT on D−1, and 15:00 would say the programme was readable hours before it
 * was. 23:00 is later than every ordinary day observed and, in the
 * conservative direction, claims less. `docs/research/publication-lag.md`
 * measured 20:50–22:20 BRT for `programacao_diaria` alone.
 *
 * **The one known exception:** the first day of the history, 2024-10-01, was
 * published after this stamp. Nothing reads that day as a point-in-time view.
 */
export const PROGRAMME_PUBLICATION_HOUR_BRT = 23;

/**
 * The instant a reference day's programme is stamped as published.
 *
 * Computed as one hour before the zone's own local midnight, so it follows
 * `referenceDayAnchor`'s reading of the civil day and is 23:00 local on every day
 * without a DST transition — which is every day in the window, since Brazil
 * abolished DST in 2019 and these files begin in 2024.
 */
export function programmeFilePublishedAt(referenceDay: string): Date {
  const { midnightUtc } = referenceDayAnchor(referenceDay);
  return new Date(
    midnightUtc.getTime() - (24 - PROGRAMME_PUBLICATION_HOUR_BRT) * 3_600_000,
  );
}

/**
 * Read a reference-day cell as `YYYY-MM-DD`.
 *
 * The three files spell it two ways in the same family of datasets:
 * `programacao_x_previsao` writes `20260918` and the other two `2026-09-18`. A
 * cell that is neither is a time axis nobody can read, so it refuses the file
 * rather than being guessed at.
 */
export function readReferenceDay(dataset: string, raw: string): string {
  const text = trimmed(raw);
  const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(text);
  if (compact) {
    return `${compact[1]}-${compact[2]}-${compact[3]}`;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return text;
  }
  throw new PayloadRefusedError(
    "time_axis",
    `${dataset} carries reference day ${JSON.stringify(raw)}, which is neither YYYYMMDD nor YYYY-MM-DD`,
  );
}

/** Refuse a header that is missing any column the adapter reads. */
export function assertRequiredColumns(
  dataset: string,
  columns: readonly string[],
  required: readonly string[],
): void {
  const present = new Set(columns);
  const missing = required.filter((column) => !present.has(column));
  if (missing.length > 0) {
    throw new PayloadRefusedError(
      "schema",
      `${dataset} is missing required columns: ${missing.join(", ")}. The published ` +
        "header is authoritative over the data dictionary; a rename here is a schema " +
        "change, not a parse bug.",
    );
  }
}

/** The one reference day a file carries, or a `coverage` refusal. */
export function soleReferenceDay(
  dataset: string,
  cells: readonly string[],
): { referenceDay: string; midnightUtc: Date; halfHours: number } {
  const days = new Set(cells.map((cell) => readReferenceDay(dataset, cell)));
  if (days.size !== 1) {
    throw new PayloadRefusedError(
      "coverage",
      `${dataset} file covers ${days.size} reference days (${[...days].join(", ")}); ` +
        "these files are split per reference day and must carry exactly one",
    );
  }
  const referenceDay = [...days][0] as string;
  return { referenceDay, ...referenceDayAnchor(referenceDay) };
}

/** A patamar within the civil day, or a `time_axis` refusal. */
export function readPatamar(
  referenceDay: string,
  raw: string | undefined,
  halfHours: number,
): number {
  const patamar = Number(trimmed(raw ?? ""));
  if (!Number.isInteger(patamar) || patamar < 1 || patamar > halfHours) {
    throw new PayloadRefusedError(
      "time_axis",
      `Reference day ${referenceDay} carries num_patamar=${JSON.stringify(raw ?? null)}, ` +
        `outside the ${halfHours} half hours of the local civil day`,
    );
  }
  return patamar;
}

/** UTC start of a patamar's half hour. */
export { patamarStart } from "./dessem-balance.js";

/** Sums are rounded to the digest's precision so float noise never reaches a column. */
export function roundSum(value: number): number {
  return Number(value.toFixed(6));
}

/**
 * Refuse a file whose own reference day is not the day its name promised.
 *
 * The catalogue names each file for a day, and the day inside is what the rows
 * are stamped from. A mismatch is ONS publishing one day's bytes under another
 * day's name, and storing it would put a whole day of forecasts on the wrong
 * date without a value looking wrong.
 */
export function assertFileIsForDay(
  dataset: string,
  fileDay: string,
  parsedDay: string,
): void {
  if (fileDay !== parsedDay) {
    throw new PayloadRefusedError(
      "time_axis",
      `${dataset} resource for ${fileDay} carries reference day ${parsedDay}`,
    );
  }
}
