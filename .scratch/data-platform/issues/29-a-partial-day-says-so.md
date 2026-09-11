# 29 — A partial reference day, admitted and stated, and the half hour ONS did not finish writing

**What to build:** the column and the read change data-platform 25 said admitting
a partial DESSEM day would need, so that 29 of the 34 short reference days this
platform was throwing away are stored — with their incompleteness on the row,
and out of the way of every reader that did not ask for them.

**Blocked by:** None. 25 measured the 34 and left this as the one thing it
deliberately did not do.

**Status:** done — `drizzle/0049_a_partial_day_says_so.sql`,
`drizzle/0050_the_fifth_axis_in_the_gate.sql`,
`test/ons-dessem-balance.test.ts`, `test/database-dessem.test.ts`.

---

## The answer, first

**29 of the 34 recovered; 5 stay refused for `coverage`. `fc18-pg` now holds 394
DESSEM reference days against 365 before, 74,176 rows against 70,080.**

| | before | after |
| --- | --- | --- |
| reference days ingested | 365 | **394** |
| rows in `dessem_balance_half_hour` | 70,080 | **74,176** |
| days refused — `coverage` | 34 | **5** |
| days refused — `forecast_integrity` | 70 | 70 |
| unsettled resource versions | 0 | **0** |

The five that stay refused are the five 25 identified: **2025-08-09** (42…48),
**2025-08-16** (1…13), **2025-08-27** (32…48), **2025-09-03** (45…48) and
**2026-01-09** (44…48). Every one is uniform across all four subsystems and none
of them reaches the midday window, so nothing in the file pins the period index.
Their reason is still `coverage` and the refusal now says why in those words:

> Reference day 2025-08-09 has 7 patamares in every subsystem; the local civil
> day is 48 half hours long. The patamares present are the contiguous suffix
> 42…48: a publication that starts partway through the day, not a shifted
> index. **A partial day is admissible only if it reaches the midday window
> (patamares 19…30), where the solar profile pins the num_patamar →
> wall-clock mapping absolutely. This run does not, so nothing in the file says
> what its own rows mean: the values are readable but the half hours they
> belong to would be a guess.**

---

## 1. 25's contiguity finding holds. Its uniformity finding does not, and the exception is a fragment

**Checked first, because the whole change rests on it.** Re-read from the
retained payloads rather than re-downloaded: **0 of the 34 has an interior
hole.** Every subsystem of every one is a contiguous prefix or suffix. A
truncation is what makes a short day readable at all — patamar *k* means the
same half hour whether the file stops at 46 or at 48 — and the counterexample
that would have overturned this ticket does not exist in the published history.

**What does not hold is "short in *every* subsystem by the same run".** 25
recorded the counts per day (naming subsystem `N`, the first key its map
iterated). Read per subsystem, **11 of the 34 are ragged by exactly one half
hour**:

| reference day | N, NE | S, SE | the day |
| --- | --- | --- | --- |
| 2025-07-19 | 1…26 | 1…27 | 1…26 |
| 2025-08-29 | 1…44 | 1…45 | 1…44 |
| 2025-09-10 | 1…37 | 1…38 | 1…37 |
| 2025-09-12 | 1…33 | 1…33 / SE 1…34 | 1…33 |
| 2025-10-17 | 1…26 | 1…27 | 1…26 |
| 2025-10-24 | 1…39 | 1…40 | 1…39 |
| 2025-11-26 | 1…42 | 1…43 | 1…42 |
| 2025-12-02 | 1…43 | 1…44 | 1…43 |
| 2025-12-26 | 1…36 | 1…37 | 1…36 |
| 2026-01-02 | 1…43 | 1…44 | 1…43 |
| 2026-01-19 | 1…44 | 1…45 | 1…44 |

The other 23 are uniform. Ragged by one, never by more, and always at the
truncated end.

**That extra row is not a forecast half hour.** Measured on all 21 of them,
against the previous half hour of the same subsystem:

