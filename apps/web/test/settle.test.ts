import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { settleWith } from "../src/lib/settle";

/**
 * The guard that used to be written out twenty-three times, and the one failure
 * it prevents.
 *
 * A `setState` that lands after its effect was torn down does not throw. It
 * writes an answer about a question the reader has already navigated away from
 * — a screen that flickers back to the previous subsystem a second after you
 * left it. That is why every read hook checked `signal.aborted` before every
 * set, and why a forgotten check was invisible.
 *
 * The last describe block is the half that makes this structural rather than
 * available: `settle.ts` took fourteen of the copies and left nine, so two
 * hooks went on hand-rolling the guard and a reader of either would have
 * concluded that hand-rolling it is how this is done here.
 */

describe("a settled value lands while the request is live", () => {
  it("applies before the abort", () => {
    const controller = new AbortController();
    const seen: string[] = [];
    const settle = settleWith(controller.signal, (value: string) => seen.push(value));
    settle("read");
    expect(seen).toEqual(["read"]);
  });

  it("applies more than once — a hook sets `reading` then the answer", () => {
    const controller = new AbortController();
    const seen: string[] = [];
    const settle = settleWith(controller.signal, (value: string) => seen.push(value));
    settle("reading");
    settle("read");
    expect(seen).toEqual(["reading", "read"]);
  });
});

describe("a settled value is dropped once the request is abandoned", () => {
  it("does nothing after abort", () => {
    const controller = new AbortController();
    const seen: string[] = [];
    const settle = settleWith(controller.signal, (value: string) => seen.push(value));
    controller.abort();
    settle("too late");
    expect(seen).toEqual([]);
  });

  it("drops every later call, not just the first", () => {
    const controller = new AbortController();
    const seen: string[] = [];
    const settle = settleWith(controller.signal, (value: string) => seen.push(value));
    controller.abort();
    settle("a");
    settle("b");
    expect(seen).toEqual([]);
  });

  it("the abort mid-flight is the real case: one lands, the next does not", () => {
    // Exactly the shape of a hook whose key changed while a request was open:
    // the `reading` state was already set, then the effect is torn down, then
    // the response arrives.
    const controller = new AbortController();
    const seen: string[] = [];
    const settle = settleWith(controller.signal, (value: string) => seen.push(value));
    settle("reading");
    controller.abort();
    settle("read");
    expect(seen).toEqual(["reading"]);
  });

  it("reads the signal at call time, not at bind time", () => {
    // The whole mechanism depends on this: the binding is made *before* the
    // request starts and must see an abort that happens afterwards. A version
    // that captured `signal.aborted` when it was built would let every late
    // answer through.
    const controller = new AbortController();
    let landed = false;
    const settle = settleWith(controller.signal, () => {
      landed = true;
    });
    expect(controller.signal.aborted).toBe(false);
    controller.abort();
    settle(undefined as never);
    expect(landed).toBe(false);
  });
});

describe("it is a function of the signal, not of a shared flag", () => {
  it("two settlers on two controllers do not interfere", () => {
    const first = new AbortController();
    const second = new AbortController();
    const seen: string[] = [];
    const a = settleWith(first.signal, (v: string) => seen.push(`a:${v}`));
    const b = settleWith(second.signal, (v: string) => seen.push(`b:${v}`));
    first.abort();
    a("dropped");
    b("kept");
    expect(seen).toEqual(["b:kept"]);
  });
});

/**
 * The source of every hook that reads the gateway.
 *
 * Walked rather than listed, so a tenth hook is governed the day it is written
 * — an allow-list would have to be remembered, which is the property this
 * module exists to remove.
 */
const HOOKS = join(import.meta.dir, "..", "src", "components", "app");

function readHooks(
  directory: string,
  found: [string, string][] = [],
): [string, string][] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      readHooks(full, found);
    } else if (entry.name.startsWith("use-") && entry.name.endsWith(".ts")) {
      found.push([entry.name, readFileSync(full, "utf8")]);
    }
  }
  return found;
}

describe("no hook hand-rolls the guard this module makes structural", () => {
  const hooks = readHooks(HOOKS);

  it("the walk found the hooks, so an empty offender list means something", () => {
    // Measured when this was written: nine hooks under `components/app`, five
    // of which were still checking `signal.aborted` by hand.
    expect(hooks.length).toBeGreaterThan(5);
    expect(hooks.map(([name]) => name)).toContain("use-network.ts");
  });

  it("every hook that aborts a request settles through `settleWith`", () => {
    // The pair is the rule: a hook that builds an `AbortController` is a hook
    // that can outlive its answer, and `settleWith` is how it says so.
    const offenders = hooks
      .filter(([, source]) => source.includes("new AbortController()"))
      .filter(([, source]) => !source.includes("settleWith"))
      .map(([name]) => name);
    expect(offenders).toEqual([]);
  });

  it("no hook guards a `setState` with the flag by hand", () => {
    /*
      The check that would have caught the five, scoped to what it governs.
      `settleWith` is available either way; what makes the guard structural is
      that there is no second way to write *this* — so a hook cannot express a
      set that forgot its guard, and cannot express a guard that drifts from
      the setter it protects.
    */
    const offenders = hooks
      .filter(([, source]) =>
        /if\s*\(\s*!?[\w.]*signal\s*\.\s*aborted\s*\)\s*\{\s*(?:\/\/[^\n]*\n\s*)*setState\(/.test(
          source,
        ),
      )
      .map(([name]) => name);
    expect(offenders).toEqual([]);
  });

  it("the by-hand check would catch the form it was written for", () => {
    // `testing.md`: a repository-wide check ships with the mutation proving it
    // is not vacuous. This is the exact shape the five hooks carried, in both
    // spellings, before this pass.
    const HAND_ROLLED =
      /if\s*\(\s*!?[\w.]*signal\s*\.\s*aborted\s*\)\s*\{\s*(?:\/\/[^\n]*\n\s*)*setState\(/;
    for (const mutant of [
      'if (!controller.signal.aborted) {\n  setState({ status: "read" });\n}',
      "if (!signal.aborted) {\n  // a comment between the two\n  setState(x);\n}",
    ]) {
      expect({ mutant, caught: HAND_ROLLED.test(mutant) }).toEqual({
        mutant,
        caught: true,
      });
    }
    // And it does not fire on the early return, which is a different question.
    expect(HAND_ROLLED.test("if (controller.signal.aborted) {\n  return;\n}")).toBe(
      false,
    );
  });

  it("the one remaining read of the flag is not about setting state", () => {
    /*
      `use-replay.ts` still asks the signal directly, and it is right to. Its
      `.catch` returns early before deciding whether to issue a **second**
      request — the pre-holdout retry — so the question there is "should more
      work start", not "should this answer land". `settleWith` cannot express
      that and should not: a settler wrapped around a fetch would be a fetch
      that ran anyway.

      Pinned rather than exempted, so the distinction stays deliberate. A sixth
      hook reaching for the flag has to come here and say which of the two
      questions it is asking.
    */
    const reading = hooks
      .filter(([, source]) => /\.\s*signal\s*\.\s*aborted/.test(source))
      .map(([name]) => name);
    expect(reading).toEqual(["use-replay.ts"]);
    const replay = hooks.find(([name]) => name === "use-replay.ts")?.[1] ?? "";
    // It settles through the module like every other hook; the bare read is
    // the extra question, not a substitute for the guard.
    expect(replay).toContain("settleWith(");
    expect(replay).toContain("if (controller.signal.aborted) {\n          return;");
  });
});
