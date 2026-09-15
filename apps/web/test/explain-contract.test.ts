/**
 * The Explain screen's contract, asserted where the screen reads it.
 *
 * `docs/specs/api-surface.md`'s contract table and `docs/specs/diagnosis.md`'s
 * display rule between them make four claims that a type cannot state on its
 * own, and this file states each of them once:
 *
 *  1. `"mixed"` reaches the UI in **exactly one place** — the merged `other`
 *     row. No response carries it on a row whose code is one of the eight.
 *  2. The share is `|φ_j| / Σ_k |φ_k|` over **all eight** groups, so the
 *     shares sum to 1 before any display cut is applied.
 *  3. The selection predicate is the shared one; the merge is the client's.
 *  4. The categorical reading variant survives, because `calendar_season` has
 *     a categorical headline reading and there is nowhere else to put it.
 *
 * The screen is on fixtures and reads no HTTP — nothing in `apps/web` does —
 * so "every response the screen can be handed" is every `buildExplain` result,
 * which is what these tests enumerate.
 */

import { describe, expect, it } from "bun:test";
import { NOTABLE_DRIVER_LIMIT, NOTABLE_SHARE_MIN } from "@wattsteer/core/driver-display";
import { en as EN } from "../src/i18n/copy.en";
import { pt as PT } from "../src/i18n/copy.pt";
import { driverLabel } from "../src/i18n/drivers";
import {
  driverRows,
  MIXED_DIRECTION_RATIO,
  mergedDirection,
} from "../src/lib/driver-rows";
import type { DriverCode } from "../src/lib/fixtures";
import { buildExplain, SUBSYSTEM_DISPLAY_ORDER } from "../src/lib/fixtures";

/**
 * The eight, written out rather than derived.
 *
 * A test that read the codes off the fixture would pass whatever the fixture
 * happened to contain, including the twelve prototype feature names this
 * replaced. The list is the assertion.
 */
const GROUPS: readonly DriverCode[] = [
  "renewable_resource",
  "demand_level",
  "net_surplus",
  "export_stress",
  "ramp_shape",
  "calendar_season",
  "recent_history",
  "data_conditions",
];

const EVERY_RESPONSE = SUBSYSTEM_DISPLAY_ORDER.map((subsystem) =>
  buildExplain(subsystem),
);

describe("the eight groups are the driver code set", () => {
  it("every response returns all eight, ranked, and nothing else", () => {
    for (const explain of EVERY_RESPONSE) {
      const codes = explain.drivers.map((driver) => driver.code);
      expect([...codes].sort()).toEqual([...GROUPS].sort());
      const shares = explain.drivers.map((driver) => driver.share);
      expect(shares).toEqual([...shares].sort((a, b) => b - a));
    }
  });

  it("each group has a label in both locales, and `other` is not a group", () => {
    for (const code of GROUPS) {
      expect(PT.app.drivers.groups[code]).toBeTruthy();
      expect(EN.app.drivers.groups[code]).toBeTruthy();
    }
    expect(Object.keys(PT.app.drivers.groups)).toHaveLength(GROUPS.length);
    expect(Object.keys(EN.app.drivers.groups)).toHaveLength(GROUPS.length);
    expect(Object.keys(PT.app.drivers.groups)).not.toContain("other");
    // The merged row is named apart from the eight, in both locales.
    expect(driverLabel("other", PT)).toBe(PT.app.drivers.merged);
    expect(driverLabel("other", EN)).toBe(EN.app.drivers.merged);
  });

  it("a driver carries φ, its headline feature, its disagreement and its flag", () => {
    for (const explain of EVERY_RESPONSE) {
      for (const driver of explain.drivers) {
        expect(Number.isFinite(driver.phiMwh)).toBe(true);
        expect(driver.headlineFeature.length).toBeGreaterThan(0);
        expect(driver.hourDisagreement).toBeGreaterThanOrEqual(0);
        expect(typeof driver.demoted).toBe("boolean");
        // The sign of the bar is the sign of the contribution. A row that
        // disagreed with its own φ would be a chart contradicting its number.
        expect(driver.direction).toBe(driver.phiMwh >= 0 ? "raises" : "lowers");
      }
    }
  });

  it("there is no technology dimension on the attribution", () => {
    for (const explain of EVERY_RESPONSE) {
      expect(explain).not.toHaveProperty("technology");
    }
    // `buildExplain` takes one argument. A second one would be building an
    // explanation per technology of a model with one head per subsystem.
    expect(buildExplain.length).toBe(1);
  });
});

