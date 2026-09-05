# 07 — The Explain screen stops describing a model that does not exist

**What to build:** the Explain screen renders one attribution per
**subsystem-day**, ranked by share of attributed movement, with a merged
`other` row that is allowed to say it has no single direction. It stops asking
for an explanation per technology, because there is no per-technology head to
explain.

This is the numbered contract-change table, as it lands in code. Four of the
seven changes are here.

**Change 1 — direction gains a third member.**

```ts
export type DriverDirection = "raises" | "lowers" | "mixed";
```

`"mixed"` reaches the UI in **exactly one place**: the merged `other` row, when
the members' absolute contributions exceed 1.5× the absolute value of their sum.
The eight real groups always have a sign, because a grouped Shapley value is one
number. A test asserts no response carries `mixed` on a row whose code is one of
the eight.

**Change 2 — the driver readings.** The spec describes the fixtures as carrying
preformatted strings and asks for numbers plus a unit code. **The prototype is
already ahead of the spec here**: a reading is a structured quantity (value,
decimals, optional unit, optional signed flag) or a term or nothing. What is
actually required is narrower and sharper: the reading must carry the **name of
the headline feature it came from**, so that a value pair is never presented as
if the whole group had one reading, and the **`term` variant must survive** —
`calendar_season` has a categorical headline reading and the spec's
numbers-plus-unit model has nowhere to put "the day was a weekend". Resolve this
explicitly rather than silently dropping the variant.

**Change 3 — the share means something different, and the footnote is wrong.**
The share is `|φ_j| / Σ_k |φ_k|` over the **displayed** rows: a share of the
total attributed **movement**. Not a share of the curtailment, and not a share
of "the attributed magnitude", which is what both the type's doc comment and the
footnote under the bars say today. **This is user-facing copy**, in both
locales, Portuguese first, and it goes through the dictionaries under the
hardcoded-string guard.

**Change 4 — the technology dimension is a deletion, not an edit.** The
explanation builder loses its technology argument, the explain shape loses its
technology field, and the screen stops passing technology through to the
diagnosis. The technology URL parameter **survives for the observed panels**,
where a technology dimension genuinely exists.

**The driver shape gains four fields and its code set changes.** A driver now
carries the signed contribution itself, the headline feature name, the hour
disagreement and a demoted flag. And the closed set of driver codes is currently
**twelve prototype names that are not the eight groups** — replacing it is a
contract change nobody flagged, and it is a compile-error-shaped change by
design, because each code's words live in the dictionaries and a union makes "a
driver with no label in both locales" a build failure.

**The display rule lives in the client, and that is deliberate.** All eight
groups are returned, ranked; the client applies the `share ≥ 0.03` cut, the
six-row cap and the merge into `other`. Putting it server-side would mean the
`other` row's mixed-direction computation lives in two places the first time a
second client appears.

**One sentence the screen must gain.** The bars explain the **expected MWh**.
They do not explain the P10, the P90, the band's width, or the day-level
occurrence probability, which comes from the path ensemble and is not a per-hour
model output at all. The risk chip and the driver bars are adjacent panels
describing related but distinct quantities, and the screen must say so once.
Also copy, also both locales.

**Blocked by:** 03. Cross-spec: the eight group codes and their label keys come
from **diagnosis 02**; the mixed-direction merge rule and the share definition
come from **diagnosis 04**. The screen can be reshaped against fixtures before
either lands, but the code set is not final until diagnosis 02 does.

**Status:** done — branch `api-07-explain-screen-contract`

Built to the spec's **corrected** text, not the table as first written:
`labelCode` stays withdrawn (there is no `Driver.label` to rename), and
`observed`/`typical` stay the structured `DriverReading` sum type rather than
being flattened to a number plus a unit — the `term` variant is what
`calendar_season` needs. `DriverDirection` has three members and
`SignedDriverDirection` has two, so `"mixed"` on one of the eight is a compile
error as well as a test failure. The share is normalised over all eight groups;
`selectNotableDrivers` stays shared with the server and the merge lives in
`apps/web/src/lib/driver-rows.ts`, which is the only place `"mixed"` is
produced.

- [ ] Direction has three members and only the merged row can carry the third
- [ ] A test asserts no response carries a mixed direction on one of the eight group codes
- [ ] A driver carries its signed contribution, its headline feature, its hour disagreement and its demoted flag
- [ ] The driver code set is the eight groups, with a label key for each in both locales
- [ ] The categorical reading variant is either preserved with a stated rule or removed with a stated replacement — not dropped silently
- [ ] The share doc comment and the footnote under the bars both say "attributed movement"
- [ ] The explanation builder and the explain shape carry no technology; the observed panels still do
- [ ] The screen states once that the bars explain the expectation and not the band
- [ ] All new copy is in both locales, Portuguese default, and passes the hardcoded-string guard
