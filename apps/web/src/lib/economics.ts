/**
 * The single economic assumption WattSteer puts on screen, and the only place
 * it is written down.
 *
 * The map's standing preference is that MWh recovered and % avoided are the
 * headline KPIs, and that money appears **only** as a labelled scenario with
 * its assumed rate visible — because curtailment compensation and pricing are
 * live regulatory questions, not settled ones. A duplicated rate would let two
 * surfaces quote different money from the same energy, which is exactly the
 * kind of quiet inconsistency that costs a product its credibility.
 */

/** Assumed value of recovered energy. A scenario input, never a market price. */
export const SCENARIO_BRL_PER_MWH = 180;

// There is deliberately no formatter here. Money is written by
// `i18n/format.ts`'s `formatBrl`, which is locale-aware and always BRL; a
// second one pinned to `pt-BR` used to live here, and two money formatters
// that disagree about the same rate is exactly the inconsistency the constant
// above exists to prevent.
