# 31 — Nothing on the card says which partition produced the attribution

**What to build:** the three card fields `docs/specs/diagnosis.md` asks the
forecaster for in "Two additions to the forecaster's artifact" —
`driver_group_version`, `driver_group_hash` and `headline_feature_check`. The
spec is the authority for what each one means and this ticket does not restate
it. Forecaster 30 built the first addition; this is the second, and it is the
last thing the api-surface README lists as owed and unsliced.

## The evidence, in the order it is hard to refuse

1. **The hash exists, is correct, and is stamped on nothing.**
   `DriverGroupMap.card_fields()` has been in the tree since diagnosis 02, it
   returns exactly `driver_group_version` and `driver_group_hash`, and
   `test_driver_groups.py` pins both. Grep the repo for a caller:

   ```
   src/wattsteer_ml/diagnosis/driver_groups.py:271  "driver_group_version": ...
   src/wattsteer_ml/diagnosis/driver_groups.py:272  "driver_group_hash": ...
   ```

   Those two lines are the only occurrences outside the tests. Its own docstring
   says the fields "are stamped on the model card by the forecaster's card
   assembly, which reads them from `DriverGroupMap.card_fields`" — and
   `ModelCard.to_dict()` has twelve groups and none of them is that call. The
   docstring describes a caller that was never written.

2. **The attribution stamps the live map; the artifact stamps nothing.**
   `attribution.py:425` and `day_attribution.py:572` take
   `driver_group_version` / `driver_group_hash` off whichever `DriverGroupMap`
   the publication was handed, and `publication.py:555` writes both onto every
   `diagnosis_attribution` row. So a stored attribution says which partition
   *published* it and the artifact it was computed from says nothing. Two
   attributions of the same lane-day under two partitions are two different
   numbers wearing one artifact id, and the artifact cannot be asked which one
   it agrees with.

3. **The map is frozen against retrains — and only by convention.** The spec:
   "The grouping is a product decision and is frozen against retrains. The map
   changes only by editing the YAML, which bumps `driver_group_version`, which
   invalidates every cached narration. The retrain never touches it." Every half
   of that is enforced except the half that would let anything *notice*: no
   artifact records the partition it was trained beside, so a YAML edit is
   invisible to every artifact that predates it.

4. **The headline check has never existed, and the spec says what it is for.**
   Each group declares one feature whose `observed`/`typical` pair the Explain
   screen may show beside the bar. The spec asks the card to record whether that
   declaration is still true on the newest fold, and is explicit that a mismatch
   is "a **card warning, never an automatic relabel** — a driver whose subtitle
   changes weekly is worse than one that is second-best". Today the declaration
   is checked for exactly one property, in `DriverGroupMap.__post_init__`: that
   the headline is a member of its own group. Whether it is the member doing the
   work is unmeasured.

## Why it matters

An attribution is a comparison and forecaster 30 froze one side of it into the
artifact. This is the other half of the same argument: the comparison also has a
*partition*, the eight players are the partition, and an explanation is
reproducible from the artifact alone only if the artifact says which one it was
played over. `background_seed` and `background_rows_per_cell` are on the card
for exactly this reason; the partition is the remaining un-stamped input to
`φ`.

## The decisions to make, rather than assume

**Where the hash comes from.** From the map's content, always. This repo has
been bitten repeatedly by a count or a list restated beside the thing it
describes — `.scratch/api-surface/issues/27-every-claim-in-the-specs-is-checked.md`
found eleven false claims in the specs and, worse, a *test* that had pinned a
wrong number into one. `DriverGroupMap.digest` already hashes the sorted
`feature → group` pairs and is blind to YAML formatting; nothing else may be
allowed to produce this value, and nothing may re-derive it.

**What `|φ|` can mean at member grain, given seam 3.** The spec asks for "the
largest mean-`|φ|` member", and seam 3 forbids any production code path in the
diagnosis module from producing a member-level `φ` — enforced by a fragment scan
and an AST walk over `diagnosis/*.py` in `test_grouped_shapley.py`. These two
are not in conflict, but they are close enough that the resolution has to be
written down rather than discovered: say which game is solved at member grain,
say why it is exactly solvable, and put the code somewhere the seam-3 guard is
not silently narrowed by its arrival.

**Whether the check may relabel.** It may not. The spec settles this and the
implementation should make it unrepresentable rather than merely avoid it.

**Whether any of this reaches the wire.** Decide and record it. The attribution
payload already carries `driver_group_version` and `driver_group_hash`
(`packages/core/schema/diagnosis.schema.json:161`), and forecaster 30's
`background_*` fields went on the card and not on `/v1/model/card`, which is by
its own description "the **product-facing subset**". A field that is already on
the wire where it is read does not need a second home.

**Blocked by:** None. Forecaster 30 is merged; `DriverGroupMap`,
`MatchedBackground` and `expected_mwh_for_block` are all in the tree.

**Status:** done

