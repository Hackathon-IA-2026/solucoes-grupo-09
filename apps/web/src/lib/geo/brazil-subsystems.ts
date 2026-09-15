/**
 * Which of Brazil's 27 federal units sits in which ONS subsystem, and the
 * geometry that follows from it.
 *
 * The four codes are `@wattsteer/core`'s (`N`, `NE`, `SE`, `S`, displayed as
 * `SE/CO` for Sudeste/Centro-Oeste) and are not restated here. What is stated
 * here is the *partition* — and it is the only thing in this feature that can
 * be wrong in a way a reader would believe.
 *
 * ## What was checked, and against what
 *
 * The instinctive assignment is the geographic one: the five IBGE regions,
 * with Centro-Oeste folded into Sudeste. **It is wrong in three places**, and
 * two of them move a whole state across the map.
 *
 *  1. **Maranhão is in `N`, not `NE`.** It is in the Nordeste *geographic*
 *     region and the Norte *electrical* subsystem. EPE/MME,
 *     "Diagnóstico Regional da Rede Elétrica — PDE 2032, Volume I, GET Norte"
 *     (EPE-DEE-RE-021/2023-r0, 26/05/2023), p. 17 n. 1, says so in terms:
 *     "Apesar do estado do Maranhão pertencer à região Nordeste, sob a ótica
 *     de submercados elétricos a avaliação do desempenho do sistema que o
 *     atende é tratado no âmbito do GET Norte."
 *     Corroborated in ONS's own open data: in `CAPACIDADE_GERACAO.csv` all 63
 *     active Maranhão generating units — UHE Estreito, Parnaíba IV/V, Porto do
 *     Itaqui, the Delta wind farms — carry `id_subsistema = N`, and none carry
 *     `NE`. Corroborated again arithmetically: EPE's *Anuário Estatístico de
 *     Energia Elétrica 2021*, Tabela 3.41, puts the NE **subsystem** at
 *     20,462,544 consumers against the NE **region**'s 23,058,660, a gap of
 *     2,596,116 — Maranhão has 2,595,105.
 *  2. **Acre and Rondônia are in `SE`, not `N`.** They joined the
 *     Sudeste/Centro-Oeste subsystem over the LT Jauru–Vilhena–Porto
 *     Velho–Rio Branco in November 2009, not the Norte one. EPE's
 *     "Volume III, GET Centro-Oeste" (EPE-DEE-NT-030/2023-r0) is titled
 *     "Acre | Distrito Federal | Goiás | Mato Grosso | Rondônia"; every AC and
 *     RO plant in ONS's capacity file carries `id_subsistema = SE`. This is
 *     the assignment most secondary sources get right and most intuitions get
 *     wrong, and it is why `SE` reaches the Peruvian border on the map.
 *  3. **Roraima is in `N`, and only since September 2025.** It was the last
 *     state outside the SIN; the 500 kV LT Manaus–Boa Vista energised
 *     10/09/2025 (EPE, *Informe Técnico: A Interligação de Roraima ao SIN*).
 *     Its thermal plants now carry `id_subsistema = N`. A map drawn from a
 *     source older than that will show Roraima as belonging to nothing.
 *
 * The other 24 assignments were confirmed the same way — every active plant in
 * the state carrying one `id_subsistema` — and against the EPE GET volumes for
 * Nordeste and Sul. Sul is the one exact match in the Anuário's table: the S
 * subsystem and the Sul region are both 12,994,382 consumers.
 *
 * ## The ambiguity that is real, and is not resolved here
 *
 * **Tocantins is split in ONS's own data.** The state's *load* is dispatched
 * in `N` — EPE's GET Norte covers Tocantins and gives it its own load forecast
 * (Fig. 4-8) — but all three of its hydro plants, UHE Lajeado, UHE Peixe
 * Angical and UHE São Salvador, carry `id_subsistema = SE`. The N/SE boundary
 * on the Norte–Sul interconnection runs north of Lajeado, so southern-Tocantins
 * generation settles in Sudeste/Centro-Oeste while the state's consumers
 * sit in Norte. **Tocantins is drawn in `N` here**, because this map is read
 * beside a curtailment forecast whose grain is the subsystem's load, and load
 * is the side that is unambiguous. A map of installed capacity would have to
 * draw it differently, and nothing here should be reused for one.
 *
 * Three other states carry the same kind of split at plant grain and are not
 * reflected in the polygons either — Pará (Teles Pires and São Manoel settle
 * in `SE`), Paraná (ITAIPU 60 Hz settles in `SE`), Bahia (the Serra das Almas
 * wind farms settle in `SE`). All three are single plants against a state, not
 * a boundary running through the state, so the polygon is not in question.
 *
 * ## What could not be verified
 *
 * **ONS publishes no prose document enumerating states per subsystem.** "O
 * Sistema em Números" and the SIN map pages render client-side and the map
 * downloads page returns nothing; the ONS evidence above is the machine-
 * readable capacity file, whose `id_subsistema` the data dictionary defines
 * as *the plant's* subsystem, not the state's. That is exactly why Tocantins
 * cannot be settled from ONS data alone. ANEEL Resolução 290/2000, which
 * secondary sources name as the legal definition of the submarket boundaries,
 * returns HTTP 403 from the ANEEL document store and was **not read**. The
 * partition below is therefore very well corroborated and not formally sourced
 * to the instrument that defines it.
 */

