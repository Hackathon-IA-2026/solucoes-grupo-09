/**
 * The display cut's second half — the merge, and only the merge.
 *
 * `@wattsteer/core/driver-display` holds the *selection* predicate
 * (`share >= 0.03`, capped at six rows) because the server needs it too: the
 * narration is assembled server-side and may only name a **displayed** group,
 * so a server that cannot tell which groups are displayed cannot obey its own
 * rule. There is one predicate rather than two that agree today.
 *
 * The *merge* is deliberately not in that package, and therefore not in
 * anything the API can import. Collapsing the remainder into one `other` row,
 * summing its `φ` and deciding whether that row reads `"mixed"` is a rendering
 * decision:
 *
 * > An `other` row reports `direction: "mixed"` when
 * > `Σ|φ_members| > 1.5 · |Σ φ_members|`, and `raises` / `lowers` otherwise.
 *
 * Publishing that rule from a shared package would put it within reach of the
 * server, which is exactly the duplication the split was written to prevent:
 * two implementations of a sign rule is how a bar chart quietly disagrees with
 * the paragraph above it. So `"mixed"` is computed here, once, in the client
 * that draws the bar — and this file is the only place in the repo that can
 * produce it.
 *
 * `docs/specs/diagnosis.md`, "Display, and the only place a sign can still be
 * lost"; `docs/specs/api-surface.md`, contract change 1.
 */

import { selectNotableDrivers } from "@wattsteer/core/driver-display";
import type {
  AttributedDriver,
  DisplayDriverCode,
  DriverDirection,
  DriverReading,
} from "@/lib/fixtures";

/**
 * The multiple of the net contribution the members' gross must exceed before
 * the merged row refuses to claim a direction. `docs/specs/diagnosis.md`.
 */
export const MIXED_DIRECTION_RATIO = 1.5;

/**
 * The disagreement at which a displayed group is said to have acted in both
 * directions during the day.
 *
 * The same number the narration uses for the same sentence
 * (`docs/specs/diagnosis.md`, `hour_disagreement >= 2.0`), so the bar and the
 * paragraph cannot disagree about which groups get the caveat.
 */
export const HOUR_DISAGREEMENT_NOTABLE = 2.0;

/**
 * One row of the bar chart: either one of the eight, or the merged remainder.
 *
 * `headlineFeature` and `hourDisagreement` are nullable here and not on
 * `Driver`, because the merged row has neither — several groups' headline
 * features are not one headline feature, and several groups' hour
 * disagreements are not one number. Writing `""` or `0` would be inventing
 * both.
 */
export interface DriverRow {
  code: DisplayDriverCode;
  phiMwh: number;
  share: number;
  direction: DriverDirection;
  headlineFeature: string | null;
  observed: DriverReading;
  typical: DriverReading;
  hourDisagreement: number | null;
  demoted: boolean;
  /** How many groups this row stands for. One, except on the merged row. */
  memberCount: number;
}

/**
 * The eight ranked groups, as the rows the screen draws.
 *
 * All eight arrive; the cut happens here. What survives the selection is drawn
 * as itself, and everything else — however many groups that is — becomes one
 * `other` row whose `φ` is the signed sum of what it absorbed and whose share
 * is the sum of theirs. The shares still sum to 1 afterwards, because the
 * denominator was fixed over all eight before any of this ran.
 *
 * The remainder is dropped entirely when it is empty rather than drawn as a
 * zero-height bar labelled "everything else", which would claim there was a
 * remainder when there was none.
 *
 * **Demotion is applied here and nowhere else.** A `demote` rule's whole
 * effect is to force a group below the fold regardless of its `|share|`, so a
 * demoted group is still *selected* — `driver-display.ts` is explicit that a
 * rule may never delete a driver — and it is this ordering step that carries
 * out the sentence the screen puts under it. Its `φ`, its sign and its share
 * are untouched, which is the other half of the same rule.
 */
export function driverRows(drivers: readonly AttributedDriver[]): DriverRow[] {
  const selected = selectNotableDrivers(drivers);
  // Membership by identity, the same test `includes` was making — through a
  // set so the partition below is one pass rather than one per driver.
  const isSelected = new Set(selected);
  const merged = drivers.filter((driver) => !isSelected.has(driver));
  const ordered = [
    ...selected.filter((driver) => !driver.demoted),
    ...selected.filter((driver) => driver.demoted),
  ];
  const rows: DriverRow[] = ordered.map((driver) => ({
    code: driver.code,
    phiMwh: driver.phiMwh,
    share: driver.share,
    direction: driver.direction,
    headlineFeature: driver.headlineFeature,
    observed: driver.observed,
    typical: driver.typical,
    hourDisagreement: driver.hourDisagreement,
    demoted: driver.demoted,
    memberCount: 1,
  }));
  return merged.length === 0 ? rows : [...rows, mergeRemainder(merged)];
}

/** The `other` row — the one row in the product that may be `"mixed"`. */
function mergeRemainder(members: readonly AttributedDriver[]): DriverRow {
  const net = members.reduce((total, driver) => total + driver.phiMwh, 0);
  const gross = members.reduce((total, driver) => total + Math.abs(driver.phiMwh), 0);
  return {
    code: "other",
    phiMwh: net,
    share: members.reduce((total, driver) => total + driver.share, 0),
    direction: mergedDirection(net, gross),
    headlineFeature: null,
    observed: { kind: "none" },
    typical: { kind: "none" },
    hourDisagreement: null,
    // A merged row is not demoted: demotion is a rule's statement about one
    // group, and there is no group here to make it about.
    demoted: false,
    memberCount: members.length,
  };
}

/**
 * The sign rule, in the one place it exists.
 *
 * `gross > 1.5 · |net|` means the members largely cancelled: whatever sign the
 * sum happens to carry, it is not a fact about the remainder, and saying
 * "lowers" would be reporting the residue of a cancellation as a direction.
 */
export function mergedDirection(net: number, gross: number): DriverDirection {
  if (gross > MIXED_DIRECTION_RATIO * Math.abs(net)) {
    return "mixed";
  }
  return net >= 0 ? "raises" : "lowers";
}
