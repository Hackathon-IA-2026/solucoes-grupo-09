/**
 * The display cut, and only the display cut.
 *
 * `docs/specs/diagnosis.md` splits the Explain screen's driver rule into two
 * halves and gives them to different owners, in a sentence worth restating
 * because it looks like a contradiction until you read it twice:
 *
 * > **The selection predicate is shared; the merge is not.**
 *
 * The *selection* — `share >= 0.03`, capped at six rows — has to run on the
 * server as well as in the client, because the narration is assembled
 * server-side and the spec requires it to say that a driver "acted in both
 * directions during the day" for any **displayed** group with
 * `hour_disagreement >= 2.0`. A server that cannot tell which groups are
 * displayed cannot obey that rule. So the predicate lives here, in the package
 * both sides import, and there is one of it rather than two that agree today.
 *
 * The *merge* is deliberately **absent from this file**. Collapsing the
 * remainder into one `other` row, summing its `phi` and deciding whether that
 * row reads `"mixed"` is a rendering decision, and `"mixed"` is a third
 * direction that exists nowhere on the wire. Publishing that here would put it
 * within reach of the server, which is exactly the duplication the rule was
 * written to prevent: two implementations of a sign rule is how a bar chart
 * quietly disagrees with the paragraph above it.
 *
 * The API returns all eight groups ranked by `|share|` whatever this selects.
 * Nothing here filters a response.
 */

/**
 * The smallest share a group may have and still be named.
 *
 * `share_j = |phi_j| / sum_k |phi_k|` over **all eight** groups — the
 * denominator is the whole attributed movement, not the rows that survive this
 * cut, which was the circular definition `api-surface.md` had to correct. So
 * the cut has a fixed denominator to act on and this constant means the same
 * thing on both sides of the wire.
 */
export const NOTABLE_SHARE_MIN = 0.03;

/** At most six rows. The screen's height, and the paragraph's attention span. */
export const NOTABLE_DRIVER_LIMIT = 6;

/**
 * The groups the screen shows and the narration may name.
 *
 * Order is preserved, so a ranked input yields a ranked output; the cap is
 * applied after the share cut, so six notable groups beat seven marginal ones
 * rather than the other way round. Generic over the row type because the
 * server holds a database row and the client holds a decoded wire object, and
 * neither should have to convert to the other's shape to ask this question.
 *
 * A `demoted` group is **still selected here**. Demotion is a rule's decision
 * about where a row sits on the screen, not about whether the group exists,
 * and a rule may never delete a driver — so the flag travels with the row and
 * the renderer decides what to do about it.
 */
export function selectNotableDrivers<T extends { readonly share: number }>(
  drivers: readonly T[],
): T[] {
  return drivers
    .filter((driver) => driver.share >= NOTABLE_SHARE_MIN)
    .slice(0, NOTABLE_DRIVER_LIMIT);
}