import { SUBSYSTEM_DISPLAY_ORDER, type SubsystemCode } from "@wattsteer/core";
import { BRAZIL_PROJECTION, SUBSYSTEM_ANCHOR, SUBSYSTEM_PATH_D } from "./brazil-geometry";

export {
  BRAZIL_PROJECTION,
  BRAZIL_VIEWBOX,
  STATE_BORDER_D,
} from "./brazil-geometry";

/**
 * A federal unit's two-letter code — the 26 states and the Distrito Federal.
 *
 * A plain string union rather than an enum, so the partition below is checked
 * at compile time for spelling and by `test/subsystem-map.test.ts` for
 * completeness. Neither check alone is enough: the type cannot tell that every
 * member appears exactly once, and the test cannot tell `RR` from `RN`.
 */
export type FederalUnit =
  | "AC"
  | "AL"
  | "AM"
  | "AP"
  | "BA"
  | "CE"
  | "DF"
  | "ES"
  | "GO"
  | "MA"
  | "MG"
  | "MS"
  | "MT"
  | "PA"
  | "PB"
  | "PE"
  | "PI"
  | "PR"
  | "RJ"
  | "RN"
  | "RO"
  | "RR"
  | "RS"
  | "SC"
  | "SE"
  | "SP"
  | "TO";

/** All 27, alphabetically. The set the partition below must exactly cover. */
export const FEDERAL_UNITS: readonly FederalUnit[] = [
  "AC",
  "AL",
  "AM",
  "AP",
  "BA",
  "CE",
  "DF",
  "ES",
  "GO",
  "MA",
  "MG",
  "MS",
  "MT",
  "PA",
  "PB",
  "PE",
  "PI",
  "PR",
  "RJ",
  "RN",
  "RO",
  "RR",
  "RS",
  "SC",
  "SE",
  "SP",
  "TO",
];

/**
 * The partition. See this module's header for what each contested member was
 * verified against; the surprising ones are MA in `N`, and AC and RO in `SE`.
 *
 * `SE` the subsystem and `SE` the federal unit (Sergipe) are the same two
 * letters and different things — Sergipe is in the `NE` subsystem, which is
 * the line below that looks like a typo and is not.
 */
export const SUBSYSTEM_UNITS: Record<SubsystemCode, readonly FederalUnit[]> = {
  N: ["AM", "AP", "MA", "PA", "RR", "TO"],
  NE: ["AL", "BA", "CE", "PB", "PE", "PI", "RN", "SE"],
  SE: ["AC", "DF", "ES", "GO", "MG", "MS", "MT", "RJ", "RO", "SP"],
  S: ["PR", "RS", "SC"],
};

/**
 * One `d` per subsystem, merged from exactly the units listed above.
 *
 * Re-exported through this module rather than imported from the generated one
 * directly, so that the polygons and the list that produced them are read from
 * the same place and a reader who changes one is looking at the other.
 */
export const SUBSYSTEM_PATH = SUBSYSTEM_PATH_D;

/** Where each subsystem's short code is printed on the map. */
export const SUBSYSTEM_LABEL_ANCHOR = SUBSYSTEM_ANCHOR;

/**
 * A WGS-84 point, in this map's viewBox coordinates.
 *
 * The inverse is not offered. Nothing in the product needs to read a latitude
 * off a click, and a function that pretends this projection is invertible to
 * any useful accuracy after the simplification in `./brazil-geometry.ts` would
 * be inviting somebody to try.
 */
export function projectToViewBox(
  lonDeg: number,
  latDeg: number,
): { x: number; y: number } {
  const cos = Math.cos((BRAZIL_PROJECTION.standardParallelDeg * Math.PI) / 180);
  return {
    x: (lonDeg * cos - BRAZIL_PROJECTION.lon0) * BRAZIL_PROJECTION.scale,
    y: (-latDeg - BRAZIL_PROJECTION.lat0) * BRAZIL_PROJECTION.scale,
  };
}

/** The subsystem a federal unit belongs to. Total over `FederalUnit`. */
export function subsystemOf(unit: FederalUnit): SubsystemCode {
  for (const code of SUBSYSTEM_DISPLAY_ORDER) {
    if (SUBSYSTEM_UNITS[code].includes(unit)) {
      return code;
    }
  }
  throw new RangeError(`${unit} is in no subsystem`);
}
