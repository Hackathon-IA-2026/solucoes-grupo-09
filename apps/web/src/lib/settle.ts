/**
 * A `setState` that stops mattering once its request has been abandoned.
 *
 * Four hooks read the gateway — `use-network`, `use-explain`, `use-replay`,
 * `use-optimization` — and between them they carried **fourteen** copies of the
 * same two lines: check `signal.aborted`, then set state. Every one of them is
 * load-bearing and every one of them is invisible when missing. A forgotten
 * guard does not throw; it writes an answer about a question the reader has
 * already navigated away from, and the symptom is a screen that flickers back
 * to a previous subsystem a second after you left it.
 *
 * `settleWith` makes the guard structural. A hook builds one of these per
 * effect and then calls it exactly as it used to call `setState`, with no
 * condition around it — so a *missing* guard is not something you can write.
 *
 * **Deliberately not a hook, and deliberately not a fetch wrapper.** The four
 * hooks' state unions differ on purpose — `observedOnly` means something
 * different on the Overview than in Replay, and `use-explain` has a fifth arm —
 * and `use-replay` runs a second request when the first refuses with one
 * specific code. A `useGatewayRead<T>` that owned the request and the states
 * would need every one of those as a parameter, which is an interface as
 * complicated as the four bodies it replaced. This owns the one thing they
 * genuinely share and leaves the rest where it reads.
 */

/**
 * Bind a setter to a signal.
 *
 * The returned function applies its argument while the signal is live and does
 * nothing after it aborts. It is safe to call any number of times, before or
 * after the abort, which is what lets a `.then` and a `.catch` on the same
 * promise both use it without either checking first.
 */
export function settleWith<T>(
  signal: AbortSignal,
  apply: (value: T) => void,
): (value: T) => void {
  return (value: T) => {
    if (!signal.aborted) {
      apply(value);
    }
  };
}
