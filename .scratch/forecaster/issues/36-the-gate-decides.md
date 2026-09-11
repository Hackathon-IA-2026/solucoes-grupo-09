# 36 — The gate decides, and the calibration rails are no longer what refuses

**What happened.** Two artifacts were re-minted through the unmodified
`python -m wattsteer_ml.retrain` against a clone of the real ONS history, at the
same `as_of` the refused pair was minted at, and **the gate ran all seven checks
for the first time in this repository's history**. Checks 1–6 passed in both
lanes. **All twelve guardrails passed in both lanes** — including the two that
vetoed on 2026-09-10, and including them without a threshold moving.

**And the gate still refuses both lanes, on check 7.** The serving smoke finds
tomorrow's feature vector complete in shape — 96 rows, 24 per subsystem, zero
faults — and **entirely NULL in fifteen weather columns** (twenty-one in
`gate_late`, which also loses the six programmed-load features). The database
this was run against holds no weather forecast and no programmed load for the
serving day. That is a refusal about the *inputs*, not about the fit and not
about a bound.

**Nothing promoted. The api-surface 10 end-to-end was not run**, because the
condition it is gated on — a promotion the gate agreed to — did not occur, and
the previous pass already established that forcing one is the wrong answer.

Everything below is measured. Where a figure is arithmetic over a measurement
it says so.

---

## What was measured, and on what

**A clone, and the live database was read once.** `fc18-pg` on 5434 has a
weather ingestion actively writing to it, so it was **read for the dump and for
two `max(valid_time)` selects, and never written, migrated or tested against**.
`bun run ml:test:db` and `bun run test:db` were **never invoked**; they hard-code
5434 and truncate the ingestion tables.

    docker run -d --name fc36-pg -e POSTGRES_PASSWORD=wattsteer -p 5447:5432 postgres:17-alpine
    docker exec fc36-pg psql -U postgres -c 'CREATE DATABASE wattsteer'
    docker exec fc18-pg pg_dump -U postgres --no-owner --no-acl wattsteer \
      | docker exec -i fc36-pg psql -q -U postgres -d wattsteer

Restore exit 0, **zero bytes on stderr, zero `ERROR` lines**. The dump arrived
at **43** drizzle migrations; `bun run db:migrate` against 5447 took it to
**48**, and `ANALYZE` was run before anything read it. The container was
`docker rm -f`'d when this ticket was written.

What the clone holds, counted on 5447 after the restore:

| | |
|---|---|
| `curtailment_report_hour` | **4,765,728** rows, 2024-04-01 → 2026-09-09 |
| `weather_forecast_hour` | **1,355,785** rows, latest `valid_time` **2026-09-02 15:00Z** |
| `programmed_load_half_hour` | latest `valid_time` **2026-09-09 02:30Z** |
| `dessem_balance_half_hour` | latest `valid_time` **2026-09-10 02:30Z** |
| drizzle migrations | 48 |

Weather is 1.36 M rows against the 673,153 api-surface 10 measured and the
1.36 M forecaster 34's dump did not have; that lane's quota-bound backfill has
kept running. **It is a backfill of past valid times, not a forecast forward** —
which is the whole of check 7's finding, below.

### The retrain, through the existing driver

    python -m wattsteer_ml.retrain --run-id 2026-09-10T12:00:00Z --root … \
      --database-url postgres://…@localhost:5447/wattsteer

The module unmodified, no shortcut around `train_fold` or `save_artifact`, no
hand-edit of an artifact, a card or the promotion log. **747.899 s** wall clock
for both lanes and **1,788.3 MB** peak RSS, as the run's own `Resources` block
measured them (359.374 s / 1,643.8 MB for `gate_early`, 388.405 s / 1,788.3 MB
for `gate_late`). Exit 0; two lanes reached a decision.

`--run-id 2026-09-10T12:00:00Z` is **the same instant the refused pair was
minted at**, deliberately. It fixes `as_of`, the fold calendar and the serving
day, so this run is the previous one with two defects fixed and nothing else
changed. **No second `as_of` was tried.** Two previous passes refused to shop
for a window that passes and said so; this one did not shop either, and the
refusal below is a reason to say so again rather than a reason to look
elsewhere.

The fold is the same fold, and the contract is the same contract:

| | |
|---|---|
| deciding fold | **F6**, `sha256:77ad81fc…`, 2026-07-01 → 2026-09-09, 71 days |
| base fit | 2024-04-01 → 2026-04-01, **70,176** rows, 22,511 positive |
| calibration | 2026-04-02 → 2026-06-30, **8,640** rows, **3,148** positive |
| test | **6,816** rows; **3,201** curtailed hours scored |
| live `feature_hash` | `sha256:f755511b3be1bc55a48c6573e3fc06950c579fd9d861e125accc5fb61daaebf5` |
| admitted inputs | **66 of 78** at `gate_early` (12 withheld, `publication_lag`); **78 of 78** at `gate_late` |
| background | `artifact`, 128 rows × 96 cells, seed 20260830, 9,830,400 bytes |
| bundles | 4,023,545 B (`gate_early`), 5,622,988 B (`gate_late`) |

The feature hash is the one api-surface 10 and forecaster 33/34 all recorded, so
this is the same contract the refused artifacts were fitted against.

---

## What the gate read, rail by rail, in both lanes

Straight off `promotions.jsonl`. Check 7's column is the only `false` in it.

| check | `gate_early` | `gate_late` |
|---|---|---|
| 1 `lane_identity` | pass — no incumbent, cold start | pass |
| 2 `estimator_allow_list` | pass — `lightgbm` | pass |
| 3 `feature_contract` | pass — `sha256:f755511b…` both sides | pass |
| 4 `freshness_and_coverage` | pass — trained to 2026-09-09 (1 d), 71 test days ≥ 60 | pass |
| 5 `paired_block_bootstrap` | pass | pass |
| 6 `guardrails` | **pass — all 12** | **pass — all 12** |
| 7 `serving_smoke` | **FAIL** | **FAIL** |

### Check 5, the bootstrap

2,000 resamples of 70 whole target days, 6,720 hours, seed 20260913, comparator
`same_hour_7d` (cold start — there is no incumbent in either lane):

| | `gate_early` | `gate_late` |
|---|---|---|
| candidate qloss | **322.36 MWh** | **324.66 MWh** |
| comparator qloss | 479.93 MWh | 480.96 MWh |
| `P(candidate better)` | **1.000** | **1.000** |
| ties | 0 | 0 |
| promotion probability required | 0.90 | 0.90 |

A third better than the rung it had to beat, in both lanes, exactly as the
refused pair was.

### Check 6, every guardrail

| rail | `gate_early` | `gate_late` | bound |
|---|---|---|---|
| `pr_auc[pooled]` | 0.9514 (vs 0.9387) — pass | 0.9544 (vs 0.9376) — pass | ≥ comparator − 0.02 |
| `pr_auc[N]` | 0.9111 (vs 0.8893) — pass | 0.9199 (vs 0.8893) — pass | ≥ comparator − 0.02 |
| `pr_auc[NE]` | 0.9698 (vs 0.9614) — pass | 0.9724 (vs 0.9594) — pass | ≥ comparator − 0.02 |
| `pr_auc[SE]` | 0.9626 (vs 0.9390) — pass | 0.9714 (vs 0.9390) — pass | ≥ comparator − 0.02 |
| `pr_auc[S]` | 0.8861 (vs 0.8569) — pass | 0.8851 (vs 0.8569) — pass | ≥ comparator − 0.02 |
| `recall@0.5[pooled]` | 0.9188 (vs 0.9194) — pass | 0.9172 (vs 0.9188) — pass | ≥ comparator − 0.05 |
| **`coverage_p10_in_band`** | **0.9077** over **1,581 of 3,201** — **pass** | **0.9005** over **1,508 of 3,201** — **pass** | in [0.85, 0.97] over ≥ 98 rows |
| `coverage_p90` | 0.9185 — pass | 0.9182 — pass | in [0.85, 0.97] |
| **`p50_unbiasedness`** | **0.4536** — **pass** | **0.4599** — **pass** | in [0.45, 0.55] |
| `ece` | 0.0432 — pass | 0.0435 — pass | ≤ 0.05 |
| `crossing_rate` | 0.000149 — pass | 0.0000 — pass | ≤ 0.01 |
| `floor_coverage` | not applicable — no incumbent | not applicable | ≥ incumbent − 0.05 |