| measure | ratio on the ragged row |
| --- | --- |
| `val_demanda` | 0.97 – 1.06 |
| `val_ger_hidraulica` | 0.96 – 1.14 |
| `val_ger_termica` | 1.00 – 1.01 |
| **`val_ger_pch`** | **0.00 – 0.16** |
| **`val_ger_pct`** | **0.00 – 0.29** |
| **`val_ger_eolica`** | **0.00 – 0.14** |

Every time, on eleven different days. Demand, hydro and thermal continue
smoothly; small hydro, small thermal and wind collapse. `val_ger_pch` cannot
fall 90% in thirty minutes while demand holds — those measures were never
filled in. ONS writes a half hour as four subsystem rows and the last half hour
of a truncated file is sometimes written for two of them and left unfinished.

So **the reference day is the run every subsystem carries**, and the ragged rows
are `rejected` with a new reason, `incomplete_patamar`, counted in
`rowsRejected` where a run summary shows them. Storing them was the alternative
and it is worse twice over: it would put a reference day in the table that is 26
half hours in two subsystems and 27 in the other two — a shape no day-level
column can state without lying to half the rows — and it would feed a fabricated
near-zero wind half hour to the one series this dataset exists for. 21 rows are
dropped across the whole history; each one is named.

## 2. The column

`dessem_balance_half_hour` gains two integers, and it is two rather than one
deliberately:

- `reference_day_patamares` — how many half hours ONS published for this row's
  reference day.
- `reference_day_half_hours` — how many the local civil day contains.

Complete is `reference_day_patamares = reference_day_half_hours`, and a check
constraint — `dessem_balance_reference_day_coverage`, `between 1 and
reference_day_half_hours` — makes the pair readable as "published of expected"
rather than as two unrelated numbers. A single `complete` boolean would have
been a derived fact with no way to check itself, and hard-coding 48 in the view
would have turned a future 46- or 50-hour day into a permanent shortfall.
Measured in this database rather than assumed: a DST-start day is 46 half hours
(2018-11-04) and a DST-end day is 50 (2019-02-16).

**The backfill is derived, not minted.** Every row already in the table was
written by an adapter that refused any day that was not the full civil length,
so the count is recoverable from the rows themselves — `count(distinct
valid_time)` per reference day and subsystem — and the day's length from the
zone. Measured before writing the migration: **1,460 reference-day × subsystem
groups, all 1,460 of them exactly 48.** The migration re-checks that and refuses
to continue if it does not hold, because a group that is short is either rows
lost after the fact or a day that should never have been stored, and silently
relabelling it "partial" would hide both.

**The shortfall is in the value digest, sparsely.** A day ONS publishes 46 short
and later publishes whole is a real restatement of those 46 half hours: if the
digest ignored coverage they would come back `unchanged`, keep saying "46 of 48"
forever, and be filtered out of the read while the two new half hours sailed
through — a two-row answer for a whole day, which is the exact quiet wrongness
the column exists to prevent. So the shortfall joins the tuple, but only when
there is one: a whole day appends nothing and its digest is byte-identical to
what the platform already stored, so admitting partial days restates **zero** of
the 70,080 rows already on record. Both halves are asserted, one without a
database and one against Postgres (46 rows `revised`, 8 `inserted`, and the
earlier as-of still answering the short day).

## 3. The read change, and what a reader that does not ask now gets

`canonical_day_ahead_balance` projects the pair and, **by default, answers whole
reference days only** — byte-for-byte what every reader got before this ticket.
Measured on `fc18-pg` after the recovery:

```
          read          | reference_days | rows  | partial_rows
 default (nobody asked) |            365 | 70080 |            0
 asked for partial days |            394 | 74176 |         4096
```

The ask is a fifth read axis, `wattsteer.partial_reference_days`, and the first
boolean one: unlike the two instant axes, where an absent value removes a cut,
an absent value here *applies* one. `canonical_partial_reference_days()` returns
false when the setting is missing or empty.