describe("the share is a share of the attributed movement", () => {
  it("shares are normalised over all eight groups and sum to 1", () => {
    for (const explain of EVERY_RESPONSE) {
      const total = explain.drivers.reduce((sum, driver) => sum + driver.share, 0);
      expect(total).toBeCloseTo(1, 6);
    }
  });

  it("each share is |φ_j| / Σ_k |φ_k| over all eight, not over the displayed", () => {
    for (const explain of EVERY_RESPONSE) {
      const gross = explain.drivers.reduce(
        (sum, driver) => sum + Math.abs(driver.phiMwh),
        0,
      );
      for (const driver of explain.drivers) {
        expect(driver.share).toBeCloseTo(Math.abs(driver.phiMwh) / gross, 2);
      }
      // The denominator is fixed before the cut: the displayed rows carry less
      // than the whole, which is the property a share over the *displayed*
      // rows would destroy by construction.
      const displayed = driverRows(explain.drivers).filter((row) => row.code !== "other");
      const displayedShare = displayed.reduce((sum, row) => sum + row.share, 0);
      expect(displayedShare).toBeLessThan(1);
    }
  });

  it("the footnote under the bars says movement, in both locales", () => {
    expect(EN.app.drivers.note).toContain("attributed movement");
    expect(EN.app.drivers.note).not.toContain("attributed magnitude");
    expect(PT.app.drivers.note).toContain("movimento atribuído");
    expect(PT.app.drivers.note).not.toContain("magnitude atribuída");
  });
});

describe("the display rule: a shared predicate and a client-only merge", () => {
  it("the selection is the shared predicate, applied unchanged", () => {
    for (const explain of EVERY_RESPONSE) {
      const rows = driverRows(explain.drivers);
      const named = rows.filter((row) => row.code !== "other");
      expect(named.length).toBeLessThanOrEqual(NOTABLE_DRIVER_LIMIT);
      for (const row of named) {
        expect(row.share).toBeGreaterThanOrEqual(NOTABLE_SHARE_MIN);
      }
    }
  });

  it("the merged row's φ is the signed sum of what it absorbed", () => {
    for (const explain of EVERY_RESPONSE) {
      const rows = driverRows(explain.drivers);
      const other = rows.find((row) => row.code === "other");
      if (other === undefined) {
        continue;
      }
      const named = new Set(rows.filter((r) => r.code !== "other").map((r) => r.code));
      const members = explain.drivers.filter((driver) => !named.has(driver.code));
      expect(other.memberCount).toBe(members.length);
      expect(other.phiMwh).toBeCloseTo(
        members.reduce((sum, driver) => sum + driver.phiMwh, 0),
        6,
      );
      expect(other.share).toBeCloseTo(
        members.reduce((sum, driver) => sum + driver.share, 0),
        6,
      );
      // A merged row stands for several groups, so it has no headline feature
      // and no single hour disagreement. `null`, not `""` and not `0`.
      expect(other.headlineFeature).toBeNull();
      expect(other.hourDisagreement).toBeNull();
      expect(other.observed.kind).toBe("none");
      // A merged row stands for several groups, so no rule demoted it: there
      // is no group here for a rule to have made a statement about.
      expect(other.demoted).toBe(false);
    }
  });

  it("a demoted group goes below the fold with its φ, sign and share intact", () => {
    const explain = buildExplain("NE");
    const source = explain.drivers.find((driver) => driver.demoted);
    if (source === undefined) {
      throw new Error("the NE fixture no longer exercises a demote rule");
    }
    const rows = driverRows(explain.drivers);
    const named = rows.filter((row) => row.code !== "other");
    const demoted = named.filter((row) => row.demoted);
    expect(demoted).toHaveLength(1);
    // Below every group that was not demoted, whatever their shares say.
    expect(named.at(-1)?.code).toBe(demoted[0].code);
    expect(demoted[0].share).toBeGreaterThan(named.at(-2).share);
    // And nothing else about the row moved. A rule may annotate, demote or
    // withhold; it may never change a φ, a sign or a share.
    expect(demoted[0].phiMwh).toBe(source.phiMwh);
    expect(demoted[0].share).toBe(source.share);
    expect(demoted[0].direction).toBe(source.direction);
    // The sentence under it exists in both locales.
    expect(PT.app.drivers.demoted).toBeTruthy();
    expect(EN.app.drivers.demoted).toBeTruthy();
  });
});