**Both of 2026-09-10's vetoes are gone, and no threshold moved.**
`COVERAGE_GUARDRAIL = (0.85, 0.97)` and `P50_UNBIASEDNESS_WINDOW = (0.45, 0.55)`
are byte-for-byte what forecaster 33 found them. What moved is the band and the
statistic:

| | before (2026-09-10) | now | what changed |
|---|---|---|---|
| the lower rail | `coverage_p10` 0.9753 / 0.9884 — **veto** | `coverage_p10_in_band` 0.9077 / 0.9005 — pass | forecaster 34's population **and** forecaster 35's `δ_lo` |
| `p50_unbiasedness` | 0.4439 / 0.4464 — **veto** | 0.4536 / 0.4599 — pass | the fit, on a window with more weather in it |

`p50_unbiasedness` deserves its own sentence, because it is the one forecaster
33 told the next pass not to touch. **It was not touched.** It cleared on its
own, by 0.0036 and 0.0099 against the same 0.45 floor — which is well inside the
day-block standard error of 0.021 that 33 measured, so this is a statistic that
landed on the other side of the edge, exactly as 33 said it would in roughly two
runs in five. **A pass here is not evidence the rail is sound**, and 33's second
recommendation — that the floor has almost no headroom against a
right-by-construction model — is untouched and still stands.

### The lower tail, and forecaster 35's prediction coming true

| | `gate_early` | `gate_late` |
|---|---|---|
| `δ_lo` | **+148.39** | **+148.86** |
| `δ_hi` | 459.41 | 444.63 |
| `conformal_method` | `one_sided_split_cqr_stated_lower` | same |
| `conformal_calibration_rows` / `rank` | 3,148 / 2,835 | 3,148 / 2,835 |
| `conformal_lower_calibration_rows` / `lower_rank` | **1,304 / 1,175** | **1,171 / 1,055** |
| `conformal_lower_tail_fitted` | True | True |
| marginal `coverage_p10` | 0.9544 | 0.9531 |
| `coverage_p10_where_stated` | **0.9109** over 1,638 rows | **0.9024** over 1,537 rows |
| `coverage_p90_where_stated` | 0.9272 over 3,171 | 0.9222 over 3,187 |
| `upper_correction_realised` | 0.9906 | 0.9956 |

Three things in that table are the two fixed defects showing up on real data
rather than on a fixture.

1. **`δ_lo` changed sign.** It was **−37.0** in both lanes — a *narrowing* of
   the band, ranked over rows the shift cannot move. It is now **+148**, a
   widening of ~148 MWh, ranked over the 1,304 and 1,171 rows whose P10 is a
   positive number. Forecaster 35 measured this on synthetic windows and said
   the real direction would be the data's to choose; on this history it chose
   *wider*, which is the safe direction and was not the direction 35's regime 2
   predicted from 33's figures.
2. **`coverage_p10_where_stated` landed on nominal.** 0.9109 and 0.9024 against
   a 0.90 target, from 0.9433 and 0.9734 on the refused pair. That is forecaster
   35's acceptance criterion — "the 90% has to be a statement about the rows
   where the floor says something" — met on real ONS history for the first time,
   and it is what carries the corrected rail inside its window.
3. **The τ-floor atom now binds, and forecaster 34 said it would.** The
   corrected rail counts 1,581 and 1,508 qualifying rows against the card's
   1,638 and 1,537 stated rows: **57 and 29 rows** have a served P10 that is
   positive but at or below `τ⁺`. On the refused pair that count was **0 of
   3,201** in both lanes, and forecaster 34 excluded the atom "on principle, not
   on frequency … 'it did not happen on this fold' is not a reason to leave the
   door open on the next one." A widening `δ_lo` is exactly the mechanism
   forecaster 35 named for it, and the door it was refused through is the one
   those 86 rows walked into on the very next fold. **Both tickets are
   vindicated by a measurement neither of them could take.**

---

## Check 7: the fit is not what refuses

`serving_smoke` builds tomorrow's real feature vector — the run's `as_of` is
2026-09-10T12:00Z, so the serving day is **2026-09-11** — and compares each
feature's NULL rate on it against the same feature's NULL rate in training,
against a **5%** drift ceiling.

