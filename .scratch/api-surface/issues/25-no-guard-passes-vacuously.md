# 25 — Every guard proves it can fail, and that its inputs are not empty

**What to build:** a sweep establishing that no standing guard in this repository
reads green while governing nothing.

This is not speculative. It is the single most repeated defect found while
building this system, in **four** distinct forms, every one of which passed its
own test suite:

1. **Enumeration instead of discovery.** Three parity READMEs claimed both suites
   "fail when the directory contains a case they did not enumerate". Neither did —
   both listed only the subdirectory names they already knew, so a third would
   have been read by nobody.
2. **A control at an unreachable address.** api-surface 22's ONS-fetch negative
   control — the one thing standing between its guard and accusing the whole
   ingest layer — lived at a module id nothing imported. The walk never reached
   it, so it satisfied "not detected" no matter how wide the detector got, and a
   deliberate widening **passed**.
3. **A stripper eating the code it was meant to scan.** `api/grid.ts:280` is a
   `//` comment containing `/*`. Any scanner that removes block comments *before*
   line comments opens a block there and deletes a hundred lines of real route
   code from its own input. `ml-boundary.test.ts` had it: a violation placed after
   that line was **not** caught and the identical one before it **was**.
4. **A vacuous metric.** `coverage_p10 = 1.0` over **zero** rows that state a
   lower bound — 79 evaluations of `y ≥ 0`, published for months as evidence the
   floor was perfect.

Each was found by accident, by someone working on something else. That is not a
process.

**What to do.** Inventory the standing guards and the asserted metrics, and for
each establish two properties: **it can fail** (mutate the thing it governs and
watch it go red), and **its inputs are non-empty** (the file list it walks, the
control set it pins, the row set it divides by). Prefer making the second
property *self-checking* — api-surface 22's "every control is reachable, so none
passes vacuously" and forecaster 24's refusal of a coverage figure whose
denominator disagrees with it are the two patterns to copy.

Where a guard already holds both properties, say so and leave it. **A truthful
short list of guards that needed nothing is a better outcome than a wide diff.**

**Blocked by:** None.

**Status:** done

- [ ] The standing guards and asserted metrics are inventoried, with how each was
      found (do not rely on a hand-written list; discover them)
- [ ] Every one has a demonstrated failure mode, or is reported as already having
      one, naming the test
- [ ] Every one that walks, enumerates or divides asserts its input is non-empty
- [ ] Any guard found vacuous is fixed **narrowly** — this repo has twice caught
      an over-broad guard accusing a chart of implementing business logic, and a
      guard that cries wolf is one somebody deletes
- [ ] Any comment-stripping scanner strips line comments before block comments;
      an alternation is safe because it is positional
