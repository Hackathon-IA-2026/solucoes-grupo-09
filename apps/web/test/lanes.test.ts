import { describe, expect, it } from "bun:test";
import {
  anyServing,
  gateIsInert,
  type Lane,
  lanesOf,
  serves,
  servingLaneFor,
} from "../src/lib/lanes";

/**
 * The lane table, as values.
 *
 * Every assertion here used to be impossible. The rule was written three times
 * — in `absence.ts`, in `use-model-card.ts` and in `use-run-lanes.ts` — each
 * behind a React hook, so the only way to pin it was to quote the source:
 * `wired-screens.test.ts` asserted the `.some(...)` expression and the
 * `.find(...)` expression verbatim, and `observed-overview.test.ts` two more
 * fragments. Renaming a loop variable broke the suite; changing the rule in two
 * of the three places broke nothing.
 *
 * What follows is the table those greps were standing in for.
 */

function lane(over: Partial<Lane> = {}): Lane {
  return {
    name: "dessem_free_v1__gate_late__thr5",
    condition: "promoted",
    usable: undefined,
    ...over,
  };
}

describe("a lane serves only when promoted and not reported unusable", () => {
  it("promoted and usable serves", () => {
    expect(serves(lane({ condition: "promoted", usable: true }))).toBe(true);
  });

  it("promoted but refused by the hot-swap gate does not", () => {
    // An artifact marked invalid against the live feature contract is promoted
    // and still serves nothing, which is why `condition` alone is not the test.
    expect(serves(lane({ condition: "promoted", usable: false }))).toBe(false);
  });

  it("`usable: undefined` is unknown, and a promoted lane keeps the benefit", () => {
    // The tri-state rule. `undefined` is the modelling service being too old to
    // report it, and rounding that down to a refusal would call a lane broken
    // on a field that was never sent.
    expect(serves(lane({ condition: "promoted", usable: undefined }))).toBe(true);
  });

  it("nothing but `promoted` serves, whatever `usable` says", () => {
    for (const condition of [
      "present_unpromoted",
      "no_artifact",
      "unresolvable",
    ] as const) {
      expect(serves(lane({ condition, usable: true }))).toBe(false);
    }
  });
});

describe("anyServing is the question the chrome asks", () => {
  it("true when one of several lanes serves", () => {
    expect(
      anyServing([
        lane({ name: "a__gate_late__thr5", condition: "present_unpromoted" }),
        lane({ name: "a__gate_early__thr5", condition: "promoted" }),
      ]),
    ).toBe(true);
  });

  it("false on an empty table, which is the unreachable modelling service", () => {
    // Correct rather than incidental: nothing can be served, and the reason is
    // on `model.reachable` for whoever needs it.
    expect(anyServing([])).toBe(false);
  });
});

describe("servingLaneFor wants a lane that answers, not one that matches", () => {
  it("finds the lane whose name carries the gate profile", () => {
    const lanes = [
      lane({ name: "dessem_free_v1__gate_early__thr5" }),
      lane({ name: "dessem_free_v1__gate_late__thr5" }),
    ];
    expect(servingLaneFor(lanes, "gate_late")?.name).toBe(
      "dessem_free_v1__gate_late__thr5",
    );
  });

  it("skips a matching lane that cannot serve", () => {
    // The distinction that matters: a refused lane is not an answer, so this
    // returns undefined rather than a lane the caller would then ask for a card.
    const lanes = [lane({ name: "x__gate_late__thr5", usable: false })];
    expect(servingLaneFor(lanes, "gate_late")).toBeUndefined();
  });

  it("does not match a different gate's lane", () => {
    expect(servingLaneFor([lane({ name: "x__gate_early__thr5" })], "gate_late")).toBe(
      undefined,
    );
  });
});

describe("gateIsInert asks a different question, by name alone", () => {
  it("a lane that cannot serve makes its gate inert", () => {
    expect(
      gateIsInert([lane({ name: "x__gate_late__thr5", usable: false })], "gate_late"),
    ).toBe(true);
    expect(
      gateIsInert(
        [lane({ name: "x__gate_late__thr5", condition: "present_unpromoted" })],
        "gate_late",
      ),
    ).toBe(true);
  });

  it("a gate with no lane at all is NOT inert", () => {
    /*
      The reason this is found by name alone rather than by `servingLaneFor`.
      Unknown is not a reason to dim a control: a pill that goes grey because
      the lane table says nothing about its gate is a control claiming
      something nobody published.
    */
    expect(gateIsInert([lane({ name: "x__gate_early__thr5" })], "gate_late")).toBe(false);
    expect(gateIsInert([], "gate_late")).toBe(false);
  });

  it("is the exact negation of `serves` on the lane it finds", () => {
    // `use-run-lanes.ts` spelled this by hand as
    // `condition !== "promoted" || usable === false`. Same boolean, every case.
    for (const condition of ["promoted", "present_unpromoted", "no_artifact"] as const) {
      for (const usable of [true, false, undefined]) {
        const one = lane({ name: "x__gate_late__thr5", condition, usable });
        expect(gateIsInert([one], "gate_late")).toBe(!serves(one));
      }
    }
  });
});

describe("lanesOf reads the table off /v1/meta", () => {
  it("carries the name, the state and the tri-state usable through", () => {
    const meta = {
      model: {
        lanes: [
          { lane: "dessem_free_v1__gate_early__thr5", state: "promoted", usable: true },
          { lane: "dessem_free_v1__gate_late__thr5", state: "present_unpromoted" },
        ],
      },
    } as unknown as Parameters<typeof lanesOf>[0];
    const lanes = lanesOf(meta);
    expect(lanes.map((l) => l.name)).toEqual([
      "dessem_free_v1__gate_early__thr5",
      "dessem_free_v1__gate_late__thr5",
    ]);
    // An absent `usable` stays absent rather than becoming `false`.
    expect(lanes[1]?.usable).toBeUndefined();
    expect(anyServing(lanes)).toBe(true);
  });
});