**The vector is there and it is the right shape.** 96 rows, **24 hours in each
of N, NE, SE and S**, and `faults: []` — no missing subsystem, no short day, no
structural fault of any kind. What it does not have is values:

| lane | features over the ceiling | serving NULL rate | training NULL rate |
|---|---|---|---|
| `gate_early` | **15**, all `weather_*` | **1.000** | 0.4641 – 0.4654 |
| `gate_late` | **21** — the same 15, plus 5 `programmed_load_*` and `observed_constrained_off_lag_48h` | **1.000** | 0.0006 – 0.8337 |

The largest excesses are the programmed-load ones in `gate_late`:
`programmed_load_mwh`, `programmed_load_daily_min_mwh` and
`programmed_load_rank_in_day` are NULL in **0.06%** of training rows and
**100%** of serving rows — an excess of 0.9994.

**Why, in one line each, off the database rather than off the message.** Counted
on 5447:

- `weather_forecast_hour` has **0 rows** with `valid_time` in 2026-09-11, and
  its **maximum `valid_time` is 2026-09-02 15:00Z** — eight days *before* the
  serving day, and before `as_of`. The weather table is being backfilled through
  past valid times, not run forward to produce a forecast.
- `programmed_load_half_hour` has **0 rows** in 2026-09-11 and a maximum
  `valid_time` of **2026-09-09 02:30Z**.

**And this is not an artefact of the clone's instant.** The live `fc18-pg` was
read (two `max(valid_time)` selects, no write) twenty minutes after the dump:
weather had advanced to **2026-09-10 11:00Z** and programmed load had not moved
from **2026-09-09 02:30Z**. Neither reaches 2026-09-11. A fresher clone would
change the training window slightly and would not give the serving day a single
weather row, because there are none to give.

So check 7 is right, and it is saying something true: **on this database, the
model cannot produce tomorrow's forecast**, whatever its calibration looks like
on the fold behind it. That is a data-platform state — the weather ingestion has
not yet run forward of now, and DESSEM's programmed load stops two days back —
and it is the first thing in this lane's history that has ever been in a
position to be said, because every previous run stopped at check 6.

**No attempt was made to get around it.** Not by moving the ceiling, not by
re-running at an `as_of` whose serving day happens to have weather, not by
hand-editing a vector, and not by a promote line. Each of those is available and
each of them would turn a true refusal into a false green.

---

## What did not happen, and why

**Nothing promoted, so api-surface 10's last box stays open.** The end-to-end —
real Postgres, real `apps/ml`, `WATTSTEER_TEST_ML_URL` + `WATTSTEER_TEST_DATABASE_URL`,
`POST /internal/publish/forecast` and `POST /internal/publish/diagnosis` — was
**not run**. It is gated on a gate-agreed promotion and there is not one. The
previous pass measured that chain behind a hand-written promote line, reported
every number, and left the box open rather than tick it; ticking it here on a
second forced promotion would be worse, not better, because the first one
already established exactly what the measurement is worth.

**What now stands between here and a promoted artifact** is one sentence, and
for the first time it is not about the model:

> the serving day needs weather forecast rows and programmed-load rows in the
> database the retrain reads.

Everything else the gate asks for is satisfied. Concretely, a promotion in
`gate_early` needs `weather_forecast_hour` populated for the serving day (15
features, currently 100% NULL); `gate_late` needs that **and**
`programmed_load_half_hour` for the serving day (6 more). Neither is a
forecaster-lane change and neither is a threshold.

---

**Status:** decided, nothing promoted, no threshold moved

- [x] Both lanes re-minted through the unmodified
      `python -m wattsteer_ml.retrain` at the same `as_of` as the refused pair,
      on a clone of the real history at 48 migrations — 747.899 s, 1,788.3 MB
      peak RSS, two artifacts, two cards, two decision lines
- [x] The gate ran **all seven checks** for the first time in this
      repository's history: checks 1–6 passed in both lanes, and check 7 was
      reached rather than skipped
- [x] **All twelve guardrails passed in both lanes**, with
      `COVERAGE_GUARDRAIL` and `P50_UNBIASEDNESS_WINDOW` byte-for-byte
      unchanged — `coverage_p10_in_band` 0.9077 / 0.9005 over 1,581 / 1,508
      qualifying rows, `p50_unbiasedness` 0.4536 / 0.4599