- [x] The card carries `driver_group_version` and `driver_group_hash`, produced
      by `DriverGroupMap.card_fields()` and by nothing else
- [x] The hash is derived from the map's content, and a test proves it is not
      vacuous: it moves when a member moves group, it does not move when the
      YAML is reformatted, and a map parsed from an empty or group-less document
      does not load at all
- [x] The card carries a `headline_feature_check` block with one entry per
      group, a verdict from a closed set, and the two numbers the verdict was
      taken from
- [x] The check actually evaluates the model: a test makes it return `mismatch`
      by declaring a headline that is not the largest mover, and `confirmed` for
      the same fixture with the declaration corrected
- [x] The check reports how many targets and how many members it evaluated, and
      a test asserts both are above zero on a real trained fold — an empty
      evaluation must not pass as a `confirmed`
- [x] A mismatch is recorded and changes nothing else: no relabel, no reordering
      of the map, no effect on any `φ`, share or rank
- [x] The three fields sit in a card group of their own and a test asserts no
      other group shares one of their keys — `merge_disjointly` raises on a
      collision and the card is assembled by `**` merges
- [x] A card whose partition disagrees with the map the running code holds is
      detectable, named on both sides, and stops an attribution publication
      rather than producing rows stamped with a partition the artifact never saw
- [x] The wire decision is recorded with its evidence

## What landed

- **`driver_groups.py` moved to `wattsteer_ml/driver_groups.py`**, top level,
  and it had to. `training/` cannot import any submodule of
  `wattsteer_ml.diagnosis`: importing one runs `diagnosis/__init__`, which
  reaches `composed_target`, which imports `wattsteer_ml.training` back. Probed,
  not assumed — a one-line import added to `training/hurdle.py` gives
  `ImportError: cannot import name 'expected_mwh_for_block' from partially
  initialized module 'wattsteer_ml.training'`. The map is now read by the
  artifact's card assembly *and* by the attribution, so it belongs to neither
  package, which is the same reasoning `wattsteer_ml/model_inputs.py` already
  gives for its own position. **The YAML did not move**: `docs/specs/diagnosis.md`
  names its path and that claim stays true. `wattsteer_ml.diagnosis` re-exports
  every name it re-exported before, so nothing outside the import lines moved.
- **`training/headline_check.py`** holds the check. In `training/` and not in
  `diagnosis/` for the seam-3 reason above: the module names a per-member
  quantity, `test_grouped_shapley.py`'s scan forbids that vocabulary anywhere in
  `diagnosis/*.py`, and satisfying the scan by choosing coy names would have
  been the wrong way round. Two guards keep the move from being a loophole —
  `diagnosis` may not import the module (an import-graph test), and the check's
  numbers reach the card and nothing else.
- **The member game is the one-player game, which is exactly solvable.** For
  member `m`: `φ_m = v({m}) − v(∅)`, both means over the target's own matched
  background cell, every other column held at the target. That is the Shapley
  value of the game whose single player is `m` — the `n = 1` case of
  `exact_shapley`, whose weight is 1 — so it is a definition and not an
  approximation of one. It is not, and is not called, the member's value in the
  group's game: `Σ_m φ_m ≠ Φ_group` in general and nothing sums them. Cost is
  `(k + 1) × |B(s,h)|` rows per target in one batched call.
- **Five verdicts, all reachable**: `confirmed`, `mismatch`, `no_movement`
  (every member's mean `|φ|` is exactly zero — the honest answer where "largest"
  has no referent), `headline_not_in_contract` and `no_member_in_contract`. The
  last two are what the fixture contract produces for most groups, and they are
  verdicts rather than a skipped group so that a card cannot report `confirmed`
  for a group it never evaluated.
- **The card gained a `drivers` group** carrying the two identity fields from
  `DriverGroupMap.card_fields()` and the `headline_feature_check` block. A group
  of its own, keys prefixed, and a test asserts no other card group shares one.
- **`ModelCard.headline_check` is required and undefaulted**, the way forecaster
  30 made `HurdleBundle.background` required: a card assembled without the check
  is not a card with one field missing, it is a card that cannot say which
  partition produced the artifact.
- **`card_partition_fault(card, group_map)`** is the detector, and
  `build_diagnosis_publication` refuses on it with a fifth refusal condition,
  `partition_disagrees_with_card`. It compares against the *live* map and not
  against the `group_map` argument, deliberately: the argument exists so a
  fixture contract can be attributed at all, and the fault being asked about is
  between the artifact and the code that is running.
- **Nothing moved on the wire.** `driver_group_version` and
  `driver_group_hash` are already on the diagnosis payload, where the Explain
  screen reads them; `model-card.schema.json` is the product-facing subset and
  `card_url` points at the whole document, which is the same line forecaster 30
  drew for `background_*`. So no schema, no generated type, no gateway reader
  and no conformance fixture changed, and the reason is recorded here rather
  than left as an omission.
