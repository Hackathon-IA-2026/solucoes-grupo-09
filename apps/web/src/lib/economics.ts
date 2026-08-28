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

/** Brazilian thousands separator, so money never renders in the en-US style. */
export function formatBrl(value: number): string {
  return Math.round(value).toLocaleString("pt-BR");
}
