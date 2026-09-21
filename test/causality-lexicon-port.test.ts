import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CAUSALITY_BANNED_LEMMAS } from "../packages/core/src/causality";

/**
 * The causality lexicon crosses a language boundary by being copied, and this
 * is what keeps the copy in step.
 *
 * `docs/domain-model.md` §10 gives the rule one lexicon and
 * `docs/specs/diagnosis.md` gives it two enforcers. There are in fact three,
 * and the third is the one nothing was watching:
 *
 * | enforcer | how it gets the list |
 * | --- | --- |
 * | `test/causality-boundary.test.ts` | imports `@wattsteer/core` |
 * | `apps/api/src/diagnosis/narration-validator.ts` | imports `@wattsteer/core` |
 * | `apps/rag/src/wattsteer_rag/gate.py` | **hand-copied** |
 *
 * The third is Python and cannot import the first two. Its own comment says
 * "Ported from packages/core/src/causality.ts so both sides ban the same
 * words", which was true when it was written and was the whole guarantee: a
 * lemma added to the TypeScript list would have been banned in the narration
 * and allowed in a retrieved claim, and the two surfaces would have disagreed
 * about what WattSteer is permitted to say with nothing failing anywhere.
 *
 * Asserted on the source text rather than by running Python, so it costs the
 * default `bun test` nothing and fires in the same run as the rest of the
 * boundary. The two lists are compared **in order**, because the order is the
 * grouping — English, then Portuguese — and a port that kept the members and
 * lost the grouping is a port somebody has stopped maintaining by hand.
 */

const GATE = join(
  import.meta.dir,
  "..",
  "apps",
  "rag",
  "src",
  "wattsteer_rag",
  "gate.py",
);

/** The Python tuple, read as the list of strings it is. */
function portedLemmas(): string[] {
  const source = readFileSync(GATE, "utf8");
  const start = source.indexOf("CAUSALITY_BANNED_LEMMAS = (");
  expect({ found: start >= 0, file: "gate.py" }).toEqual({
    found: true,
    file: "gate.py",
  });
  const body = source.slice(start, source.indexOf("\n)", start));
  return [...body.matchAll(/"([^"]+)"/g)].map((match) => match[1] as string);
}

describe("the Python gate bans the words the TypeScript lexicon bans", () => {
  it("the same lemmas, in the same order", () => {
    expect(portedLemmas()).toEqual([...CAUSALITY_BANNED_LEMMAS]);
  });

  it("the lists were actually read, so agreement means something", () => {
    // Both halves. A lexicon that failed to import and a tuple the regex
    // missed would agree as two empty lists.
    expect(CAUSALITY_BANNED_LEMMAS.length).toBeGreaterThan(10);
    expect(portedLemmas().length).toBe(CAUSALITY_BANNED_LEMMAS.length);
  });

  it("the ported list is the one the gate actually matches against", () => {
    // Non-vacuity of a different kind: a tuple nothing reads would keep passing
    // the comparison above while the gate checked some other list.
    const source = readFileSync(GATE, "utf8");
    expect(source).toContain("def causal_hits(");
    const matcher = source.slice(source.indexOf("def causal_hits("));
    expect(matcher).toContain("CAUSALITY_BANNED_LEMMAS");
  });

  it("the port names its origin, so the next reader knows it is a copy", () => {
    // The comment is load-bearing: without it the tuple looks like a list the
    // RAG owns, and somebody edits it there.
    expect(readFileSync(GATE, "utf8")).toContain("packages/core/src/causality.ts");
  });
});
