# 02 — Eight named drivers, and a map that fails the build when a feature appears

**What to build:** the vocabulary the Explain screen ranks. Every feature the
forecaster reads belongs to exactly one of **eight driver groups**, the map is
data rather than code, and adding a feature upstream fails a test until somebody
decides where it belongs.

The eight groups, their codes and their mechanism:

| # | `code` | Mechanism |
|---|---|---|
| 1 | `renewable_resource` | How much wind and sun there is to spill |
| 2 | `demand_level` | How much load there is to absorb it |
| 3 | `net_surplus` | The balance itself — renewable/load ratio, low residual load |
| 4 | `export_stress` | Whether the surplus can leave |
| 5 | `ramp_shape` | Intraday shape and steepness |
| 6 | `calendar_season` | Weekend, holiday, season, sun angle |
| 7 | `recent_history` | What has been happening lately |
| 8 | `data_conditions` | The state of the pipeline, and the residual |

Four rules make this a decision rather than a taxonomy, and each is a test:

- **Total and disjoint.** Every name in the ordered feature list belongs to
  exactly one group. `data_conditions` is the declared catch-all so totality is
  achievable, but a feature reaching it *implicitly* is a failure, not a
  fallback — the fix is a line in the map.
- **Two features are expected to contribute numerically zero** — the subsystem
  and the local hour — because the attribution background is matched on both.
  They stay in the map for totality; a non-zero contribution is a bug elsewhere
  and a later ticket asserts it.
- **`data_conditions` is a player, not a leftover.** It carries a real
  contribution and a real sign, unlike the prototype's `other`, which is a
  rounding remainder.
- **The map is frozen against retrains.** It changes only by editing the data
  file, which bumps a version and a hash. The retrain never touches it.

Each group also **declares a headline feature**, the one whose observed value
and typical value the screen may show beside the bar. A group has no single
value, so naming the feature the pair comes from is what stops a value pair
being read as the whole group's reading.

The version and the hash (over the sorted feature→group pairs) are stamped onto
the model card, so a change to the grouping is a product-visible event and not a
silent re-ranking.

**Blocked by:** None — can start immediately. The ordered feature list and the
feature names are fixed by the feature-engineering spec, which is the naming
authority here; this ticket groups names and never invents one.

**Status:** done

- [ ] The map is a data file, loaded at train time, not a code table
- [ ] Every feature name in the ordered feature list matches exactly one explicit rule
- [ ] No feature name matches two rules
- [ ] A feature that reaches the catch-all without being explicitly placed there fails the test
- [ ] Adding a name to the feature list and running the test fails until the name is grouped
- [ ] Each group declares a headline feature and a unit code for it
- [x] The hash moves when the **feature-to-group pairing** moves — a feature
      changing group, arriving or leaving — and not for reformatting, reordering
      or comment edits, because a narration cache must not be invalidated by
      whitespace. Note this is narrower than "when and only when the map file
      changes", which this box originally said: editing a `headline_feature`,
      `unit` or `label_code` changes the file and not the hash. That is correct —
      the hash exists to key a cache on what the attribution actually depends on —
      and those edits are caught by `version` instead
- [ ] The version and the hash are recorded on the model card
- [ ] The five drivers the product brief names by hand each land in a group, and it is recorded which
