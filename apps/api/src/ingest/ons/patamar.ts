import { PATAMAR_MINUTES } from "./dessem-balance.js";

/**
 * The `num_patamar` dictionary — which local half hour each patamar denotes.
 *
 * ONS defines the column only as "Número do Patamar" and documents no mapping,
 * in either the JSON or the PDF dictionaries. The mapping was until now implicit
 * arithmetic inside `patamarStart`; this makes it a thing a reader can look up,
 * and a test can hold against that arithmetic.
 *
 * **What "patamar" means depends on the dataset, and that is why this is keyed
 * by dataset.** In ONS's load-dispatch vocabulary a *patamar de carga* is a load
 * tier — pesada, média, leve — a handful of blocks per day. The DESSEM balance
 * files use the word for something else: 48 consecutive half-hour stages of the
 * day-ahead model. Both readings exist in the operator's language, so the
 * resolution is declared per dataset instead of assumed from the column name.
 *
 * **Evidence for the DESSEM files** (`docs/research/ons-datasets.md`, §10 & 11):
 * the 2026-08-28 geral file carries exactly 48 distinct patamares, 1..48, for
 * each of four subsystems, and its `val_demanda` for `SE` agrees to within 0.03%
 * with `/cargaprogramada` for the same day at half-hour offsets, patamar 1
 * matching the value stamped 03:30Z (00:00–00:30 Brasília). That is an
 * independent series, not the file agreeing with itself. It remains an inference
 * from one day, not something ONS states.
 *
 * **`programacao_x_previsao` is deliberately `unverified`.** Its `num_patamar`
 * has not been counted: the only rows read were all patamar 1, so neither its
 * range nor its resolution is established, and a half-hour reading must not be
 * carried over from a different dataset because the column has the same name.
 */
export type PatamarResolution =
  | { kind: "half_hour"; patamaresPerDay: 48 }
  | { kind: "unverified"; reason: string };

export const PATAMAR_RESOLUTION = {
  dessem_balance: { kind: "half_hour", patamaresPerDay: 48 },
  dessem_general: { kind: "half_hour", patamaresPerDay: 48 },
  programacao_x_previsao: {
    kind: "unverified",
    reason:
      "num_patamar has not been counted for this dataset; the rows read were all " +
      "patamar 1, so its range and resolution are not established",
  },
} as const satisfies Record<string, PatamarResolution>;

/** One row of the dictionary: a patamar and the local half hour it denotes. */
export interface PatamarEntry {
  patamar: number;
  /** Local (Brasília) start of the half hour, `HH:MM`. */
  from: string;
  /** Local (Brasília) end of the half hour, `HH:MM`; `24:00` closes the day. */
  to: string;
}

const clock = (minutes: number): string =>
  `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

/**
 * The 48 half-hour patamares of a DESSEM balance day, 1-based, in order.
 *
 * Valid on a 48-half-hour civil day, which is every day in the DESSEM window —
 * Brazil abolished DST in 2019. `referenceDayAnchor` still measures the day from
 * the zone, so a 46- or 50-half-hour day is refused there instead of read
 * through this table.
 */
export const DESSEM_PATAMAR_DICTIONARY: readonly PatamarEntry[] = Array.from(
  { length: 48 },
  (_unused, index) => ({
    patamar: index + 1,
    from: clock(index * PATAMAR_MINUTES),
    to: clock((index + 1) * PATAMAR_MINUTES),
  }),
);
