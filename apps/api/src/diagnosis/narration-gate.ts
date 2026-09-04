import type { FiredRule, RuleAction } from "./publication.js";

/**
 * What `withhold` actually does — and the one place it is allowed to do it.
 *
 * `docs/specs/diagnosis.md`'s rule table gives a rule three actions and, for
 * every one of them, the same prohibition: **it may never change a number and
 * never delete a driver.** `annotate` and `demote` land in the stored row, and
 * `apps/ml`'s rules engine is where they are decided. `withhold` is the one
 * action whose effect is not a column: it suppresses the *model* narration and
 * the deterministic template renders instead.
 *
 * So this module exists to make one sentence true of the code rather than of a
 * review:
 *
 * > A `withhold` rule means the language model is **never called** — asserted
 * > on the client not being invoked, not on its output being discarded.
 *
 * Two things make that structural rather than intended:
 *
 * 1. **The model narration arrives as a thunk.** `renderNarration` is handed a
 *    function it may decline to call, so "never called" is a property of the
 *    control flow. A version that took the model's text as a value would have
 *    already spent the call before the gate could decide anything, and the only
 *    honest assertion left would be about discarding it — which the spec
 *    explicitly refuses.
 * 2. **The gate is never handed the drivers.** Its whole input is the fired
 *    rules. It cannot filter a driver list, empty one or re-rank one, because
 *    it cannot see one. `api-surface.md` originally had a withheld response
 *    return `drivers: []`; that violated the valve, and the corrected contract
 *    is a **200 carrying the drivers untouched**, `withheld_by` naming the
 *    rules, and a template paragraph in place of the model's.
 *
 * The narration surfaces themselves — the prompt, the cache, the validators and
 * the template's message keys — are `api-surface.md` ticket 10's. This is the
 * decision they hang off.
 */

/** Which narration surface rendered. The panel's footnote states it. */
export type NarrationSource = "model" | "template";

/**
 * The one action whose effect is not a stored column.
 *
 * `withhold` > `demote` > `annotate` orders strictness; only the strictest
 * matters here, and only when it is this one.
 */
const WITHHOLD: RuleAction = "withhold";

/** Whether the model may render, and which rules said otherwise. */
export interface NarrationDecision {
  source: NarrationSource;
  /**
   * The codes of the rules that withheld, in the order they fired. Published
   * as `withheld_by`, **beside** an untouched ranking.
   */
  withheldBy: string[];
}

/**
 * The two ways a paragraph can be produced.
 *
 * `model` is a thunk on purpose — see the module note. `template` is not a
 * fallback here: on a withheld day the deterministic sentence is the honest
 * one, and it is the only one the panel is allowed to show.
 */
export interface NarrationRenderers<T> {
  model: () => Promise<T>;
  template: () => T;
}

/** A rendered paragraph and the account of which surface produced it. */
export interface RenderedNarration<T> extends NarrationDecision {
  narration: T;
}

/**
 * Read the fired rules and decide which surface may render.
 *
 * Takes the flags and nothing else: a decision function that could see the
 * attribution is a decision function that could edit it.
 *
 * @param ruleFlags every rule that fired, as stored on the attribution row.
 */
export function narrationDecision(ruleFlags: readonly FiredRule[]): NarrationDecision {
  const withheldBy = ruleFlags
    .filter((flag) => flag.action === WITHHOLD)
    .map((flag) => flag.code);
  return { source: withheldBy.length > 0 ? "template" : "model", withheldBy };
}

/**
 * Render the narration through whichever surface the rules permit.
 *
 * When a rule withheld, `renderers.model` is **not invoked**. Not awaited and
 * discarded, not raced, not cached for later: not called.
 *
 * @param ruleFlags every rule that fired, as stored on the attribution row.
 * @param renderers the model call, as a thunk, and the deterministic template.
 */
export async function renderNarration<T>(
  ruleFlags: readonly FiredRule[],
  renderers: NarrationRenderers<T>,
): Promise<RenderedNarration<T>> {
  const decision = narrationDecision(ruleFlags);
  if (decision.source === "template") {
    return { ...decision, narration: renderers.template() };
  }
  return { ...decision, narration: await renderers.model() };
}
