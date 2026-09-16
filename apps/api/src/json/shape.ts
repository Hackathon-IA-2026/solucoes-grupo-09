/**
 * Reading untyped JSON, without deciding what to do about it.
 *
 * Six modules in this gateway carry a byte-identical `isRecord`, and each one
 * reads a body that crossed a boundary TypeScript cannot see past — the
 * modelling service's responses, a published payload, a narration document.
 * This is that one function, and the two or three beside it that everything
 * else was spelling out inline.
 *
 * **It decides nothing.** That is the whole shape of this module, and it is the
 * finding that produced it. The obvious deepening here was one `mlRead(path,
 * shape)` adapter turning an upstream body into a typed value or a typed
 * refusal — until reading the two callers showed their policies are *opposite*,
 * both deliberately, both in writing:
 *
 *  - `api/model-card.ts` **refuses**: "a card missing one of its groups is not
 *    a partially valid card". A field it cannot read is a refusal, and the
 *    screen renders it.
 *  - `api/meta.ts` **never throws**: "a service answering 200 with an
 *    unreadable body is a broken service and not a broken gateway". It is the
 *    endpoint you read *to find out* something is wrong, so it degrades to a
 *    stated absence and names which half it could not read.
 *
 * An adapter serving both would carry a refuse-or-degrade flag, which is one
 * interface pretending to be two contracts. So the split is at the honest
 * seam: **shape here, policy at the call site.** Every function below answers
 * "is this a string?" and returns `undefined` when it is not. What that absence
 * means is the caller's to say, and both callers already say it.
 */

/** A JSON object — not an array, not `null`, both of which `typeof` calls one. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A finite number, or `undefined`.
 *
 * `Number.isFinite` and not `typeof === "number"`: JSON cannot carry `NaN` or
 * an infinity, but a body that has been through a lossy transform can, and a
 * `NaN` that reaches a chart is an axis with no scale rather than an error.
 */
export function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * A non-empty string, or `undefined`.
 *
 * Empty counts as absent everywhere this is used — an empty `run_label` is not
 * a run and an empty `message` is not a message — and a caller that genuinely
 * wants to keep `""` should read the field itself rather than ask for a
 * different helper.
 */
export function asString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * A member of a closed set, or `undefined` — **never the nearest member.**
 *
 * The reason this exists rather than a ternary at each call site: a ternary has
 * a fallback arm, and every fallback arm here would be a label applied to a
 * value nobody recognised. A card claiming a third vintage fidelity rounded
 * down to `revision_optimistic` is a metric filed under a caveat it was never
 * measured with. `test/contract.test.ts` fails any file that writes that
 * ternary, and this is what it should write instead.
 */
export function asOneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
): T | undefined {
  const text = asString(value);
  return text !== undefined && (allowed as readonly string[]).includes(text)
    ? (text as T)
    : undefined;
}