- [x] The bootstrap is reported whole: `P(candidate better) = 1.000` over 2,000
      resamples of 70 whole days, qloss 322.36 / 324.66 against the
      `same_hour_7d` baseline's 479.93 / 480.96, 0 ties
- [x] Forecaster 35's change is measured on a real fit for the first time:
      `δ_lo` **−37.0 → +148.39 / +148.86**, ranked over 1,304 / 1,171 stated
      rows, and `coverage_p10_where_stated` **0.9433 / 0.9734 → 0.9109 /
      0.9024** against its 0.90 target. That closes the box forecaster 35 left
      open on its own ticket
- [x] Forecaster 34's τ-floor exclusion is vindicated by a measurement: the
      clamp bound on **0 of 3,201** rows at a narrowing `δ_lo` and binds on
      **57 and 29** at a widening one
- [x] **The gate refuses both lanes on `serving_smoke`**, and the cause is
      counted off the database rather than read off the message: 0 weather
      rows and 0 programmed-load rows for the serving day 2026-09-11, with the
      live database's own maxima (2026-09-10 11:00Z and 2026-09-09 02:30Z)
      confirming it is not the clone's staleness
- [x] `bun run ml:test` and `bun run check` run and reported below
- [ ] **Nothing promoted, so api-surface 10's end-to-end box stays open.** It
      is not a decision and not a threshold: the serving day needs weather and
      programmed-load rows in the database the retrain reads. This box stays
      open until a gate-agreed promotion exists

---

## Verification

| Suite | Result |
|---|---|
| `bun run ml:test` | **1,784 pass · 93 skip · 0 fail**, 101.90 s, exit 0 — unchanged, since no source file moved |
| `bun run check` | **exit 0** — typecheck clean, `bunx biome check` checked 539 files with no fixes, 255 hygiene · 471 core · 1,282 api (583 skip) · 189 web pass, **0 fail** |
| `python -m wattsteer_ml.retrain`, both lanes, real history | 747.899 s, 1,788.3 MB peak RSS, 2 artifacts, 2 `refuse` lines, `promoted: []`, exit 0 |
| the clone against the dump | restore exit 0, zero stderr bytes, zero `ERROR` lines, `curtailment_report_hour` 4,765,728 |
| the candidate `feature_hash` | `sha256:f755511b…`, identical to the one the refused pair recorded |

Baseline for `ml:test` before this pass was 1,768 (forecaster 35's run); the
sixteen additional items are siblings' and not this ticket's — **this ticket
changed no source file.**

Every figure above has its denominator printed beside it. The two that are zero
are the finding: **0 weather rows and 0 programmed-load rows for 2026-09-11.**

## What was deliberately not done

- **No threshold was moved.** `COVERAGE_GUARDRAIL = (0.85, 0.97)`,
  `P50_UNBIASEDNESS_WINDOW = (0.45, 0.55)` and the serving smoke's 5% NULL-rate
  drift ceiling are all byte-for-byte what they were. `p50_unbiasedness` passing
  by 0.0036 is not a licence to relax it and not evidence it is sound; 33's
  finding that it has almost no headroom is untouched.
- **No second `as_of`.** One run, at the instant the refused pair was minted at.
  Re-asking the gate until a serving day turns up with weather in it is shopping
  for a promotion, and two previous passes refused to do it.
- **No forced promotion, and therefore no end-to-end.** api-surface 10's last
  box is left open with its reason narrowed rather than ticked on a promote line
  written by hand.
- **No artifact, card or promotion log was hand-edited**, and none of them is in
  this commit: they live in this session's scratch directory.
- **No source file changed.** Nothing under `apps/ml/src` needed a change to
  run, which is what forecaster 34 and 35 predicted.
- **`bun run ml:test:db` and `bun run test:db` were never invoked**, and
  `fc18-pg` was read for one dump and two `max(valid_time)` selects and never
  written, migrated or tested against. The clone `fc36-pg` on 5447 was removed.
- **Nothing under `test/`, `apps/api/src/ingest/`, `docs/specs/` or `drizzle/`
  was touched** — three lanes were running against this tree.
- **The weather gap was not filled.** Running an ingestion forward to give the
  serving day its weather is data-platform's work on a database this pass does
  not own, and doing it here to reach a promotion would be the same forced green
  by a longer route.
