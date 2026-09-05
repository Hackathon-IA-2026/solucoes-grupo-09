/**
 * Trailing debounce, as a plain function.
 *
 * Mitigate writes the scenario into the address bar, and the address bar is
 * not a place to write on every keystroke: a stepper held down would push a
 * history entry per press, so the back button would walk back through thirty
 * intermediate fleets instead of returning to the one the reader arrived on.
 * `docs/specs/flex-optimizer.md` asks for the same restraint on the other side
 * of the wire — *"a slider drag is debounced client-side and hits the cache in
 * any case"* — because each committed scenario is a distinct hash, and a
 * distinct hash is a distinct cache key and, on a miss, a distinct solve.
 *
 * **Trailing, not leading.** The value that matters is the one the reader
 * stopped on; the twenty-nine before it are transit. A leading edge would
 * commit the first press and then the last, which is the worst of both.
 *
 * No React here on purpose: the timing rule is the part worth testing, and it
 * is testable without a renderer. `components/app/use-scenario.ts` is the binding.
 */

/**
 * The two clock functions, injected.
 *
 * A test that waits 400 ms to assert a 400 ms debounce is a test that is slow
 * and, on a loaded machine, flaky. Handing the timers in makes the timing rule
 * assertable against a fake clock instead — and `globalThis` is the default, so
 * no call site in the app passes anything.
 */
export interface Timers {
  setTimeout: (handler: () => void, ms: number) => number;
  clearTimeout: (handle: number) => void;
}

export interface Debounced<A extends readonly unknown[]> {
  /** Arm (or re-arm) the timer with these arguments. */
  call: (...args: A) => void;
  /** Run the pending call now, if there is one. */
  flush: () => void;
  /** Forget the pending call. Used on unmount, so a dead screen cannot write. */
  cancel: () => void;
  /** Whether a call is armed. */
  readonly pending: () => boolean;
}

export function debounce<A extends readonly unknown[]>(
  fn: (...args: A) => void,
  waitMs: number,
  timers: Timers = globalThis as unknown as Timers,
): Debounced<A> {
  let handle: ReturnType<Timers["setTimeout"]> | null = null;
  let latest: A | null = null;

  const cancel = () => {
    if (handle !== null) {
      timers.clearTimeout(handle);
      handle = null;
    }
    latest = null;
  };

  const run = () => {
    handle = null;
    if (latest === null) {
      return;
    }
    const args = latest;
    latest = null;
    fn(...args);
  };

  return {
    call: (...args: A) => {
      latest = args;
      if (handle !== null) {
        timers.clearTimeout(handle);
      }
      handle = timers.setTimeout(run, waitMs);
    },
    flush: () => {
      if (handle !== null) {
        timers.clearTimeout(handle);
        handle = null;
      }
      run();
    },
    cancel,
    pending: () => latest !== null,
  };
}

/**
 * How long a stepper may be held before the URL is written.
 *
 * Long enough that a run of presses is one history entry and one scenario
 * hash, short enough that a reader who stopped does not wonder whether the
 * link is stale.
 */
export const SCENARIO_COMMIT_MS = 400;
