import { describe, expect, it } from "bun:test";
import { GATES } from "@wattsteer/core";
import { gateProfileOf } from "../src/components/app/params";
import { RUN_LABELS } from "../src/lib/fixtures";

/**
 * `gateProfileOf` — which gate a weather-run label names.
 *
 * Derived from the published gate table rather than written as a literal pair,
 * and the docstring says why: it "fails to compile if a `RunLabel` ever names
 * no gate at all". Compilation is not the whole of it. The table is data, so a
 * gate whose `weatherRun` moves at *runtime* — a schedule change, a third run —
 * does not fail to compile, it throws. That throw is deliberate, and it is the
 * behaviour worth pinning: a gate guessed here "would send the reader a
 * forecast from a run other than the one the pill they pressed says".
 */

describe("every run label the UI can produce resolves to a gate", () => {
  it("all of RUN_LABELS map to a published profile", () => {
    for (const run of RUN_LABELS) {
      const profile = gateProfileOf(run);
      expect({ run, profile: typeof profile }).toEqual({ run, profile: "string" });
      // And it is a profile the table actually publishes, not a plausible
      // string — the pills are the only way into this function.
      expect(GATES.some((gate) => gate.profile === profile)).toBe(true);
    }
  });

  it("the two runs name different gates, or the selector chooses nothing", () => {
    const profiles = RUN_LABELS.map(gateProfileOf);
    expect(new Set(profiles).size).toBe(RUN_LABELS.length);
  });

  it("the mapping agrees with the table, field for field", () => {
    // The derivation, checked against its source. A hand-written pair that
    // happened to be right today is the thing this function exists not to be.
    for (const gate of GATES) {
      expect({ run: gate.weatherRun, profile: gateProfileOf(gate.weatherRun) }).toEqual({
        run: gate.weatherRun,
        profile: gate.profile,
      });
    }
  });
});

describe("a run no gate sees throws rather than defaulting", () => {
  it("refuses an unknown label", () => {
    // The unreachable branch, reached. Defaulting here would answer with some
    // other gate's forecast under the label the reader pressed — a wrong
    // number that looks exactly like a right one.
    expect(() => gateProfileOf("06Z" as never)).toThrow(RangeError);
  });

  it("names the run in the message, so an operator knows which one", () => {
    expect(() => gateProfileOf("18Z" as never)).toThrow(/18Z/);
  });
});
