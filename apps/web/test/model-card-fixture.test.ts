import { describe, expect, it } from "bun:test";
import { buildModelCard, FIXTURE_LANE } from "../src/lib/fixtures/model-card";

/**
 * The model card fixture — and the two claims it exists to make.
 *
 * A fixture is usually not worth testing. This one is, because it is not
 * arbitrary: its reliability curve encodes a **finding** — the classifier is
 * over-confident in the top bins — and the Explain screen is built to show
 * that without flinching. A fixture quietly edited into a diagonal would make
 * the screen look correct while removing the only thing it was drawn to say.
 *
 * The second claim is a derivation: `reliabilitySampleHours` is the sum of the
 * points' `hourCount`, not a number typed beside them. Restated, it drifts.
 */

describe("the sample count is derived from the curve, not written beside it", () => {
  it("equals the sum of every bin's hours", () => {
    const card = buildModelCard();
    const summed = card.reliability.reduce((acc, p) => acc + p.hourCount, 0);
    expect(card.reliabilitySampleHours).toBe(summed);
  });

  it("is a real sample, not a placeholder", () => {
    // A curve over a hundred hours is a curve nobody should read. The screen
    // prints this number precisely so a reader can judge the curve by it.
    expect(buildModelCard().reliabilitySampleHours).toBeGreaterThan(1000);
  });
});

describe("the curve is over-confident at the top, which is the finding", () => {
  const card = buildModelCard();

  it("the top bins observe *less* than they predicted", () => {
    // The shape the Explain screen exists to show: at high predicted
    // probability the model is optimistic. A fixture flattened to a diagonal
    // would pass every rendering test and delete the finding.
    const top = card.reliability.filter((p) => p.binCentre >= 0.65);
    expect(top.length).toBeGreaterThanOrEqual(3);
    for (const point of top) {
      expect({
        bin: point.binCentre,
        overConfident: point.observedFrequency < point.binCentre,
      }).toEqual({ bin: point.binCentre, overConfident: true });
    }
  });

  it("it is not over-confident everywhere — that would be a bias, not a curve", () => {
    // Some low bins observe *more* than predicted. A curve that sat below the
    // diagonal at every point would describe a model that is simply mis-scaled,
    // which is a different diagnosis and a different fix.
    const under = card.reliability.filter((p) => p.observedFrequency > p.binCentre);
    expect(under.length).toBeGreaterThan(0);
  });

  it("bins ascend and stay inside (0, 1)", () => {
    const centres = card.reliability.map((p) => p.binCentre);
    expect([...centres].sort((a, b) => a - b)).toEqual(centres);
    for (const point of card.reliability) {
      expect({
        c: point.binCentre,
        inRange: point.binCentre > 0 && point.binCentre < 1,
      }).toEqual({
        c: point.binCentre,
        inRange: true,
      });
      expect(point.observedFrequency).toBeGreaterThanOrEqual(0);
      expect(point.observedFrequency).toBeLessThanOrEqual(1);
    }
  });

  it("the sample thins as the probability rises, as a real one does", () => {
    // High-probability hours are rare, so their bins hold fewer of them. A
    // curve with an even sample per bin is a curve nobody measured.
    const first = card.reliability[0];
    const last = card.reliability.at(-1);
    expect(first?.hourCount).toBeGreaterThan((last?.hourCount ?? 0) * 5);
  });
});

describe("a card is keyed by lane and never by a day", () => {
  it("takes the lane and changes nothing else", () => {
    const base = buildModelCard();
    const other = buildModelCard("dessem_free_v1__gate_early__thr5");
    expect(other.lane).toBe("dessem_free_v1__gate_early__thr5");
    // "The same artifact serves all four subsystems, so asking for a curve
    // 'for NE on the 29th' is asking a question the card cannot answer."
    expect({ ...other, lane: base.lane }).toEqual(base);
  });

  it("defaults to the fixture lane rather than to an empty string", () => {
    expect(buildModelCard().lane).toBe(FIXTURE_LANE);
    expect(FIXTURE_LANE).not.toBe("");
  });

  it("returns a copy, so a screen cannot edit the fixture under the next reader", () => {
    const a = buildModelCard();
    const b = buildModelCard();
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});

describe("the window is labelled with the fidelity it was scored at", () => {
  it("is revision_optimistic, because the window predates ingestion go-live", () => {
    // The honesty obligation: a curve scored against ONS's *current*
    // restatement of the past is not a point-in-time measurement, and the card
    // says so rather than letting the screen imply otherwise.
    const card = buildModelCard();
    expect(card.reliabilityFidelity).toBe("revision_optimistic");
    expect(card.reliabilityWindowFrom < card.reliabilityWindowTo).toBe(true);
  });
});