**Establishing what today's readers do came before choosing the default, and it
decided it.** Three read this view: the canonical contract read
(`readDayAheadBalance`), the ingest as-of read (`readDessemBalanceAsOf`), and —
the one that matters — the `feature_rows` SQL function, which computes
`dessem_residual_load_min_of_day` and `dessem_residual_load_rank_in_day` over
the whole day the view hands it. On a 21-patamar day those are a minimum and a
rank over ten hours wearing a day's name, and nothing in the answer would say
so. A default that quietly admitted partial days really would have been worse
than the refusal it replaces.

The predicate sits **inside** the `DISTINCT ON`, beside the gate and for the
same reason: dropping partial rows before the version pick means a day ONS first
published whole and later re-published short still answers with the whole
vintage, instead of answering with nothing because the newest version was
filtered out after being chosen.

Three places can ask, and one place is guaranteed never to:

- `readDessemBalanceAsOf({ includePartialReferenceDays: true })`.
- `ReadAxes.partialReferenceDays` in `contract/scope.ts`, written on every call
  like the other four.
- `feature_apply_gate`, `feature_apply_gate_for_fleet_offset`,
  `feature_apply_label_vintage` and `feature_release_axes` write the axis
  **empty** (0050), so a feature build answers on whole days whatever a caller
  asked for earlier in the same transaction. `features-gate.test.ts` holds that:
  its axis roster is five now, and the "writes every axis on every call" guard
  went red on all four functions before 0050 and green after.

The public canonical read surface is **not** extended to offer the opt-in —
`readDayAheadBalance` has no new parameter, and whether the contract should
carry one is api-surface's call, not this ticket's. `apps/ml`'s mirror is
untouched for the same reason and is safe untouched: a read that never sets the
axis can only ever get the whole-days answer.

## 4. What this changes for the forecaster, and what it does not

`dessem_balance_half_hour` feeds the DESSEM A/B, and forecaster 39 established
that **which folds are scoreable is a property of the database on the day**. 29
reference days that were absent are now present, so **the scoreable-fold set of
that A/B has changed as of this commit** — 2025-07-19, the day that killed
ticket 21's whole-history task, is among them, and 2025-08-07 (20 patamares) and
2026-03-03 (21) are the shortest days now on record.

It has **not** been re-run here, and a partial day does not reach a feature by
itself: `feature_apply_gate` writes the axis empty, so `feature_rows` still sees
only the 365 whole days. Whether a fold should be built on a 20-patamar day —
and what `dessem_residual_load_min_of_day` means when it is — is the
forecaster's decision, and the axis is the switch for making it. The honest
statement is that the data is now there and askable, not that the A/B improved.

## 5. Verification

- `bun run check` — typecheck, biome, and 274 hygiene + 1,293 no-database +
  1,747 with-Postgres tests. Full output in the commit's report.
- The database suites ran against a throwaway Postgres on port 5447, never
  `bun run test:db` — it hard-codes 5434 and truncates the ingestion tables that
  hold this history.
- The migration's backfill guard was proved to fail on drift: 12 half hours
  deleted from one stored day, the migration's own backfill and `DO` block run
  verbatim, and it refused — *"holds 180 rows whose reference day is not the
  full civil day"* — then rolled back. It passed on the real data, where all
  1,460 groups are 48.
- The coverage rule's empty input is asserted too: a file that names a reference
  day and has every row filtered at the subsystem boundary refuses with
  *"carries no subsystem rows"*, and a header-only file with *"covers 0
  reference days"*.
- The daylight assertion still applies to a partial day: a 46-patamar day with
  its midday photovoltaic zeroed is refused `time_axis`, which is the right name
  there because the profile is present and wrong.

## What this ticket does not do

- **It does not recover the 70 `forecast_integrity` days, and nothing can.** 60
  were never catalogued until after the day had passed and 10 were overwritten
  after publication; data-platform 25 §2 is unchanged. The honest statement of
  DESSEM's usable history is now **394 reference days of the 469 the catalogue
  offers**, of which 29 are partial.
- **It does not offer partial days on the public canonical read.** See §3.
- **It does not re-run the DESSEM A/B.** See §4.
- **It does not change `published_at` for anything.** No gate admits a row it
  could not see before; a partial day's rows carry the same file `Last-Modified`
  as any other.