describe("mixed reaches the UI in exactly one place", () => {
  it("no response carries a mixed direction on one of the eight", () => {
    for (const explain of EVERY_RESPONSE) {
      for (const driver of explain.drivers) {
        expect(GROUPS).toContain(driver.code);
        // The claim the spec asks to be asserted. It is also unrepresentable:
        // `Driver.direction` is `SignedDriverDirection`, so the line below
        // could not be made to fail without a cast. Both halves are cheap and
        // the runtime one survives the day a decoder starts filling this in.
        expect(driver.direction as string).not.toBe("mixed");
      }
    }
  });

  it("no rendered row that is one of the eight is mixed either", () => {
    for (const explain of EVERY_RESPONSE) {
      for (const row of driverRows(explain.drivers)) {
        if (row.code !== "other") {
          expect(row.direction).not.toBe("mixed");
        }
      }
    }
  });

  it("the merged row is mixed exactly when its members cancel", () => {
    // The rule itself: `Σ|φ| > 1.5 · |Σφ|`.
    expect(mergedDirection(-8, 24)).toBe("mixed");
    expect(mergedDirection(-8, 8 * MIXED_DIRECTION_RATIO)).toBe("lowers");
    expect(mergedDirection(19, 19)).toBe("raises");
    expect(mergedDirection(-19, 19)).toBe("lowers");

    // And the two fixtures that exercise both sides of it: NE's remainder
    // cancels and refuses a direction; a quieter subsystem's remainder agrees
    // with itself and keeps its sign.
    const ne = driverRows(buildExplain("NE").drivers).find((r) => r.code === "other");
    expect(ne?.direction).toBe("mixed");
    const quiet = driverRows(buildExplain("S").drivers).find((r) => r.code === "other");
    expect(quiet?.direction).toBe("lowers");
  });

  it("mixed has words in both locales, and its own accessible sentence", () => {
    expect(PT.app.drivers.direction.mixed).toBeTruthy();
    expect(EN.app.drivers.direction.mixed).toBeTruthy();
    // Not slotted into "{direction} risk": a cancelled remainder neither
    // raised nor lowered anything, so the sentence changes rather than the
    // placeholder.
    expect(EN.app.drivers.figureMixed).not.toContain("{direction}");
    expect(PT.app.drivers.figureMixed).not.toContain("{direction}");
  });
});

describe("the categorical reading variant survives", () => {
  it("calendar_season reads as a term, not as a number", () => {
    for (const explain of EVERY_RESPONSE) {
      const calendar = explain.drivers.find((d) => d.code === "calendar_season");
      expect(calendar?.headlineFeature).toBe("calendar_is_weekend");
      expect(calendar?.observed.kind).toBe("term");
      expect(calendar?.typical.kind).toBe("term");
    }
  });

  it("every term a reading can carry has words in both locales", () => {
    for (const explain of EVERY_RESPONSE) {
      for (const driver of explain.drivers) {
        for (const reading of [driver.observed, driver.typical]) {
          if (reading.kind === "term") {
            expect(PT.app.drivers.terms[reading.term]).toBeTruthy();
            expect(EN.app.drivers.terms[reading.term]).toBeTruthy();
          }
        }
      }
    }
  });

  it("a reading pair is never shown without the feature it came from", () => {
    for (const explain of EVERY_RESPONSE) {
      for (const driver of explain.drivers) {
        if (driver.observed.kind !== "none") {
          expect(driver.headlineFeature.length).toBeGreaterThan(0);
        }
      }
    }
    // And the string that prints it names the feature, in both locales.
    expect(PT.app.drivers.reading).toContain("{feature}");
    expect(EN.app.drivers.reading).toContain("{feature}");
  });
});

describe("the screen says once what the bars explain", () => {
  it("the scope sentence is in both locales and names the expectation", () => {
    expect(EN.app.drivers.scopeNote).toContain("expected MWh");
    expect(EN.app.drivers.scopeNote).toContain("P10");
    expect(EN.app.drivers.scopeNote).toContain("P90");
    expect(PT.app.drivers.scopeNote).toContain("MWh esperados");
    expect(PT.app.drivers.scopeNote).toContain("P10");
    expect(PT.app.drivers.scopeNote).toContain("P90");
  });
});
