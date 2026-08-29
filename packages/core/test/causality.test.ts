import { describe, expect, test } from "bun:test";
import {
  CAUSALITY_BANNED_LEMMAS,
  crossesCausalityBoundary,
  findCausalityHits,
} from "../src/causality";

/**
 * The matcher behind both enforcers of `docs/domain-model.md` §10.
 *
 * The build-time scan (`test/causality-boundary.test.ts`) proves that the rule
 * is enforced over the repository. These tests prove the thing that scan
 * depends on: that the matcher finds the claim and leaves the domain's own
 * vocabulary alone, in both locales — because the narration output validator
 * will call the same function on prose no reviewer ever sees.
 */

describe("the banned lemma set", () => {
  test("is the spec's list, deduplicated, and stays that way", () => {
    // The set is asserted whole. Anything added here should be added to
    // `docs/specs/diagnosis.md` in the same commit, and anything removed is a
    // deliberate narrowing of the boundary rather than a tidy-up.
    expect([...CAUSALITY_BANNED_LEMMAS]).toEqual([
      "causal",
      "causality",
      "causal ai",
      "root cause",
      "caused by",
      "causes the",
      "because the grid",
      "why it happened",
      "driver of the event",
      "causa",
      "causou",
      "causado por",
      "causa raiz",
      "porque ocorreu",
    ]);
    expect(new Set(CAUSALITY_BANNED_LEMMAS).size).toBe(CAUSALITY_BANNED_LEMMAS.length);
  });

  test("every lemma is found, in either casing", () => {
    for (const lemma of CAUSALITY_BANNED_LEMMAS) {
      expect(crossesCausalityBoundary(`… ${lemma} …`)).toBe(true);
      expect(crossesCausalityBoundary(`… ${lemma.toUpperCase()} …`)).toBe(true);
    }
  });
});

describe("what the matcher must not catch", () => {
  test("ordinary prose that merely contains the letters", () => {
    // `because` contains `caus`. This codebase's comments say it constantly,
    // and a substring scan would report every one of them.
    expect(
      crossesCausalityBoundary("The band is wide because the model is unsure."),
    ).toBe(false);
    expect(crossesCausalityBoundary("Porque a rede publica com atraso.")).toBe(false);
    expect(crossesCausalityBoundary("A raiz do problema é o congestionamento.")).toBe(
      false,
    );
  });

  test("the domain's own proper nouns", () => {
    // `RestrictionCause` is `docs/domain-model.md` §4's value object and the
    // name of columns this product writes on every ingest. ONS's reported
    // reason is evidence the product displays, not a claim the product makes.
    for (const name of [
      "RestrictionCause",
      "restriction_cause",
      "restrictionCauseMixed",
      "cod_razaorestricao",
    ]) {
      expect(findCausalityHits(name)).toEqual([]);
    }
  });

  test("but the claim itself is caught in the same sentences", () => {
    // The mirror of the two tests above: the words that were let through are
    // let through because of what follows them, not because the check is weak.
    expect(crossesCausalityBoundary("It was curtailed because the grid was full.")).toBe(
      true,
    );
    expect(crossesCausalityBoundary("A causa raiz foi o congestionamento.")).toBe(true);
  });
});

describe("what the matcher reports", () => {
  test("the lemma, the text as written, and where it was", () => {
    const hits = findCausalityHits("Uma afirmação Causal sobre a rede.");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.lemma).toBe("causal");
    expect(hits[0]?.text).toBe("Causal");
    expect(hits[0]?.index).toBe(14);
  });

  test("a phrase split across a wrapped comment line", () => {
    // Copy and doc comments wrap. A claim that survives by being reflowed is
    // the cheapest possible way past this check.
    expect(crossesCausalityBoundary("It happened\n * because the grid was full.")).toBe(
      true,
    );
  });

  test("both readings of an overlapping phrase", () => {
    // `causa raiz` is reported twice, as `causa` and as `causa raiz`, so an
    // allowlist entry written for one reading cannot silently permit the other.
    expect(findCausalityHits("A causa raiz.").map((h) => h.lemma)).toEqual([
      "causa",
      "causa raiz",
    ]);
  });

  test("nothing at all in text that stays inside the boundary", () => {
    // The sentence the product is allowed to say, in both locales.
    expect(
      findCausalityHits("The model raised its forecast for tomorrow afternoon."),
    ).toEqual([]);
    expect(findCausalityHits("O modelo elevou a previsão para amanhã à tarde.")).toEqual(
      [],
    );
  });
});
