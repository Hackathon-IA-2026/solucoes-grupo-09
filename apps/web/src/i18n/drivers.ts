/**
 * A driver row, said in the reader's language and notation.
 *
 * Split out of `components/charts/driver-bars.tsx` for the same reason
 * `./narration.ts` is split out of the Explain screen: these are the decisions
 * worth testing — which dictionary key a code resolves to, how a categorical
 * reading is written, whether a sign is printed — and none of them needs a
 * React tree to be true. A test that had to mount React Native to check that
 * `other` is not looked up in `drivers.groups` would be testing the renderer.
 *
 * Everything here is at the edge, by rule: the fixture and the API carry
 * codes, values and units, and the words and the digit grouping are chosen
 * here, once, per locale.
 */

import type { DisplayDriverCode, DriverReading } from "@/lib/fixtures";
import type { Copy } from "./copy.en";
import type { Formatters } from "./format";

/**
 * A feature reading, written in the reader's convention.
 *
 * The fixture stores `{ value: 1900, unit: "MW" }`, never `"1,900 MW"` —
 * a preformatted string bakes in en-US grouping, and `"weekend"` bakes in
 * English. Both decisions belong here.
 *
 * `null` for a `none` reading, and the caller omits the line rather than
 * printing an empty pair: a group with no reading at serve time has nothing to
 * show, which is not the same as having read zero.
 */
export function formatReading(
  reading: DriverReading,
  copy: Copy,
  f: Formatters,
): string | null {
  if (reading.kind === "none") {
    return null;
  }
  if (reading.kind === "term") {
    return copy.app.drivers.terms[reading.term];
  }
  const magnitude = f.number(reading.value, reading.decimals ?? 0);
  const signed = reading.signed && reading.value > 0 ? `+${magnitude}` : magnitude;
  return reading.unit === undefined ? signed : `${signed} ${reading.unit}`;
}

/**
 * The words for a row's code.
 *
 * The eight are named in `drivers.groups`; the merged remainder is named
 * separately, because it is not a group and a dictionary that listed it beside
 * the eight would be claiming there are nine.
 */
export function driverLabel(code: DisplayDriverCode, copy: Copy): string {
  return code === "other" ? copy.app.drivers.merged : copy.app.drivers.groups[code];
}

/**
 * `+128,0 MWh` — the signed contribution, with the sign always written.
 *
 * For both signs, and beside the arrow rather than instead of it: a bare
 * "128,0 MWh" under a downward arrow makes two claims about direction and
 * leaves only one of them checkable. The minus is U+2212, not a hyphen.
 */
export function formatContribution(phiMwh: number, f: Formatters): string {
  const magnitude = f.number(Math.abs(phiMwh), 1);
  return phiMwh < 0 ? `−${magnitude}` : `+${magnitude}`;
}
