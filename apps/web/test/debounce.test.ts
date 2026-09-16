import { describe, expect, it } from "bun:test";
import { debounce, SCENARIO_COMMIT_MS, type Timers } from "../src/lib/debounce";

/**
 * The trailing debounce that keeps a held stepper out of the history stack.
 *
 * The module's own header states what it is preventing: *"a stepper held down
 * would push a history entry per press, so the back button would walk back
 * through thirty intermediate fleets instead of returning to the one the reader
 * arrived on."* On the other side of the wire each committed scenario is a
 * distinct hash, and a distinct hash is a distinct cache key and, on a miss, a
 * distinct solve — so a leading-edge or un-debounced write is thirty MILP runs.
 *
 * Tested against a fake clock, which the module takes an injected `Timers` for
 * precisely so that a 400 ms rule does not need a 400 ms test.
 */

/** A clock a test drives by hand. */
function fakeTimers() {
  let now = 0;
  let next = 1;
  const scheduled = new Map<number, { at: number; run: () => void }>();
  const timers: Timers = {
    setTimeout: (handler, ms) => {
      const id = next++;
      scheduled.set(id, { at: now + ms, run: handler });
      return id;
    },
    clearTimeout: (id) => {
      scheduled.delete(id);
    },
  };
  return {
    timers,
    /** Advance the clock, firing anything due. */
    tick(ms: number) {
      now += ms;
      for (const [id, entry] of [...scheduled]) {
        if (entry.at <= now) {
          scheduled.delete(id);
          entry.run();
        }
      }
    },
    outstanding: () => scheduled.size,
  };
}

describe("trailing, not leading — the value that matters is the one they stopped on", () => {
  it("a burst of calls commits once, with the last arguments", () => {
    const clock = fakeTimers();
    const seen: number[] = [];
    const d = debounce((n: number) => seen.push(n), 400, clock.timers);
    for (const n of [1, 2, 3, 4, 5]) {
      d.call(n);
      clock.tick(50);
    }
    // Nothing yet: every press reset the timer.
    expect(seen).toEqual([]);
    clock.tick(400);
    // One commit, and it is the *last* value — not the first, which a leading
    // edge would have taken, and not all five.
    expect(seen).toEqual([5]);
  });

  it("two bursts separated by a pause are two commits", () => {
    const clock = fakeTimers();
    const seen: number[] = [];
    const d = debounce((n: number) => seen.push(n), 400, clock.timers);
    d.call(1);
    clock.tick(400);
    d.call(2);
    clock.tick(400);
    expect(seen).toEqual([1, 2]);
  });

  it("each call clears the previous timer rather than stacking them", () => {
    const clock = fakeTimers();
    const d = debounce(() => {}, 400, clock.timers);
    d.call();
    d.call();
    d.call();
    // Three presses, one pending timer. Stacked timers would fire three times
    // and write three history entries — the defect this exists to prevent.
    expect(clock.outstanding()).toBe(1);
  });
});

describe("flush commits now, and cancel throws the value away", () => {
  it("flush runs the pending call immediately", () => {
    const clock = fakeTimers();
    const seen: number[] = [];
    const d = debounce((n: number) => seen.push(n), 400, clock.timers);
    d.call(7);
    d.flush();
    expect(seen).toEqual([7]);
    // And the timer is gone, so the clock cannot fire it a second time.
    clock.tick(400);
    expect(seen).toEqual([7]);
  });

  it("flush with nothing pending does nothing rather than calling with stale arguments", () => {
    const clock = fakeTimers();
    const seen: number[] = [];
    const d = debounce((n: number) => seen.push(n), 400, clock.timers);
    d.call(1);
    d.flush();
    d.flush();
    // The second flush must not re-commit `1`. Re-running the last value is a
    // duplicate history entry and a duplicate solve for a scenario nobody
    // asked for twice.
    expect(seen).toEqual([1]);
  });

  it("cancel drops the pending value entirely", () => {
    const clock = fakeTimers();
    const seen: number[] = [];
    const d = debounce((n: number) => seen.push(n), 400, clock.timers);
    d.call(9);
    d.cancel();
    clock.tick(400);
    expect(seen).toEqual([]);
    expect(clock.outstanding()).toBe(0);
  });

  it("cancel then flush commits nothing", () => {
    const clock = fakeTimers();
    const seen: number[] = [];
    const d = debounce((n: number) => seen.push(n), 400, clock.timers);
    d.call(9);
    d.cancel();
    d.flush();
    expect(seen).toEqual([]);
  });
});

describe("pending reports whether a value is waiting", () => {
  it("is false before a call, true after, false once committed", () => {
    const clock = fakeTimers();
    const d = debounce(() => {}, 400, clock.timers);
    expect(d.pending()).toBe(false);
    d.call();
    expect(d.pending()).toBe(true);
    clock.tick(400);
    expect(d.pending()).toBe(false);
  });

  it("is false after a cancel", () => {
    const clock = fakeTimers();
    const d = debounce(() => {}, 400, clock.timers);
    d.call();
    d.cancel();
    expect(d.pending()).toBe(false);
  });
});

describe("the commit window is a number somebody chose", () => {
  it("is long enough to swallow a held stepper and short enough not to feel stale", () => {
    // Not a magic number: the header argues both bounds. Pinned so a change is
    // a decision rather than a drift.
    expect(SCENARIO_COMMIT_MS).toBe(400);
    expect(SCENARIO_COMMIT_MS).toBeGreaterThanOrEqual(200);
    expect(SCENARIO_COMMIT_MS).toBeLessThanOrEqual(800);
  });
});
